package service

import (
	"context"
	"errors"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// TestListVisibleChannels_OverrideFetchErrorFailsClosed is the uncached half of
// the same fail-open bug as TestHasChannelPerm_OverrideFetchErrorDenies: an
// empty override map here would list every channel the role is explicitly
// denied. The listing must error instead of leaking the denied channel.
func TestListVisibleChannels_OverrideFetchErrorFailsClosed(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions,
		Position:    1,
	})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "secret", Type: "text"})
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, 0, permissions.ReadMessages)

	st := errOverrideStore{DB: database}
	permSvc := NewPermissionService(st, permissions.NewChecker(database))
	svc := NewChannelService(st, permSvc)

	// Either failing path is acceptable and both are ErrInternal: the permission
	// cache may short-circuit on its own fail-closed nil, or ListVisibleChannels'
	// own override branch may error. What must never happen is a 200 listing.
	got, err := svc.ListVisibleChannels(context.Background(), 1)
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("ListVisibleChannels err = %v, want ErrInternal", err)
	}
	if got != nil {
		t.Fatalf("ListVisibleChannels returned %d channels on override fetch failure, want none", len(got))
	}
}

// TestHandleChannelFocus_RefusedInArchivedChannel locks OC-0070: archived
// channels are hidden from every other client surface (ListVisibleChannels,
// the ws ready payload, RefreshChannelVisibility, voice join) but
// HandleChannelFocus never consulted ch.Archived, so a socket that still held
// the channel id could re-subscribe to its live event stream — and advance
// its own read state — on a channel reconnect replay (computeAllowedChannels)
// would then filter out. focus and mark_read share this one service call, so
// gating it here closes both.
func TestHandleChannelFocus_RefusedInArchivedChannel(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))

	// Precondition: focus succeeds while the channel is not archived.
	if _, err := svc.HandleChannelFocus(ctx, 1, 10); err != nil {
		t.Fatalf("precondition: focus on a live channel: %v", err)
	}

	if _, err := database.ExecContext(ctx,
		`UPDATE channels SET archived = 1 WHERE id = 10`); err != nil {
		t.Fatalf("archive channel: %v", err)
	}

	_, err := svc.HandleChannelFocus(ctx, 1, 10)
	if err == nil {
		t.Fatal("HandleChannelFocus on an archived channel succeeded — the socket can still subscribe to its live event stream")
	}
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("HandleChannelFocus error = %v, want ErrForbidden", err)
	}
}

// TestHandleChannelFocus_DMExemptFromArchiveGate makes sure the archive gate
// above is scoped to non-DM channels only — DMs carry no archived concept.
func TestHandleChannelFocus_DMExemptFromArchiveGate(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedChannel(t, database, &db.Channel{ID: 50, Name: "dm-1-2", Type: "dm"})
	seedDMParticipant(t, database, 50, 1)
	seedDMParticipant(t, database, 50, 2)

	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))

	if _, err := svc.HandleChannelFocus(ctx, 1, 50); err != nil {
		t.Fatalf("HandleChannelFocus on a DM: %v", err)
	}
}

// TestHandleTyping_BlockedInDMEmitsNothing completes the DM-block sweep: a
// blocked user could still drive a repeatable typing indicator at the blocker,
// because HandleTyping authorized on DM participation alone. Typing is
// best-effort, so the refusal is a silent nil rather than an error.
func TestHandleTyping_BlockedInDMEmitsNothing(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 50, Name: "dm-1-2", Type: "dm"})
	seedDMParticipant(t, database, 50, 1)
	seedDMParticipant(t, database, 50, 2)

	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))

	ch, err := svc.HandleTyping(context.Background(), 1, 50, nil)
	if err != nil || ch == nil {
		t.Fatalf("unblocked DM typing must resolve the channel: ch=%v err=%v", ch, err)
	}

	seedBlock(t, database, 2, 1) // bob blocks alice

	ch, err = svc.HandleTyping(context.Background(), 1, 50, nil)
	if err != nil {
		t.Fatalf("typing is best-effort, expected a silent drop, got err=%v", err)
	}
	if ch != nil {
		t.Fatal("blocked user must not produce a typing broadcast")
	}
}
