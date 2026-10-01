package service

import (
	"context"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
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
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
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
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
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
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := svc.StartMentionWorker(ctx)
	defer stop(context.Background())

	// Settle first so the baseline is not inflated by a transient goroutine.
	time.Sleep(20 * time.Millisecond)
	baseline := runtime.NumGoroutine()

	var wg sync.WaitGroup
	errs := make(chan error, 100)
	for range 100 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := svc.SendMessage(context.Background(), SendMessageParams{
				ChannelID: 10, UserID: 4, Username: "mod", RoleName: "moderator",
				Content: "@everyone storm",
			})
			errs <- err
		}()
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
	for {
		if runtime.NumGoroutine()-baseline <= 2 {
			break
		}
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
