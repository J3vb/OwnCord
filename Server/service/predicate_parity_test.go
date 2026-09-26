package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// B2-5 parity tables: every service call site that decides a security
// property is run against the canonical permissions predicate over the same
// fixture, so the two can never disagree. The fixture covers each input the
// predicates consult — role bits, both override layers, channel type and
// archive flag, DM membership and blocks.

const (
	parityRoleMember = int64(20) // READ|SEND
	parityRoleReader = int64(21) // READ only
	parityRoleMod    = int64(22) // READ|SEND|MANAGE_MESSAGES
	parityRoleAdmin  = int64(23) // ADMINISTRATOR only

	parityUserMember = int64(1)
	parityUserReader = int64(2)
	parityUserMod    = int64(3)
	parityUserAdmin  = int64(4)
	parityUserBob    = int64(5) // member; DM partner
	parityUserEve    = int64(6) // member; blocked by Bob

	parityChanText         = int64(10)
	parityChanAnnouncement = int64(11)
	parityChanArchived     = int64(12)
	parityChanRoleDeny     = int64(13) // role override denies SEND to member role
	parityChanUserDeny     = int64(14) // per-user override denies READ to the member user
	parityChanUserAllow    = int64(15) // per-user override grants MANAGE_MESSAGES to the member user; announcement
	parityChanDM           = int64(50) // member <-> bob
	parityChanDMBlocked    = int64(51) // eve <-> bob, bob blocks eve
	parityChanMissing      = int64(999)
)

var parityUsers = []int64{parityUserMember, parityUserReader, parityUserMod, parityUserAdmin, parityUserBob, parityUserEve}

var parityChannels = []int64{
	parityChanText, parityChanAnnouncement, parityChanArchived, parityChanRoleDeny,
	parityChanUserDeny, parityChanUserAllow, parityChanDM, parityChanDMBlocked, parityChanMissing,
}

func newParityDB(t *testing.T) *db.DB {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: parityRoleMember, Name: "p-member", Permissions: permissions.ReadMessages | permissions.SendMessages, Position: 1})
	seedRole(t, database, &db.Role{ID: parityRoleReader, Name: "p-reader", Permissions: permissions.ReadMessages, Position: 1})
	seedRole(t, database, &db.Role{ID: parityRoleMod, Name: "p-mod", Permissions: permissions.ReadMessages | permissions.SendMessages | permissions.ManageMessages, Position: 2})
	seedRole(t, database, &db.Role{ID: parityRoleAdmin, Name: "p-admin", Permissions: permissions.Administrator, Position: 3})
	for uid, rid := range map[int64]int64{
		parityUserMember: parityRoleMember, parityUserReader: parityRoleReader, parityUserMod: parityRoleMod,
		parityUserAdmin: parityRoleAdmin, parityUserBob: parityRoleMember, parityUserEve: parityRoleMember,
	} {
		seedUser(t, database, &db.User{ID: uid, Username: seedUsername(uid)})
		seedUserRole(t, database, uid, rid)
	}
	seedChannel(t, database, &db.Channel{ID: parityChanText, Name: "text", Type: "text"})
	seedChannel(t, database, &db.Channel{ID: parityChanAnnouncement, Name: "news", Type: "announcement"})
	seedChannel(t, database, &db.Channel{ID: parityChanArchived, Name: "old", Type: "text"})
	if _, err := database.ExecContext(context.Background(), `UPDATE channels SET archived = 1 WHERE id = ?`, parityChanArchived); err != nil {
		t.Fatalf("archive: %v", err)
	}
	seedChannel(t, database, &db.Channel{ID: parityChanRoleDeny, Name: "role-deny", Type: "text"})
	seedChannelOverride(t, database, parityRoleMember, parityChanRoleDeny, 0, permissions.SendMessages)
	seedChannel(t, database, &db.Channel{ID: parityChanUserDeny, Name: "user-deny", Type: "text"})
	seedChannelUserOverride(t, database, parityUserMember, parityChanUserDeny, 0, permissions.ReadMessages)
	seedChannel(t, database, &db.Channel{ID: parityChanUserAllow, Name: "user-allow", Type: "announcement"})
	seedChannelUserOverride(t, database, parityUserMember, parityChanUserAllow, permissions.ManageMessages, 0)
	seedChannel(t, database, &db.Channel{ID: parityChanDM, Name: "dm", Type: "dm"})
	seedDMParticipant(t, database, parityChanDM, parityUserMember)
	seedDMParticipant(t, database, parityChanDM, parityUserBob)
	seedChannel(t, database, &db.Channel{ID: parityChanDMBlocked, Name: "dm-blocked", Type: "dm"})
	seedDMParticipant(t, database, parityChanDMBlocked, parityUserEve)
	seedDMParticipant(t, database, parityChanDMBlocked, parityUserBob)
	seedBlock(t, database, parityUserBob, parityUserEve)
	return database
}

// parityWant is the canonical verdict for (user, channel) from the predicate
// over a Subject the test resolves itself — independently of the call site.
func parityWant(t *testing.T, database *db.DB, perms *PermissionService, pred func(permissions.Subject) error, userID, channelID int64) (allowed bool, verdict error) {
	t.Helper()
	ch, err := database.GetChannel(context.Background(), channelID)
	if err != nil {
		t.Fatalf("GetChannel(%d): %v", channelID, err)
	}
	if ch == nil {
		return false, ErrNotFound
	}
	sub, err := channelSubject(context.Background(), database, perms, userID, ch, true)
	if err != nil {
		t.Fatalf("channelSubject(%d,%d): %v", userID, channelID, err)
	}
	verdict = pred(sub)
	return verdict == nil, verdict
}

// TestSendPolicyParity: CanPost (the send path) and HandleTyping (S-01) agree
// with CanSendMessage for every (user, channel) in the fixture, including the
// kind of refusal.
func TestSendPolicyParity(t *testing.T) {
	database := newParityDB(t)
	perms := NewPermissionService(database, permissions.NewChecker(database))
	msgSvc := NewMessageService(database, perms, nil)
	chSvc := NewChannelService(database, perms)
	ctx := context.Background()

	for _, uid := range parityUsers {
		for _, cid := range parityChannels {
			wantOK, want := parityWant(t, database, perms, permissions.CanSendMessage, uid, cid)

			got := msgSvc.CanPost(ctx, uid, cid)
			if (got == nil) != wantOK {
				t.Errorf("CanPost(user=%d, chan=%d) = %v, predicate says %v", uid, cid, got, want)
			}
			switch {
			case errors.Is(want, permissions.ErrBlocked) && !errors.Is(got, ErrBlocked):
				t.Errorf("CanPost(user=%d, chan=%d) = %v, want ErrBlocked", uid, cid, got)
			case errors.Is(want, ErrNotFound) && !errors.Is(got, ErrNotFound):
				t.Errorf("CanPost(user=%d, chan=%d) = %v, want ErrNotFound", uid, cid, got)
			case want != nil && !errors.Is(want, permissions.ErrBlocked) && !errors.Is(want, ErrNotFound) && !errors.Is(got, ErrForbidden):
				t.Errorf("CanPost(user=%d, chan=%d) = %v, want ErrForbidden", uid, cid, got)
			}

			ch, err := chSvc.HandleTyping(ctx, uid, cid, nil)
			if err != nil {
				t.Errorf("HandleTyping(user=%d, chan=%d) errored: %v", uid, cid, err)
			}
			if (ch != nil) != wantOK {
				t.Errorf("HandleTyping(user=%d, chan=%d) emits=%v, but CanSendMessage says %v (S-01: typing must follow the send policy)", uid, cid, ch != nil, want)
			}
		}
	}
}

// TestViewPolicyParity: HandleChannelFocus (session admission: channel_focus
// and mark_read) agrees with CanAdmitSession for every (user, channel).
func TestViewPolicyParity(t *testing.T) {
	database := newParityDB(t)
	perms := NewPermissionService(database, permissions.NewChecker(database))
	chSvc := NewChannelService(database, perms)
	ctx := context.Background()

	for _, uid := range parityUsers {
		for _, cid := range parityChannels {
			wantOK, want := parityWant(t, database, perms, permissions.CanAdmitSession, uid, cid)

			_, got := chSvc.HandleChannelFocus(ctx, uid, cid)
			if (got == nil) != wantOK {
				t.Errorf("HandleChannelFocus(user=%d, chan=%d) = %v, predicate says %v", uid, cid, got, want)
			}
			switch {
			case errors.Is(want, ErrNotFound) && !errors.Is(got, ErrNotFound):
				t.Errorf("HandleChannelFocus(user=%d, chan=%d) = %v, want ErrNotFound", uid, cid, got)
			case want != nil && !errors.Is(want, ErrNotFound) && !errors.Is(got, ErrForbidden):
				t.Errorf("HandleChannelFocus(user=%d, chan=%d) = %v, want ErrForbidden", uid, cid, got)
			}
		}
	}
}
