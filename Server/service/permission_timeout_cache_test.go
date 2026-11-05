package service

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// timeoutQuerySpyStore counts the two store reads that can answer "is this
// user timed out": the per-user HasActiveTimeout and the whole-set
// ListActiveTimeoutExpiries the in-memory mirror loads from. Everything else
// promotes to the embedded Store.
type timeoutQuerySpyStore struct {
	Store
	hasActive atomic.Int64
	listAll   atomic.Int64
}

func (s *timeoutQuerySpyStore) HasActiveTimeout(ctx context.Context, userID int64) (bool, error) {
	s.hasActive.Add(1)
	return s.Store.HasActiveTimeout(ctx, userID)
}

func (s *timeoutQuerySpyStore) ListActiveTimeoutExpiries(ctx context.Context) ([]db.ActiveTimeoutExpiry, error) {
	s.listAll.Add(1)
	return s.Store.ListActiveTimeoutExpiries(ctx)
}

func (s *timeoutQuerySpyStore) reset() {
	s.hasActive.Store(0)
	s.listAll.Store(0)
}

// newSpiedModerationFixture is newModerationActionsFixture with every
// service reading through one timeoutQuerySpyStore.
func newSpiedModerationFixture(t *testing.T) (*moderationActionsFixture, *timeoutQuerySpyStore) {
	t.Helper()
	base := newModerationActionsFixture(t)
	spy := &timeoutQuerySpyStore{Store: base.database}
	perms := NewPermissionService(spy, permissions.NewChecker(spy))
	mod := NewModerationService(spy, perms)
	messages := NewMessageService(spy, perms, nil)
	mod.messages = messages
	return &moderationActionsFixture{mod: mod, messages: messages, database: base.database}, spy
}

// P5-O02: Subject answers TimedOut from the in-memory mirror, so repeated
// calls for a user with no timeout issue no per-call timeout query (before
// the mirror, each of these 100 calls ran HasActiveTimeout).
func TestSubject_TimeoutMirror_NoPerCallQuery(t *testing.T) {
	f, spy := newSpiedModerationFixture(t)
	ctx := context.Background()

	for range 100 {
		sub, err := f.mod.perms.Subject(ctx, fixtureMember, fixtureChannel)
		mustDo(t, "Subject", err)
		if sub.TimedOut {
			t.Fatal("TimedOut = true for a user with no timeout")
		}
	}
	if n := spy.hasActive.Load(); n != 0 {
		t.Fatalf("HasActiveTimeout queries = %d over 100 Subject calls, want 0", n)
	}
	if n := spy.listAll.Load(); n > 1 {
		t.Fatalf("ListActiveTimeoutExpiries loads = %d, want at most the one initial load", n)
	}
}

// A timeout issued while the mirror is already warm denies the very next
// send, and lifting it allows the next one — no staleness window.
func TestSubject_TimeoutMirror_IssueAndLiftTakeEffectAtOnce(t *testing.T) {
	f, _ := newSpiedModerationFixture(t)
	ctx := context.Background()

	send := func(content string) error {
		_, err := f.messages.SendMessage(ctx, SendMessageParams{
			ChannelID: fixtureChannel, UserID: fixtureMember, Username: "u3", RoleName: "member", Content: content,
		})
		return err
	}
	mustDo(t, "send before timeout", send("before"))
	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if err := send("during"); !errors.Is(err, ErrTimedOut) {
		t.Fatalf("send right after Timeout: want ErrTimedOut, got %v", err)
	}
	mustDo(t, "LiftTimeout", f.mod.LiftTimeout(ctx, fixtureMod, fixtureMember))
	mustDo(t, "send right after LiftTimeout", send("after"))
}

// An expired timeout stops denying on the clock alone: no lift, no sweep and
// no store read is needed for the next send to pass.
func TestSubject_TimeoutMirror_ExpiryIsClockEvaluated(t *testing.T) {
	f, spy := newSpiedModerationFixture(t)
	ctx := context.Background()

	// Below Timeout's 1-minute floor, so written straight to the ledger and
	// mirrored the way Timeout mirrors it.
	expires := time.Now().Add(2 * time.Second)
	if _, _, err := f.database.TimeoutUser(ctx, fixtureMember, fixtureMod, nil, "brief", expires); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	mustDo(t, "RefreshTimeouts", f.mod.perms.RefreshTimeouts(ctx))
	sub, err := f.mod.perms.Subject(ctx, fixtureMember, fixtureChannel)
	mustDo(t, "Subject", err)
	if !sub.TimedOut {
		t.Fatal("TimedOut = false while the timeout is active")
	}

	time.Sleep(time.Until(expires) + 1100*time.Millisecond)
	spy.reset()
	if _, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: fixtureChannel, UserID: fixtureMember, Username: "u3", RoleName: "member", Content: "after expiry",
	}); err != nil {
		t.Fatalf("send after expiry: want success, got %v", err)
	}
	if h, l := spy.hasActive.Load(), spy.listAll.Load(); h != 0 || l != 0 {
		t.Fatalf("timeout reads after expiry = %d HasActiveTimeout + %d ListActiveTimeoutExpiries, want 0", h, l)
	}
}
