package service

import (
	"context"
	"errors"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// TestAppeal_DecideDoesNotNotifyOnFailure is the notification half of F1: a
// Decide call that returns an error (for any reason — this one uses the
// simplest, an already-decided appeal) must never fire the appeal_status
// notification. db/appeal_reversal_test.go covers the reversal-specific
// half (a forced reversal failure rolls back the whole transaction) at the
// db layer, where the test-only fault-injection hook actually lives.
func TestAppeal_DecideDoesNotNotifyOnFailure(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	publicID := f.openAppeal(ctx, t)
	mustDo(t, "first Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no"))

	notifier := &fakeAppealNotifier{}
	f.appeals.SetNotifier(notifier)

	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "again"); !errors.Is(err, ErrConflict) {
		t.Fatalf("re-deciding a decided appeal: want ErrConflict, got %v", err)
	}
	if len(notifier.calls) != 0 {
		t.Fatalf("appeal_status notify calls = %d, want 0 for a failed Decide", len(notifier.calls))
	}
}

// appealOrderRecorder records every notify call's order across BOTH
// channels (appeal_status and mod_queue) in one shared, lock-protected
// slice — F4's own test needs the two interleaved to prove one transition's
// pair never lands between another's.
type appealOrderRecorder struct {
	mu     syncutil.Mutex
	events []string
}

func (r *appealOrderRecorder) add(s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, s)
}

func (r *appealOrderRecorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

type orderedStatusNotifier struct{ rec *appealOrderRecorder }

func (n *orderedStatusNotifier) NotifyAppealStatus(userID int64, publicID, state string, note *string) {
	n.rec.add("status:" + state)
}

type orderedQueueBroadcaster struct{ rec *appealOrderRecorder }

func (b *orderedQueueBroadcaster) BroadcastAppealQueue(ctx context.Context, appealID int64, state string) {
	b.rec.add("queue:" + state)
}

// TestAppeal_AssignThenDecideNotifyOrderMatchesCommitOrder is F4: Assign's
// write commits, then — before Assign has notified anyone — a concurrent
// Decide runs to completion (write, audit, both notifies). F4's per-appeal
// lock must force Decide to wait for Assign's own notify pair before it can
// even begin its write, so every notify (appeal_status AND mod_queue) lands
// in commit order: assigned, assigned, overturned, overturned — never a
// stale "assigned" trailing behind "overturned".
func TestAppeal_AssignThenDecideNotifyOrderMatchesCommitOrder(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	publicID := f.openAppeal(ctx, t)

	rec := &appealOrderRecorder{}
	f.appeals.SetNotifier(&orderedStatusNotifier{rec: rec})
	f.appeals.SetQueueBroadcaster(&orderedQueueBroadcaster{rec: rec})

	reached := make(chan struct{})
	release := make(chan struct{})
	var armed atomic.Bool
	appealPostWriteHookForTest = func(pid string) {
		if pid != publicID {
			return
		}
		// Only the FIRST call (Assign's) parks here. A second transition's
		// call (Decide's, if it ever reaches this same hook) must return
		// immediately, with NO blocking of its own — sync.Once would be the
		// obvious tool here, but Once.Do blocks EVERY caller until the
		// winning call's function returns, which would make Decide's call
		// block on Assign's in-flight <-release for the exact same reason a
		// shared release channel does: proving nothing about the appeal's
		// own lock. CompareAndSwap lets exactly one caller run the blocking
		// body while every other caller falls through instantly.
		if armed.CompareAndSwap(false, true) {
			close(reached)
			<-release
		}
	}
	defer func() { appealPostWriteHookForTest = nil }()

	assignDone := make(chan error, 1)
	go func() {
		assignDone <- f.appeals.Assign(ctx, fixturePeerMod, publicID, false)
	}()

	select {
	case <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("Assign never reached the post-write hook — the barrier never armed")
	}
	// Assign's write has committed and it is now parked in the hook, still
	// holding the appeal's own lock (it has not notified or unlocked yet).

	decideDone := make(chan error, 1)
	go func() {
		decideDone <- f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine")
	}()

	// The parking pattern (round 4 test-strengthening): PROVE Decide is
	// actually blocked on the appeal's lock while Assign holds it, rather
	// than hoping a fixed sleep gave it enough time to queue. If the lock
	// were a no-op, Decide's whole transaction (an in-memory sqlite write)
	// would essentially always complete within this window; it can only
	// still be empty here because something is genuinely holding it up.
	select {
	case err := <-decideDone:
		t.Fatalf("Decide completed (err=%v) while Assign was still holding the appeal's lock — the lock is not actually blocking", err)
	case <-time.After(100 * time.Millisecond):
		// Still parked, as the lock requires.
	}

	close(release)

	mustDo(t, "Assign", <-assignDone)
	mustDo(t, "Decide", <-decideDone)

	want := []string{"status:assigned", "queue:assigned", "status:overturned", "queue:overturned"}
	if got := rec.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("notify order = %v, want %v", got, want)
	}
}

// TestAppeal_SubmitThenWithdrawNotifyOrderMatchesCommitOrder is P3 item 4,
// Submit's twin of TestAppeal_AssignThenDecideNotifyOrderMatchesCommitOrder:
// Submit's own "open" mod_queue broadcast used to run in the API handler
// AFTER Submit returned, so it could arrive after a withdraw (or assign)
// frame for the SAME appeal filed moments later. Submit now broadcasts
// under the same per-appeal lock as every other transition — this proves
// it the same way F4's test proves Assign/Decide: park Submit inside the
// post-write hook (write committed, lock held, not yet notified), prove a
// concurrent Withdraw is genuinely blocked on the lock rather than merely
// slower, then release and check commit order held: open before withdrawn.
func TestAppeal_SubmitThenWithdrawNotifyOrderMatchesCommitOrder(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	actionID := f.warnMember(ctx, t, "x")

	rec := &appealOrderRecorder{}
	f.appeals.SetQueueBroadcaster(&orderedQueueBroadcaster{rec: rec})

	reached := make(chan struct{})
	release := make(chan struct{})
	publicIDCh := make(chan string, 1)
	var armed atomic.Bool
	appealPostWriteHookForTest = func(pid string) {
		select {
		case publicIDCh <- pid:
		default:
		}
		if armed.CompareAndSwap(false, true) {
			close(reached)
			<-release
		}
	}
	defer func() { appealPostWriteHookForTest = nil }()

	type submitResult struct {
		publicID string
		err      error
	}
	submitDone := make(chan submitResult, 1)
	go func() {
		pid, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
		submitDone <- submitResult{pid, err}
	}()

	select {
	case <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("Submit never reached the post-write hook — the barrier never armed")
	}
	publicID := <-publicIDCh
	// Submit's insert has committed and it is now parked in the hook, still
	// holding the appeal's own lock (it has not notified or unlocked yet).

	withdrawDone := make(chan error, 1)
	go func() {
		withdrawDone <- f.appeals.Withdraw(ctx, fixtureMember, publicID)
	}()

	select {
	case err := <-withdrawDone:
		t.Fatalf("Withdraw completed (err=%v) while Submit was still holding the appeal's lock — the lock is not actually blocking", err)
	case <-time.After(100 * time.Millisecond):
		// Still parked, as the lock requires.
	}

	close(release)

	result := <-submitDone
	if result.err != nil {
		t.Fatalf("Submit: %v", result.err)
	}
	mustDo(t, "Withdraw", <-withdrawDone)

	want := []string{"queue:open", "queue:withdrawn"}
	if got := rec.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("notify order = %v, want %v", got, want)
	}
}

// TestAppeal_DelayedAssignAfterDecisionDoesNotBroadcast is F4: a delayed
// Assign that finally reaches the database after the appeal was already
// decided must fail on the same guarded UPDATE Claim 5 added (the appeal's
// state is no longer "open"/"assigned", so the write affects zero rows) —
// and, critically, must NOT emit an "assigned" appeal_status frame, which
// would otherwise arrive at the appellant's socket AFTER the "overturned"
// or "upheld" frame it already received.
func TestAppeal_DelayedAssignAfterDecisionDoesNotBroadcast(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	publicID := f.openAppeal(ctx, t)
	mustDo(t, "Decide", f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"))

	notifier := &fakeAppealNotifier{}
	f.appeals.SetNotifier(notifier)

	if err := f.appeals.Assign(ctx, fixturePeerMod, publicID, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("delayed assign after decision: want ErrConflict, got %v", err)
	}
	if len(notifier.calls) != 0 {
		t.Fatalf("appeal_status notify calls = %d, want 0 — a refused assign must never broadcast", len(notifier.calls))
	}
}

// recordingQueueBroadcaster records whether it was called and the exact
// context it was handed, for TestAppeal_NotifyQueueSurvivesCallerContextCancellation.
type recordingQueueBroadcaster struct {
	called bool
	gotCtx context.Context
}

func (r *recordingQueueBroadcaster) BroadcastAppealQueue(ctx context.Context, appealID int64, state string) {
	r.called = true
	r.gotCtx = ctx
}

// TestAppeal_NotifyQueueSurvivesCallerContextCancellation is P3 item 3:
// notifyQueue used to forward the caller's own request context straight to
// the broadcaster, so a client disconnecting right after the write commits
// (canceling ctx) could suppress the mod_queue frame every OTHER
// moderator's queue view depends on. The postWriteHook fires exactly
// between the commit and notifyQueue's call, the same seam F4's ordering
// tests use — canceling the caller's context there proves notifyQueue must
// detach via context.WithoutCancel, not merely that it happens to run
// before some later cancellation.
func TestAppeal_NotifyQueueSurvivesCallerContextCancellation(t *testing.T) {
	f := newAppealFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	publicID := f.openAppeal(ctx, t)

	broadcaster := &recordingQueueBroadcaster{}
	f.appeals.SetQueueBroadcaster(broadcaster)

	appealPostWriteHookForTest = func(pid string) {
		if pid == publicID {
			cancel() // the client "disconnects" right after the write commits.
		}
	}
	defer func() { appealPostWriteHookForTest = nil }()

	mustDo(t, "Withdraw", f.appeals.Withdraw(ctx, fixtureMember, publicID))
	if !broadcaster.called {
		t.Fatal("BroadcastAppealQueue was never called — the caller's context cancellation must not suppress the mod_queue broadcast")
	}
	if broadcaster.gotCtx.Err() != nil {
		t.Fatalf("BroadcastAppealQueue's context was already canceled (err=%v) — notifyQueue must detach via context.WithoutCancel", broadcaster.gotCtx.Err())
	}
}
