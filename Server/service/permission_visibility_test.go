package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

type visibilityTimeoutStore struct {
	Store
	timeoutReads int
}

func (s *visibilityTimeoutStore) HasActiveTimeout(ctx context.Context, userID int64) (bool, error) {
	s.timeoutReads++
	return s.Store.HasActiveTimeout(ctx, userID)
}

// A timed-out member still sees the channel. The optimization must neither
// query timeout state for visibility nor cache it for the write predicates.
func TestCanViewChannel_TimeoutDoesNotAffectVisibility(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	store := &visibilityTimeoutStore{Store: f.database}
	perms := NewPermissionService(store, permissions.NewChecker(f.database))
	ch := permissions.ChannelRef{ID: fixtureChannel, Type: "voice"}
	check := func(wantTimedOut bool) {
		t.Helper()
		before := store.timeoutReads
		if !perms.CanViewChannel(ctx, fixtureMember, ch) {
			t.Fatal("member lost channel visibility")
		}
		if store.timeoutReads != before {
			t.Fatal("visibility queried an irrelevant timeout")
		}
		sub, err := perms.Subject(ctx, fixtureMember, ch.ID)
		if err != nil {
			t.Fatal(err)
		}
		sub.Channel = ch
		if store.timeoutReads != before+1 || sub.TimedOut != wantTimedOut {
			t.Fatalf("write subject did not resolve timeout live: %+v, reads=%d", sub, store.timeoutReads-before)
		}
		for _, predicate := range []func(permissions.Subject) error{permissions.CanSendMessage, permissions.CanAddReaction, permissions.CanJoinVoice} {
			if got := errors.Is(predicate(sub), permissions.ErrTimedOut); got != wantTimedOut {
				t.Fatalf("write/admission timeout verdict=%v, want %v", got, wantTimedOut)
			}
		}
	}
	check(false)
	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "test", time.Hour, nil); err != nil {
		t.Fatal(err)
	}
	check(true)
	if err := f.mod.LiftTimeout(ctx, fixtureMod, fixtureMember); err != nil {
		t.Fatal(err)
	}
	check(false)
}

func TestCanViewChannel_InvalidationAndFailClosed(t *testing.T) {
	svc, database := newTestPermService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 10, Name: "visibility", Type: "voice"})
	ch := permissions.ChannelRef{ID: 10, Type: "voice"}
	if !svc.CanViewChannel(ctx, 1, ch) {
		t.Fatal("member cannot see channel")
	}
	if err := database.UpsertChannelOverride(ctx, 10, permissions.MemberRoleID, 0, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	svc.InvalidateAll()
	if svc.CanViewChannel(ctx, 1, ch) {
		t.Fatal("role deny was not applied after invalidation")
	}
	if err := database.UpsertChannelUserOverride(ctx, 10, 1, permissions.ReadMessages, 0); err != nil {
		t.Fatal(err)
	}
	svc.InvalidateUser(1)
	if !svc.CanViewChannel(ctx, 1, ch) {
		t.Fatal("user allow did not override role deny")
	}
	ch.Archived = true
	if svc.CanViewChannel(ctx, 1, ch) {
		t.Fatal("archived channel remained visible")
	}
	ch.Archived = false
	seedUserRole(t, database, 1, permissions.OwnerRoleID)
	svc.InvalidateUser(1)
	if !svc.CanViewChannel(ctx, 1, ch) {
		t.Fatal("administrator bypass lost")
	}
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	failing := NewPermissionService(errOverrideStore{DB: database}, permissions.NewChecker(database))
	if failing.CanViewChannel(ctx, 1, ch) {
		t.Fatal("override failure granted visibility")
	}
	if svc.CanViewChannel(ctx, 9999, ch) {
		t.Fatal("missing role granted visibility")
	}
}

func TestCanViewChannel_DMMembershipIsLive(t *testing.T) {
	svc, database := newTestPermService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 10, Name: "dm", Type: "dm"})
	ch := permissions.ChannelRef{ID: 10, Type: "dm"}
	if svc.CanViewChannel(ctx, 1, ch) {
		t.Fatal("nonparticipant can see DM")
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO dm_participants (channel_id, user_id) VALUES (10, 1)`); err != nil {
		t.Fatal(err)
	}
	if !svc.CanViewChannel(ctx, 1, ch) {
		t.Fatal("participant cannot see DM")
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM dm_participants WHERE channel_id=10 AND user_id=1`); err != nil {
		t.Fatal(err)
	}
	if svc.CanViewChannel(ctx, 1, ch) {
		t.Fatal("removed participant retained cached visibility")
	}
}
