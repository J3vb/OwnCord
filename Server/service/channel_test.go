package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
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

// countingLimiter records every key passed to Allow so a test can assert
// whether the rate-limit map was ever touched for a given call, without
// depending on auth.RateLimiter's unexported internals. Allow always grants
// the request — these tests only care about whether a key was built at all.
type countingLimiter struct {
	calls []string
}

func (c *countingLimiter) Allow(key string, limit int, window time.Duration) bool {
	c.calls = append(c.calls, key)
	return true
}

// TestHandleTyping_NoRateLimitKeyForNonexistentChannel locks OC-0202:
// HandleTyping used to build the "typing:<uid>:<cid>" rate-limit key and call
// limiter.Allow BEFORE resolving the channel at all, so any caller-supplied
// channel id — including ids that don't exist — pinned a new entry in the
// shared, process-wide RateLimiter. RateLimiter.Cleanup only evicts a key
// once every timestamp on it is stale, and production runs cleanup with a
// 6-hour window, so a client sending typing_start for a stream of forged
// channel ids could retain millions of dead map entries for hours. The key
// must only be built once the channel is known to exist (and, below,
// once the caller is authorized to read it) so the key space is bounded to
// real (user, channel) pairs.
func TestHandleTyping_NoRateLimitKeyForNonexistentChannel(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	// Deliberately do NOT seed channel 999999 — it must not exist.

	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
	limiter := &countingLimiter{}

	ch, err := svc.HandleTyping(context.Background(), 1, 999999, limiter)
	if err != nil || ch != nil {
		t.Fatalf("typing on a nonexistent channel must silently drop: ch=%v err=%v", ch, err)
	}
	if len(limiter.calls) != 0 {
		t.Fatalf("HandleTyping built a rate-limit key for a nonexistent channel: calls=%v — "+
			"every forged channel id pins a new entry in the shared RateLimiter for hours "+
			"(Cleanup only evicts once every timestamp on the key is stale)", limiter.calls)
	}
}

// TestHandleTyping_NoRateLimitKeyWithoutReadPermission extends OC-0202 to an
// existing channel the caller cannot read: the rate-limit key must still not
// be built, so the key space stays bounded to channels the user is actually
// authorized to see typing indicators in.
func TestHandleTyping_NoRateLimitKeyWithoutReadPermission(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages, // no ReadMessages
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "secret", Type: "text"})

	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
	limiter := &countingLimiter{}

	ch, err := svc.HandleTyping(context.Background(), 1, 10, limiter)
	if err != nil || ch != nil {
		t.Fatalf("typing without ReadMessages must silently drop: ch=%v err=%v", ch, err)
	}
	if len(limiter.calls) != 0 {
		t.Fatalf("HandleTyping built a rate-limit key before checking ReadMessages permission: calls=%v", limiter.calls)
	}
}
