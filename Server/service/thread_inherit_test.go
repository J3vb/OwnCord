package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// seedThread inserts a thread under parentID, as migration 074 shapes one.
func seedThread(t *testing.T, database *db.DB, id, parentID int64) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channels (id, name, type, parent_channel_id) VALUES (?, 'thread', 'thread', ?)`,
		id, parentID); err != nil {
		t.Fatalf("seedThread(%d under %d): %v", id, parentID, err)
	}
}

// The override fixture's role reads #open (10) and is denied #locked (11).
// A thread's verdict must be its parent's for every override layer.
func TestThreadPermissionsAreParents(t *testing.T) {
	_, permSvc, database := newOverrideFixture(t)
	ctx := context.Background()
	seedThread(t, database, 20, 11)
	seedThread(t, database, 21, 10)

	if !permSvc.HasChannelPerm(ctx, 1, 21, permissions.ReadMessages) {
		t.Error("a thread of a readable parent is unreadable")
	}
	if permSvc.HasChannelPerm(ctx, 1, 20, permissions.ReadMessages) {
		t.Error("a thread of a role-denied parent is readable")
	}
	if ok, err := permSvc.HasChannelPermChecked(ctx, 1, 20, permissions.ReadMessages); err != nil || ok {
		t.Errorf("HasChannelPermChecked(thread of denied parent) = %v, %v", ok, err)
	}

	// The per-user layer on the parent reaches the thread too.
	seedChannelUserOverride(t, database, 1, 11, permissions.ReadMessages, 0)
	seedChannelUserOverride(t, database, 2, 10, 0, permissions.ReadMessages)
	permSvc.InvalidateAll()
	if !permSvc.HasChannelPerm(ctx, 1, 20, permissions.ReadMessages) {
		t.Error("alice's user grant on the parent does not reach its thread")
	}
	if permSvc.HasChannelPerm(ctx, 2, 21, permissions.ReadMessages) {
		t.Error("bob's user deny on the parent does not reach its thread")
	}
	sub, err := permSvc.Subject(ctx, 2, 21)
	if err != nil || permissions.CanViewChannel(sub) == nil {
		t.Errorf("Subject(bob, thread) = %+v, %v, want the parent's deny", sub, err)
	}

	// The live Checker reads the same answer from the store.
	ck := permissions.NewChecker(database)
	held, err := database.GetMemberRoles(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if ck.HasChannelPerm(ctx, held.Held(), 2, 21, permissions.ReadMessages) {
		t.Error("Checker: bob's user deny on the parent does not reach its thread")
	}
}

// A thread created after a member's permissions were cached must still get
// its parent's answer, not the role's base bits: the cached override map has
// no entry for it, and nothing invalidates the cache when a thread is born.
func TestThreadCreatedAfterCacheFillIsParents(t *testing.T) {
	_, permSvc, database := newOverrideFixture(t)
	ctx := context.Background()
	if !permSvc.HasChannelPerm(ctx, 1, 10, permissions.ReadMessages) {
		t.Fatal("warm-up read failed")
	}
	seedThread(t, database, 22, 11)
	if permSvc.HasChannelPerm(ctx, 1, 22, permissions.ReadMessages) {
		t.Error("a new thread of a denied parent is readable from a warm cache")
	}
}

// channelLookupFailStore fails every channel read, so the authority lookup
// cannot answer.
type channelLookupFailStore struct{ *db.DB }

func (channelLookupFailStore) GetChannel(context.Context, int64) (*db.Channel, error) {
	return nil, errors.New("disk on fire")
}

func TestThreadAuthorityLookupFailsClosed(t *testing.T) {
	_, _, database := newOverrideFixture(t)
	ctx := context.Background()
	seedThread(t, database, 21, 10)
	permSvc := NewPermissionService(channelLookupFailStore{database}, permissions.NewChecker(database))
	if permSvc.HasChannelPerm(ctx, 1, 21, permissions.ReadMessages) {
		t.Error("HasChannelPerm granted while the authority lookup failed")
	}
	if _, err := permSvc.HasChannelPermChecked(ctx, 1, 21, permissions.ReadMessages); err == nil {
		t.Error("HasChannelPermChecked hid the lookup failure")
	}
	if _, err := permSvc.Subject(ctx, 1, 21); err == nil {
		t.Error("Subject hid the lookup failure")
	}
	// The channel-less Subject needs no lookup.
	if _, err := permSvc.Subject(ctx, 1, 0); err != nil {
		t.Errorf("Subject(user, 0) = %v, want no channel read", err)
	}
}

// A locked thread refuses posts and reactions from members, not moderators.
func TestLockedThreadRefusesMembers(t *testing.T) {
	_, permSvc, database := newOverrideFixture(t)
	ctx := context.Background()
	seedThread(t, database, 21, 10)
	if _, err := database.ExecContext(ctx, `UPDATE channels SET thread_locked = 1 WHERE id = 21`); err != nil {
		t.Fatal(err)
	}
	ch, err := database.GetChannel(ctx, 21)
	if err != nil || ch == nil {
		t.Fatal(err)
	}
	sub, err := channelSubject(ctx, database, permSvc, 1, ch, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := permissions.CanSendMessage(sub); !errors.Is(err, permissions.ErrThreadLocked) {
		t.Errorf("CanSendMessage in a locked thread = %v, want ErrThreadLocked", err)
	}
	if err := permissions.CanViewChannel(sub); err != nil {
		t.Errorf("a locked thread is unreadable: %v", err)
	}
	seedChannelUserOverride(t, database, 1, 10, permissions.ManageMessages, 0)
	permSvc.InvalidateAll()
	sub, err = channelSubject(ctx, database, permSvc, 1, ch, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := permissions.CanSendMessage(sub); err != nil {
		t.Errorf("a moderator cannot post in a locked thread: %v", err)
	}
}

// The admin channel surface, the NSFW acknowledgement and the retention
// policy all refuse a thread id: each belongs to the parent.
func TestThreadRefusedOnParentOnlySurfaces(t *testing.T) {
	channels, permSvc, database := newOverrideFixture(t)
	ctx := context.Background()
	seedThread(t, database, 21, 10)
	if _, err := channels.ResolveGuildChannel(ctx, 21); !errors.Is(err, ErrBadRequest) {
		t.Errorf("ResolveGuildChannel(thread) = %v, want ErrBadRequest", err)
	}
	if _, err := channels.ResolveGuildChannel(ctx, 10); err != nil {
		t.Errorf("ResolveGuildChannel(parent) = %v", err)
	}
	nsfw := NewNSFWService(database, permSvc)
	if err := nsfw.Acknowledge(ctx, 1, 21); !errors.Is(err, ErrBadRequest) {
		t.Errorf("Acknowledge(thread) = %v, want ErrBadRequest", err)
	}
	if err := nsfw.Revoke(ctx, 1, 21); !errors.Is(err, ErrBadRequest) {
		t.Errorf("Revoke(thread) = %v, want ErrBadRequest", err)
	}
	ret := &RetentionService{st: database}
	if err := ret.retentionChannel(ctx, 21); !errors.Is(err, ErrBadRequest) {
		t.Errorf("retentionChannel(thread) = %v, want ErrBadRequest", err)
	}
}

// A socket cannot focus a thread through channel_focus: the parent's visibility
// refresh would not revoke the thread topic, so it refuses a thread id as if it
// did not exist. A thread rides thread_focus instead; mark_read and mark_unread,
// which focus nothing, admit it through the parent
// (TestMoveReadPointer_ThreadAdmittedThroughParent).
func TestThreadNotFocusable(t *testing.T) {
	channels, _, database := newOverrideFixture(t)
	ctx := context.Background()
	seedThread(t, database, 21, 10)
	if _, err := channels.AdmitChannelFocus(ctx, 1, 21); !errors.Is(err, ErrNotFound) {
		t.Errorf("AdmitChannelFocus(thread) = %v, want ErrNotFound", err)
	}
	if _, err := channels.HandleChannelFocus(ctx, 1, 21); !errors.Is(err, ErrNotFound) {
		t.Errorf("HandleChannelFocus(thread) = %v, want ErrNotFound", err)
	}
	if _, err := channels.AdmitChannelFocus(ctx, 1, 10); err != nil {
		t.Errorf("AdmitChannelFocus(parent) = %v", err)
	}
}
