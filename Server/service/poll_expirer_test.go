package service

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

type recordingPollNotifier struct {
	mu      sync.Mutex
	updates []PollUpdate
	got     chan struct{}
}

func newRecordingPollNotifier() *recordingPollNotifier {
	return &recordingPollNotifier{got: make(chan struct{}, 64)}
}

func (n *recordingPollNotifier) PollUpdated(_ context.Context, u PollUpdate) {
	n.mu.Lock()
	n.updates = append(n.updates, u)
	n.mu.Unlock()
	n.got <- struct{}{}
}

func (n *recordingPollNotifier) snapshot() []PollUpdate {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]PollUpdate(nil), n.updates...)
}

func (f *forwardFixture) expirer() (*PollExpirer, *recordingPollNotifier) {
	e := NewPollExpirer(f.database, f.svc)
	n := newRecordingPollNotifier()
	e.SetNotifier(n)
	return e, n
}

func TestPollExpirer_EndsDueAndNotifies(t *testing.T) {
	f := newForwardFixture(t, nil)
	e, n := f.expirer()
	due := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	open := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.vote(fwdCarol, due.MessageID, 2); err != nil {
		t.Fatal(err)
	}
	f.expire(t, due.MessageID)

	if err := e.Sweep(context.Background()); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	got := n.snapshot()
	if len(got) != 1 {
		t.Fatalf("notified %d times, want once: %+v", len(got), got)
	}
	u := got[0]
	if u.MessageID != due.MessageID || u.ChannelID != fwdDstChan || !u.Ended || u.EndedAt == nil || u.Version != 2 ||
		u.TotalVoters != 1 || countFor(&u, 2) != 1 || u.UserID != 0 {
		t.Errorf("update = %+v", u)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM polls WHERE message_id = ? AND ended_at IS NULL`, open.MessageID); n != 1 {
		t.Error("the still-open poll was ended")
	}
	// A second sweep finds nothing, and tells nobody again.
	if err := e.Sweep(context.Background()); err != nil || len(n.snapshot()) != 1 {
		t.Errorf("second sweep: err = %v, notifications = %d", err, len(n.snapshot()))
	}
}

func TestPollExpirer_DeletedEndedSilently(t *testing.T) {
	f := newForwardFixture(t, nil)
	e, n := f.expirer()
	poll := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.svc.DeleteMessage(context.Background(), fwdBob, poll.MessageID); err != nil {
		t.Fatal(err)
	}
	f.expire(t, poll.MessageID)
	if err := e.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := n.snapshot(); len(got) != 0 {
		t.Errorf("a deleted poll was announced: %+v", got)
	}
	if _, ok, err := f.database.NextPollExpiry(context.Background()); err != nil || ok {
		t.Errorf("the deleted poll is still pending (ok=%v, err=%v)", ok, err)
	}
}

func TestPollExpirer_BootSweepCatchesUp(t *testing.T) {
	f := newForwardFixture(t, nil)
	e, n := f.expirer()
	e.batch = 2 // three batches' worth, so the sweep has to loop
	ids := make([]int64, 0, 5)
	for range 5 {
		p := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
		ids = append(ids, p.MessageID)
		f.expire(t, p.MessageID)
	}
	keep := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if err := e.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	seen := map[int64]bool{}
	for _, u := range n.snapshot() {
		if !u.Ended {
			t.Errorf("update %+v is not an end", u)
		}
		seen[u.MessageID] = true
	}
	for _, id := range ids {
		if !seen[id] {
			t.Errorf("poll %d that expired while the server was down was not ended", id)
		}
	}
	if seen[keep.MessageID] || len(seen) != len(ids) {
		t.Errorf("updates for %v, want exactly the expired polls", seen)
	}
}

// A poll the sweep cannot end must not stop the ones behind it.
type failingEnder struct {
	failID int64
	real   pollEnder
}

func (e failingEnder) ExpirePoll(ctx context.Context, id int64) (*PollUpdate, error) {
	if id == e.failID {
		return nil, errors.New("injected")
	}
	return e.real.ExpirePoll(ctx, id)
}

func TestPollExpirer_OnePoisonedPollDoesNotBlockTheRest(t *testing.T) {
	f := newForwardFixture(t, nil)
	a := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	b := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	f.expire(t, a.MessageID)
	f.expire(t, b.MessageID)
	e := NewPollExpirer(f.database, failingEnder{failID: a.MessageID, real: f.svc})
	n := newRecordingPollNotifier()
	e.SetNotifier(n)
	if err := e.Sweep(context.Background()); err == nil {
		t.Fatal("a failed end was swallowed")
	}
	got := n.snapshot()
	if len(got) != 1 || got[0].MessageID != b.MessageID {
		t.Errorf("updates = %+v, want the second poll's end", got)
	}
}

func TestPollExpirer_WakeOnCreate(t *testing.T) {
	f := newForwardFixture(t, nil)
	e, n := f.expirer()
	e.maxSleep = time.Hour // only a wake can bring the next deadline in
	e.slack = 0
	f.svc.SetPollWake(e.Wake)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); e.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })

	// Nothing is pending, so the loop is asleep for an hour. A poll created now
	// is due in a second, and its creation wakes the loop to re-read.
	poll := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.database.ExecContext(context.Background(),
		`UPDATE polls SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 second') WHERE message_id = ?`, poll.MessageID); err != nil {
		t.Fatal(err)
	}
	e.Wake()
	select {
	case <-n.got:
	case <-time.After(10 * time.Second):
		t.Fatal("the poll was not ended after its expiry")
	}
	if got := n.snapshot(); len(got) != 1 || got[0].MessageID != poll.MessageID || !got[0].Ended {
		t.Errorf("updates = %+v", got)
	}
}

func TestPollExpirer_ExitsOnCancel(t *testing.T) {
	f := newForwardFixture(t, nil)
	e, _ := f.expirer()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); e.Run(ctx) }()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}
}

type brokenPollStore struct{ err error }

func (s brokenPollStore) NextPollExpiry(context.Context) (string, bool, error) {
	return "", false, s.err
}

func (s brokenPollStore) ListDuePolls(context.Context, string, int) ([]db.DuePoll, error) {
	return nil, s.err
}

func TestPollExpirer_StoreErrorsAreReportedAndRetried(t *testing.T) {
	e := NewPollExpirer(brokenPollStore{err: errors.New("disk")}, nil)
	if err := e.Sweep(context.Background()); err == nil {
		t.Fatal("Sweep hid a read error")
	}
	e.retryAfter = time.Millisecond
	if sleep, failed := e.nextSleep(context.Background()); !failed || sleep != time.Millisecond {
		t.Errorf("nextSleep after a read error = %v, failed=%v", sleep, failed)
	}
	// The loop survives the error and still exits on cancel.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); e.Run(ctx) }()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit")
	}
}

func TestPollExpirer_NextSleepFollowsTheSoonestExpiry(t *testing.T) {
	f := newForwardFixture(t, nil)
	e, _ := f.expirer()
	if sleep, failed := e.nextSleep(context.Background()); failed || sleep != e.maxSleep {
		t.Errorf("no polls: sleep = %v failed = %v, want maxSleep", sleep, failed)
	}
	poll := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return now }
	if _, err := f.database.ExecContext(context.Background(),
		`UPDATE polls SET expires_at = '2026-01-01T00:00:30Z' WHERE message_id = ?`, poll.MessageID); err != nil {
		t.Fatal(err)
	}
	if sleep, _ := e.nextSleep(context.Background()); sleep != 30*time.Second+e.slack {
		t.Errorf("sleep = %v, want 30s plus the slack", sleep)
	}
	if _, err := f.database.ExecContext(context.Background(),
		`UPDATE polls SET expires_at = '2025-12-31T23:00:00Z' WHERE message_id = ?`, poll.MessageID); err != nil {
		t.Fatal(err)
	}
	if sleep, _ := e.nextSleep(context.Background()); sleep != 0 {
		t.Errorf("overdue poll: sleep = %v, want 0", sleep)
	}
	if _, err := f.database.ExecContext(context.Background(),
		`UPDATE polls SET expires_at = '2027-01-01T00:00:00Z' WHERE message_id = ?`, poll.MessageID); err != nil {
		t.Fatal(err)
	}
	if sleep, _ := e.nextSleep(context.Background()); sleep != e.maxSleep {
		t.Errorf("far-off poll: sleep = %v, want it capped at maxSleep", sleep)
	}
}

func TestNew_WiresThePollExpirer(t *testing.T) {
	f := newForwardFixture(t, nil)
	svc := New(f.database, nil)
	if svc.PollExpiry == nil {
		t.Fatal("service.New left PollExpiry unset for a database that has polls")
	}
}
