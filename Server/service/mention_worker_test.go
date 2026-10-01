package service

import (
	"context"
	"runtime"
	"sync"
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

func (b *batchSpyStore) IncrementMentionCountsBatch(_ context.Context, _ int64, entries []db.MentionBatchEntry) error {
	b.calls++
	b.entries += len(entries)
	return nil
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
