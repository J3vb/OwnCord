package service

import (
	"context"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// batchSpyStore counts the writer transactions the mention worker opens. Only
// IncrementMentionCountsBatch is exercised by a direct worker.flush test, so
// the embedded Store may stay nil.
type batchSpyStore struct {
	Store
	calls   int
	entries int
}

func (b *batchSpyStore) IncrementMentionCountsBatch(_ context.Context, _ int64, entries []db.MentionBatchEntry) (map[int64]int64, error) {
	b.calls++
	b.entries += len(entries)
	return nil, nil
}

// TestMentionWorker_OneTransactionPerChannelPerWindow is the P5-O05 batching
// guarantee: N messages coalesced into one window flush as a single writer
// transaction per channel, instead of one per message.
func TestMentionWorker_OneTransactionPerChannelPerWindow(t *testing.T) {
	spy := &batchSpyStore{}
	w := newMentionWorker(spy)

	entry := func(context.Context) []db.MentionBatchEntry {
		return []db.MentionBatchEntry{{MsgID: 1, UserIDs: []int64{2}}}
	}
	jobs := make([]mentionJob, 0, 10)
	for range 8 {
		jobs = append(jobs, mentionJob{channelID: 10, apply: entry})
	}
	// A second channel must get its own transaction, not share channel 10's.
	jobs = append(jobs, mentionJob{channelID: 11, apply: entry})

	w.flush(context.Background(), jobs)

	if spy.calls != 2 {
		t.Fatalf("IncrementMentionCountsBatch calls = %d, want 2 (one per channel)", spy.calls)
	}
	if spy.entries != 9 {
		t.Fatalf("batched entries = %d, want 9", spy.entries)
	}
}

// mentionNotifyCall is one NotifyMentionCount delivery recorded by
// fakeMentionNotifier.
type mentionNotifyCall struct {
	userID    int64
	channelID int64
	count     int64
}

// fakeMentionNotifier records every per-user mention-badge push.
type fakeMentionNotifier struct {
	mu    sync.Mutex
	calls []mentionNotifyCall
}

func (f *fakeMentionNotifier) NotifyMentionCount(userID, channelID, count int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, mentionNotifyCall{userID, channelID, count})
}

func (f *fakeMentionNotifier) snapshot() []mentionNotifyCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]mentionNotifyCall(nil), f.calls...)
}

func (f *fakeMentionNotifier) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = nil
}

// lastFor returns the total carried by the final mention_count frame for one
// (user, channel), and whether any arrived.
func (f *fakeMentionNotifier) lastFor(userID, channelID int64) (int64, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, call := range slices.Backward(f.calls) {
		if call.userID == userID && call.channelID == channelID {
			return call.count, true
		}
	}
	return 0, false
}

// orderedRaceStore is a Store double that widens the write-to-emit gap the
// mention ordering fix closes, so a test can prove the reverse write cannot
// interleave with an increment flush's write. IncrementMentionCountsBatch
// blocks after "committing" until released; DecrementMentionCounts reports
// every entry attempt on decStarted. The embedded Store is nil: only these two
// methods are called.
type orderedRaceStore struct {
	Store
	incStarted chan struct{}
	incRelease chan struct{}
	decStarted chan struct{}
	// count is the "authoritative" total the two writes act on, so the test can
	// compare the final stored total with the last delivered frame.
	count atomic.Int64
}

func (s *orderedRaceStore) IncrementMentionCountsBatch(_ context.Context, _ int64, _ []db.MentionBatchEntry) (map[int64]int64, error) {
	s.count.Store(1)
	close(s.incStarted)
	<-s.incRelease
	return map[int64]int64{2: 1}, nil
}

func (s *orderedRaceStore) DecrementMentionCounts(_ context.Context, _ int64, _ []int64) (map[int64]int64, error) {
	s.count.Store(0)
	select {
	case s.decStarted <- struct{}{}:
	default:
	}
	return map[int64]int64{2: 0}, nil
}

// TestMentionWorker_ReverseWaitsForIncrementEmit pins the ordering guarantee
// DP-27 introduced: an increment flush's write and its frames are one critical
// section, so a removal path's reverse cannot commit (and then emit an older
// total) between them. The increment flush is held inside the store after its
// commit; the reverse must block behind the shared lock rather than run its
// write concurrently. Before the fix the two writes interleave and a reader can
// be left with the reverse's older total as its last frame.
func TestMentionWorker_ReverseWaitsForIncrementEmit(t *testing.T) {
	st := &orderedRaceStore{
		incStarted: make(chan struct{}),
		incRelease: make(chan struct{}),
		decStarted: make(chan struct{}),
	}
	notifier := &fakeMentionNotifier{}
	svc := NewMessageService(st, nil, nil)
	svc.SetMentionNotifier(notifier)
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	svc.mentionWorkerForSend().enqueue(mentionJob{channelID: 10, msgID: 1, apply: func(context.Context) []db.MentionBatchEntry {
		return []db.MentionBatchEntry{{MsgID: 1, UserIDs: []int64{2}}}
	}})

	flushDone := make(chan struct{})
	go func() {
		svc.mentionWorkerForSend().flushNow(context.Background())
		close(flushDone)
	}()
	<-st.incStarted // the increment committed and now holds the shared emit lock

	revDone := make(chan struct{})
	go func() {
		if err := svc.reverseMentionCounts(context.Background(), 10, []int64{1}); err != nil {
			t.Errorf("reverseMentionCounts: %v", err)
		}
		close(revDone)
	}()

	// The reverse must not reach its own write while the increment's emit is
	// still in flight. Release the increment before reporting failure so the
	// worker goroutine (and the deferred stop) cannot deadlock on the way out.
	select {
	case <-st.decStarted:
		close(st.incRelease)
		<-flushDone
		<-revDone
		t.Fatal("reverse write ran while an increment flush was mid-emit: the two can invert, leaving the badge stale-low")
	case <-time.After(100 * time.Millisecond):
	}

	close(st.incRelease)
	select {
	case <-st.decStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("reverse never resumed after the increment released the shared emit lock")
	}
	<-flushDone
	<-revDone

	// With the increment and the reverse serialized, the reverse's {0} must be
	// the last frame (it committed last), matching the final stored total. The
	// point is the commit order and the frame order agree.
	final := st.count.Load()
	last, ok := notifier.lastFor(2, 10)
	if !ok || last != final {
		t.Fatalf("last delivered total = %d (present=%v), want the final stored total %d — frames and commits diverged", last, ok, final)
	}
}

// TestMentionWorker_ConcurrentDeleteDeliversLatestTotal is the coalesce-window
// race: two messages mention bob, and one is deleted while both are still
// queued. Whichever order the increment flush and the reverse commit in, the
// last mention_count frame bob receives must equal the server's final total —
// the invariant the unsynchronized emitters broke.
func TestMentionWorker_ConcurrentDeleteDeliversLatestTotal(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	notifier := &fakeMentionNotifier{}
	svc.SetMentionNotifier(notifier)
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	for i := range 100 {
		notifier.reset()
		if _, err := database.ExecContext(ctx,
			`DELETE FROM read_states WHERE user_id = 2 AND channel_id = 10`); err != nil {
			t.Fatalf("reset read_states: %v", err)
		}
		first := sendAs(t, svc, 1, "@bob first")
		sendAs(t, svc, 1, "@bob second")

		var wg sync.WaitGroup
		wg.Go(func() { svc.mentionWorkerForSend().flushNow(context.Background()) })
		wg.Go(func() {
			if _, err := svc.DeleteMessage(context.Background(), 1, first.MessageID); err != nil {
				t.Errorf("DeleteMessage: %v", err)
			}
		})
		wg.Wait()
		svc.mentionWorkerForSend().flushNow(context.Background())

		final := mentionCount(t, database, 2)
		last, ok := notifier.lastFor(2, 10)
		if !ok {
			t.Fatalf("iteration %d: no mention_count frame for bob, want the final total %d", i, final)
		}
		if last != int64(final) {
			t.Fatalf("iteration %d: last frame for bob = %d, want the server's final total %d — the badge was left stale", i, last, final)
		}
	}
}

// TestMentionWorker_NotifiesOnlyReadersGainingABadge locks the live-badge
// signal: flushing a mention push reaches exactly the readers whose badge the
// read-state guard actually raised, with their new total, and nobody else. A
// reader who already read the mentioning message is skipped (no phantom push),
// and the author is never a recipient.
func TestMentionWorker_NotifiesOnlyReadersGainingABadge(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	notifier := &fakeMentionNotifier{}
	svc.SetMentionNotifier(notifier)
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	// alice (1) mentions bob (2) and carol (3).
	res := sendAs(t, svc, 1, "@bob @carol hello")
	// Bob reads the message before the coalesce window flushes, so his bump
	// is guarded away; carol stays behind and gains the badge.
	if err := database.UpdateReadState(ctx, 2, 10, res.MessageID); err != nil {
		t.Fatalf("UpdateReadState: %v", err)
	}

	svc.mentionWorkerForSend().flushNow(context.Background())

	calls := notifier.snapshot()
	if len(calls) != 1 {
		t.Fatalf("notifications = %v, want exactly carol's one push", calls)
	}
	if calls[0] != (mentionNotifyCall{userID: 3, channelID: 10, count: 1}) {
		t.Errorf("notification = %+v, want {3 10 1}", calls[0])
	}
}

// TestMentionWorker_NotifierNilIsSafe locks that a service with no notifier
// (every test, any caller without a hub) flushes without panicking.
func TestMentionWorker_NotifierNilIsSafe(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	sendAs(t, svc, 1, "@bob hello")
	svc.mentionWorkerForSend().flushNow(context.Background())
	if got := mentionCount(t, database, 2); got != 1 {
		t.Errorf("bob mention_count = %d, want 1", got)
	}
}

// TestMentionWorker_FlushesCounts is the plan's correctness test: after a burst
// of @everyone sends is coalesced and flushed, every reader holds the right
// count, the author none.
func TestMentionWorker_FlushesCounts(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	for range 5 {
		sendAs(t, svc, 4, "@everyone stand up")
	}

	// The jobs are still queued, so nothing has landed yet.
	if got := mentionCount(t, database, 2); got != 0 {
		t.Fatalf("bob mention_count = %d before flush, want 0", got)
	}

	svc.mentionWorkerForSend().flushNow(context.Background())
	for _, uid := range []int64{1, 2, 3} {
		if got := mentionCount(t, database, uid); got != 5 {
			t.Errorf("user %d mention_count = %d, want 5", uid, got)
		}
	}
	if got := mentionCount(t, database, 4); got != 0 {
		t.Errorf("author mention_count = %d, want 0", got)
	}
}

// TestMentionWorker_AppliesBlockFilter locks the security-sensitive half of the
// plan: the block/visibility filters still apply when the write is deferred to
// the worker rather than run on the send path.
func TestMentionWorker_AppliesBlockFilter(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedBlock(t, database, 2, 1) // bob blocked alice
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	sendAs(t, svc, 1, "@bob @carol hello")
	svc.mentionWorkerForSend().flushNow(context.Background())

	if got := mentionCount(t, database, 2); got != 0 {
		t.Errorf("blocker mention_count = %d, want 0", got)
	}
	if got := mentionCount(t, database, 3); got != 1 {
		t.Errorf("carol mention_count = %d, want 1", got)
	}
}

// TestMentionWorker_BoundsGoroutinesUnderBurst is the plan's primary test: 100
// concurrent @everyone sends must not spawn a goroutine per send. With the
// worker running, SendMessage only enqueues, so the goroutine count stays flat.
func TestMentionWorker_BoundsGoroutinesUnderBurst(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	// Settle first so the baseline is not inflated by a transient goroutine.
	time.Sleep(20 * time.Millisecond)
	baseline := runtime.NumGoroutine()

	var wg sync.WaitGroup
	errs := make(chan error, 100)
	for range 100 {
		wg.Go(func() {
			_, err := svc.SendMessage(context.Background(), SendMessageParams{
				ChannelID: 10, UserID: 4, Username: "mod", RoleName: "moderator",
				Content: "@everyone storm",
			})
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("SendMessage: %v", err)
		}
	}

	// The workers above are joined; only the worker plus its loop may remain.
	// Poll briefly for the scheduler to reap the finished senders.
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine()-baseline > 2 {
		if time.Now().After(deadline) {
			t.Fatalf("goroutines grew by %d over baseline after 100 sends, want <= 2",
				runtime.NumGoroutine()-baseline)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// All 100 coalesced jobs still produce the correct count.
	svc.mentionWorkerForSend().flushNow(context.Background())
	if got := mentionCount(t, database, 2); got != 100 {
		t.Errorf("bob mention_count = %d, want 100", got)
	}
}

// TestMentionWorker_PlainSendsDoNotQueue locks the queue-capacity guarantee: a
// message with no mention must not take a slot, otherwise ordinary chat fills
// the bounded queue and genuine mention jobs are dropped.
func TestMentionWorker_PlainSendsDoNotQueue(t *testing.T) {
	svc, _, _ := newMentionFixture(t)
	// A started worker with no loop, so queued jobs stay countable.
	w := newMentionWorker(svc.st)
	w.started.Store(true)
	svc.mentionWorker.Store(w)

	for range 50 {
		sendAs(t, svc, 4, "just chatting")
	}
	sendAs(t, svc, 4, "@everyone one real mention")

	if got := len(w.queue); got != 1 {
		t.Fatalf("queued jobs = %d, want 1 (only the @everyone send)", got)
	}
	if got := w.dropped.Load(); got != 0 {
		t.Fatalf("dropped = %d, want 0", got)
	}
}

// TestMentionWorker_DeleteBeforeFlushLeavesNoBadge locks the invariant the
// deferred increment broke: a message deleted while its job is still in the
// coalesce window must not raise a mention badge when the window finally
// flushes. DeleteMessage runs its DecrementMentionCounts reversal synchronously
// and the increment had not landed yet, so without a liveness guard the flush
// raises a permanent phantom badge on a channel with nothing unread.
func TestMentionWorker_DeleteBeforeFlushLeavesNoBadge(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	res := sendAs(t, svc, 1, "@bob look")
	if _, err := svc.DeleteMessage(context.Background(), 1, res.MessageID); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	svc.mentionWorkerForSend().flushNow(context.Background())
	if got := mentionCount(t, database, 2); got != 0 {
		t.Errorf("bob mention_count = %d after deleting a message whose increment was still queued, want 0", got)
	}
}

// TestMentionWorker_DeleteBeforeFlushPreservesPriorBadge is the F1-followup
// case: bob already holds a genuine badge from an earlier message, and a new
// message mentioning him is deleted while its increment is still queued.
// DeleteMessage must flush that queued increment BEFORE the reversal, so the
// increment lands and the reversal takes exactly it back — bob keeps his
// genuine badge. Without the pre-delete flush the reversal consumes the
// prior badge (it cannot tell the two apart), leaving bob at 0.
func TestMentionWorker_DeleteBeforeFlushPreservesPriorBadge(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	// m0 gives bob a real, unread badge. It is a real row so the liveness guard
	// admits its increment.
	m0, err := database.CreateMessage(context.Background(), 10, 3, "hey @bob earlier", nil)
	if err != nil {
		t.Fatalf("seed m0: %v", err)
	}
	if err := svc.st.IncrementMentionCounts(context.Background(), 10, m0, []int64{2}); err != nil {
		t.Fatalf("seed increment: %v", err)
	}
	if got := mentionCount(t, database, 2); got != 1 {
		t.Fatalf("setup: bob mention_count = %d, want 1", got)
	}

	// m mentions bob; its job is queued, increment not yet landed.
	res := sendAs(t, svc, 1, "@bob look")
	if _, err := svc.DeleteMessage(context.Background(), 1, res.MessageID); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	// Any later flush must not change the result: the pre-delete flush already
	// wrote m's increment and the reversal took exactly it.
	svc.mentionWorkerForSend().flushNow(context.Background())
	if got := mentionCount(t, database, 2); got != 1 {
		t.Errorf("bob mention_count = %d after deleting the queued mention, want 1 (his earlier genuine badge must survive)", got)
	}
}

// TestMentionWorker_PurgeBeforeFlushPreservesPriorBadge is the purge sibling
// of the delete case: PurgeMessages must flush the channel's queued mention
// increments before its reversal, so a purged in-window message does not
// consume a genuine badge another, still-live message raised.
func TestMentionWorker_PurgeBeforeFlushPreservesPriorBadge(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	// mod (4) needs MANAGE_MESSAGES on channel 10 to purge.
	seedChannelOverride(t, database, permissions.ModeratorRoleID, 10, permissions.ManageMessages, 0)
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	// m0 gives bob a real badge.
	m0, err := database.CreateMessage(context.Background(), 10, 3, "hey @bob earlier", nil)
	if err != nil {
		t.Fatalf("seed m0: %v", err)
	}
	if err := svc.st.IncrementMentionCounts(context.Background(), 10, m0, []int64{2}); err != nil {
		t.Fatalf("seed increment: %v", err)
	}

	// m mentions bob; queued, then purged before its increment lands. Purge
	// only the newest message so m0 survives and its genuine badge is the one
	// at stake.
	sendAs(t, svc, 4, "@bob purge me")
	if _, err := svc.PurgeMessages(context.Background(), 4, 10, 1, 0); err != nil {
		t.Fatalf("PurgeMessages: %v", err)
	}

	svc.mentionWorkerForSend().flushNow(context.Background())
	if got := mentionCount(t, database, 2); got != 1 {
		t.Errorf("bob mention_count = %d after purging the queued mention, want 1 (his earlier genuine badge must survive)", got)
	}
}

// TestMentionWorker_DeleteNotifiesDecreasedBadge locks the reversal half of the
// live badge: a mention pushed live must be pushed again with its lower total
// when the mentioning message is deleted, or a reader not viewing the channel
// keeps the stale-high badge until their next ready (OC-F1).
func TestMentionWorker_DeleteNotifiesDecreasedBadge(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	notifier := &fakeMentionNotifier{}
	svc.SetMentionNotifier(notifier)
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	res := sendAs(t, svc, 1, "@bob look")
	svc.mentionWorkerForSend().flushNow(context.Background())
	if calls := notifier.snapshot(); len(calls) != 1 || calls[0] != (mentionNotifyCall{2, 10, 1}) {
		t.Fatalf("after send, notifications = %v, want one {2 10 1}", calls)
	}

	if _, err := svc.DeleteMessage(context.Background(), 1, res.MessageID); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}
	if got := mentionCount(t, database, 2); got != 0 {
		t.Fatalf("bob mention_count = %d after delete, want 0", got)
	}
	calls := notifier.snapshot()
	if len(calls) != 2 {
		t.Fatalf("notifications = %v, want the send push and the delete push", calls)
	}
	if calls[1] != (mentionNotifyCall{2, 10, 0}) {
		t.Errorf("delete notification = %+v, want {2 10 0}", calls[1])
	}
}

// TestMentionWorker_PurgeNotifiesDecreasedBadge is the purge sibling of the
// delete case: purging a pushed mention must push the lowered total too.
func TestMentionWorker_PurgeNotifiesDecreasedBadge(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedChannelOverride(t, database, permissions.ModeratorRoleID, 10, permissions.ManageMessages, 0)
	notifier := &fakeMentionNotifier{}
	svc.SetMentionNotifier(notifier)
	ctx := t.Context()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	sendAs(t, svc, 1, "@bob look")
	svc.mentionWorkerForSend().flushNow(context.Background())
	if calls := notifier.snapshot(); len(calls) != 1 || calls[0] != (mentionNotifyCall{2, 10, 1}) {
		t.Fatalf("after send, notifications = %v, want one {2 10 1}", calls)
	}

	if _, err := svc.PurgeMessages(context.Background(), 4, 10, 1, 0); err != nil {
		t.Fatalf("PurgeMessages: %v", err)
	}
	if got := mentionCount(t, database, 2); got != 0 {
		t.Fatalf("bob mention_count = %d after purge, want 0", got)
	}
	calls := notifier.snapshot()
	if len(calls) != 2 {
		t.Fatalf("notifications = %v, want the send push and the purge push", calls)
	}
	if calls[1] != (mentionNotifyCall{2, 10, 0}) {
		t.Errorf("purge notification = %+v, want {2 10 0}", calls[1])
	}
}

// TestMentionWorker_FlushMessagesOnlyTargetsNamed locks the targeted flush:
// flushing one message's job leaves another pending job untouched until its own
// window elapses.
func TestMentionWorker_FlushMessagesOnlyTargetsNamed(t *testing.T) {
	spy := &batchSpyStore{}
	w := newMentionWorker(spy)
	ctx := t.Context()
	w.run(ctx)

	w.enqueue(mentionJob{channelID: 10, msgID: 1, apply: func(context.Context) []db.MentionBatchEntry {
		return []db.MentionBatchEntry{{MsgID: 1, UserIDs: []int64{2}}}
	}})
	w.enqueue(mentionJob{channelID: 10, msgID: 2, apply: func(context.Context) []db.MentionBatchEntry {
		return []db.MentionBatchEntry{{MsgID: 2, UserIDs: []int64{3}}}
	}})

	w.flushMessages(context.Background(), []int64{1})
	if spy.entries != 1 {
		t.Fatalf("after targeted flush, batched entries = %d, want 1 (only msg 1)", spy.entries)
	}

	w.flushNow(context.Background())
	if spy.entries != 2 {
		t.Fatalf("after full flush, batched entries = %d, want 2", spy.entries)
	}
	w.stopAndDrain(context.Background())
}

// TestMentionWorker_DropsWhenStopped locks the non-blocking contract: a send
// after the worker stopped counts the job as dropped and never blocks.
func TestMentionWorker_DropsWhenStopped(t *testing.T) {
	spy := &batchSpyStore{}
	w := newMentionWorker(spy)
	ctx, cancel := context.WithCancel(context.Background())
	w.run(ctx)
	w.stopAndDrain(context.Background())
	cancel()

	w.enqueue(mentionJob{channelID: 1, apply: func(context.Context) []db.MentionBatchEntry { return nil }})
	if got := w.dropped.Load(); got != 1 {
		t.Fatalf("dropped = %d, want 1", got)
	}
}
