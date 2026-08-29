package ws

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// B2-5 parity tables for the ws call sites that decide a security property:
// each site is run against the canonical permissions predicate over the same
// fixture, in both the PermissionService-wired and the bare-hub branch, so
// the two resolution paths and the rule can never disagree (S-12).

// parityOverrideCases are the override layers every ws parity table walks:
// each one flips a bit the predicates consult.
var parityOverrideCases = []struct {
	name        string
	allow, deny int64 // role layer
	uAllow      int64 // user layer
	uDeny       int64
}{
	{"no override", 0, 0, 0, 0},
	{"role deny SEND", 0, permissions.SendMessages, 0, 0},
	{"role deny READ", 0, permissions.ReadMessages, 0, 0},
	{"role deny CONNECT", 0, permissions.ConnectVoice, 0, 0},
	{"role deny MUTE", 0, permissions.MuteMembers, 0, 0},
	{"role allow MANAGE", permissions.ManageMessages, 0, 0, 0},
	{"user deny SEND", 0, 0, 0, permissions.SendMessages},
	{"user deny READ", 0, 0, 0, permissions.ReadMessages},
	{"user deny MUTE", 0, 0, 0, permissions.MuteMembers},
	{"user allow MANAGE", 0, 0, permissions.ManageMessages, 0},
	{"user allow beats role deny", 0, permissions.SendMessages, permissions.SendMessages, 0},
}

// setParityOverrides installs one case's layers for (role, user) on the
// channel and drops the permission cache so the service branch re-reads.
func setParityOverrides(t *testing.T, database *db.DB, permSvc *service.PermissionService, chID, roleID, userID int64, c struct {
	name        string
	allow, deny int64
	uAllow      int64
	uDeny       int64
},
) {
	t.Helper()
	ctx := context.Background()
	if err := database.UpsertChannelOverride(ctx, chID, roleID, c.allow, c.deny); err != nil {
		t.Fatalf("%s: UpsertChannelOverride: %v", c.name, err)
	}
	if err := database.UpsertChannelUserOverride(ctx, chID, userID, c.uAllow, c.uDeny); err != nil {
		t.Fatalf("%s: UpsertChannelUserOverride: %v", c.name, err)
	}
	permSvc.InvalidateAll()
}

// paritySubject resolves the subject the way the test wants it, straight from
// the Checker, so the site under test is compared against an independent
// resolution rather than its own.
func paritySubject(t *testing.T, database *db.DB, userID int64, ch *db.Channel) permissions.Subject {
	t.Helper()
	ctx := context.Background()
	role, err := database.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		t.Fatalf("GetRoleForUser(%d): %v", userID, err)
	}
	sub, err := permissions.NewChecker(database).Subject(ctx, role.Permissions, role.ID, userID, ch.ID)
	if err != nil {
		t.Fatalf("Checker.Subject: %v", err)
	}
	sub.Channel = channelRef(ch)
	return sub
}

// TestRefreshChannelVisibilityCanSend_Parity: the composer refresh verdict is
// CanSendMessage in both branches, for text and announcement channels.
func TestRefreshChannelVisibilityCanSend_Parity(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "refresh-parity-user")
	textID := mustCreateVoiceChannel(t, database, "refresh-parity-text")
	if _, err := database.ExecContext(ctx, `UPDATE channels SET type = 'text' WHERE id = ?`, textID); err != nil {
		t.Fatalf("retype: %v", err)
	}
	newsID := mustCreateVoiceChannel(t, database, "refresh-parity-news")
	if _, err := database.ExecContext(ctx, `UPDATE channels SET type = 'announcement' WHERE id = ?`, newsID); err != nil {
		t.Fatalf("retype: %v", err)
	}

	h := NewHub(database, auth.NewRateLimiter(), nil)
	permSvc := service.NewPermissionService(database, h.permChecker)

	for _, chID := range []int64{textID, newsID} {
		ch, err := database.GetChannel(ctx, chID)
		if err != nil || ch == nil {
			t.Fatalf("GetChannel(%d): %v", chID, err)
		}
		for _, c := range parityOverrideCases {
			setParityOverrides(t, database, permSvc, chID, harvestVoiceRoleID, uid, c)
			want := permissions.CanSendMessage(paritySubject(t, database, uid, ch)) == nil

			h.perms = nil
			if got := h.refreshChannelVisibilityCanSend(ctx, ch, uid); got != want {
				t.Errorf("%s/%s bare hub: refreshChannelVisibilityCanSend = %v, CanSendMessage = %v", ch.Type, c.name, got, want)
			}
			h.perms = permSvc
			if got := h.refreshChannelVisibilityCanSend(ctx, ch, uid); got != want {
				t.Errorf("%s/%s service: refreshChannelVisibilityCanSend = %v, CanSendMessage = %v", ch.Type, c.name, got, want)
			}
		}
	}
}
