package service

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// mentionQueueSize bounds pending jobs. Past it, later jobs are dropped and
// counted rather than growing the queue or blocking the sender: badges are
// cosmetic and a send must never wait on badge bookkeeping.
const mentionQueueSize = 4096

// mentionFlushInterval is how often the worker checks the coalesce window; it
// bounds flush latency, not throughput.
const mentionFlushInterval = 50 * time.Millisecond

// mentionJobCoalesceWindow delays a job's write so messages sent close together
// share one writer transaction (a 2,000-member @everyone was its own 2,000-row
// transaction).
const mentionJobCoalesceWindow = 250 * time.Millisecond

// mentionJob is one message's deferred badge work. enqueueAt starts its coalesce
// window; channelID groups jobs sharing a transaction; msgID lets a removal path
// flush exactly this job before reversing its increments; apply resolves
// recipients at flush time (so block and visibility filters and the read-state
// guard see state after the send) and returns one batch entry per message.
type mentionJob struct {
	enqueueAt time.Time
	channelID int64
	msgID     int64
	apply     func(ctx context.Context) []db.MentionBatchEntry
}

// mentionFlushReq is a flush handled on the worker loop. match selects the jobs to
// apply now; nil selects all (the full barrier for tests and shutdown). A removal
// path passes a narrower match to flush exactly the messages it will reverse.
// reply is closed once they are applied.
type mentionFlushReq struct {
	match func(mentionJob) bool
	reply chan struct{}
}

// mentionBatchStore is what mentionWorker reads and writes. *db.DB satisfies it.
type mentionBatchStore interface {
	// IncrementMentionCountsBatch applies a coalesced window of mention jobs in one
	// writer transaction (the mention worker's flush). It returns userID to
	// mention_count for exactly the recipients whose read-state guard admitted the
	// bump: the live-badge signal.
	IncrementMentionCountsBatch(ctx context.Context, channelID int64, entries []db.MentionBatchEntry) (map[int64]int64, error)
}

// mentionWorker is the single background worker owning every mention badge write
// while running. SendMessage enqueues here instead of a goroutine per send, so 100
// concurrent @everyone sends cost one worker. Jobs coalesce per window and flush
// as one writer transaction per channel. The root starts it (app.startHub) and
// stops it on shutdown; SendMessage routes through it only while running,
// otherwise resolves and writes inline.
type mentionWorker struct {
	st mentionBatchStore

	queue chan mentionJob

	startOnce sync.Once
	started   atomic.Bool
	stopOnce  sync.Once
	stopped   atomic.Bool
	stop      chan struct{}
	done      chan struct{}
	// flushReq carries flush requests to loop, each answered once its jobs are
	// applied; tests and removal paths use it to avoid waiting out the coalesce window.
	flushReq chan mentionFlushReq

	// dropped counts jobs refused because the queue was full or the worker stopped.
	dropped atomic.Uint64

	// notify delivers one live mention_count frame to a reader whose badge a flush
	// raised. Captured from MessageService.NotifyMentionCount at start-up; nil for a
	// directly-constructed worker or no hub, which skips notification.
	notify func(userID, channelID, count int64)

	// emitMu serializes a mention write with the mention_count frame it emits, so each
	// frame reflects a later commit than the one before. The coalesced flush and a
	// removal path's synchronous reverse both hold it. Without it an increment
	// committed on the worker loop and a decrement on the request goroutine push
	// absolute totals from independent emitters, so a delete inside the coalesce
	// window could be overtaken by an older total and leave the badge stale-low until
	// the next ready. StartMentionWorker points this at MessageService's lock so the
	// inline fallback and removal paths share it.
	emitMu *syncutil.Mutex
}

func newMentionWorker(st mentionBatchStore) *mentionWorker {
	return &mentionWorker{
		st:       st,
		queue:    make(chan mentionJob, mentionQueueSize),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
		flushReq: make(chan mentionFlushReq),
		emitMu:   &syncutil.Mutex{},
	}
}

// run starts the worker's loop. Idempotent.
func (w *mentionWorker) run(ctx context.Context) {
	w.startOnce.Do(func() {
		w.started.Store(true)
		go w.loop(ctx)
	})
}

// enqueue queues a job without blocking: a stopped worker or full queue drops and
// counts it, since the sender must never wait on badge work.
func (w *mentionWorker) enqueue(job mentionJob) {
	if !w.started.Load() || w.stopped.Load() {
		w.dropped.Add(1)
		return
	}
	select {
	case w.queue <- job:
	default:
		w.dropped.Add(1)
	}
}

// stopAndDrain stops the loop, waits for it, then processes anything a racing
// enqueue stranded. It returns after every job is applied or dropped, so the
// caller can close the database.
func (w *mentionWorker) stopAndDrain(ctx context.Context) {
	w.stopOnce.Do(func() {
		w.stopped.Store(true)
		close(w.stop)
	})
	if w.started.Load() {
		<-w.done
	}
	var stranded []mentionJob
	for {
		select {
		case job := <-w.queue:
			stranded = append(stranded, job)
			continue
		default:
		}
		break
	}
	if len(stranded) > 0 {
		w.flush(ctx, stranded)
	}
}

// flushNow applies every job queued before the call, ignoring the coalesce
// window; a barrier for deterministic test reads. Returns once applied.
func (w *mentionWorker) flushNow(ctx context.Context) {
	w.sendFlush(ctx, nil)
}

// flushMessages applies the pending jobs for exactly msgIDs, ignoring the coalesce
// window, and returns once written. A removal path calls it before reversing those
// increments so they stay symmetric: a message deleted inside the window would be
// reversed before its increment lands, and the delayed increment would then raise a
// phantom badge (no guard) or be skipped by the liveness guard and reverse a
// genuine pre-existing badge. Waiting also lets IncrementMentionCountsBatch's
// liveness guard see the message live, so the reversal takes exactly it back.
func (w *mentionWorker) flushMessages(ctx context.Context, msgIDs []int64) {
	if len(msgIDs) == 0 {
		return
	}
	want := make(map[int64]struct{}, len(msgIDs))
	for _, id := range msgIDs {
		want[id] = struct{}{}
	}
	w.sendFlush(ctx, func(job mentionJob) bool {
		_, ok := want[job.msgID]
		return ok
	})
}

// flushChannel applies every pending job for channelID, ignoring the coalesce
// window; PurgeMessages calls it so the messages it purges have increments on disk.
func (w *mentionWorker) flushChannel(ctx context.Context, channelID int64) {
	w.sendFlush(ctx, func(job mentionJob) bool { return job.channelID == channelID })
}

// sendFlush sends one flush request and waits for the answer. nil match is the
// full barrier. It never blocks on a stopped or absent worker.
func (w *mentionWorker) sendFlush(ctx context.Context, match func(mentionJob) bool) {
	reply := make(chan struct{})
	select {
	case w.flushReq <- mentionFlushReq{match: match, reply: reply}:
	case <-w.done:
		return
	case <-ctx.Done():
		return
	}
	select {
	case <-reply:
	case <-w.done:
	case <-ctx.Done():
	}
}

func (w *mentionWorker) loop(ctx context.Context) {
	defer close(w.done)
	tick := time.NewTicker(mentionFlushInterval)
	defer tick.Stop()

	pending := make([]mentionJob, 0, 64)
	for {
		select {
		case <-w.stop:
			w.drain(pending, ctx)
			return
		case <-ctx.Done():
			w.drain(pending, ctx)
			return
		case job := <-w.queue:
			pending = append(pending, job)
		case req := <-w.flushReq:
			// Everything queued before the request is on the channel (its send is
			// synchronous); take it all before flushing.
			for {
				select {
				case job := <-w.queue:
					pending = append(pending, job)
					continue
				default:
				}
				break
			}
			if req.match == nil {
				w.flush(ctx, pending)
				pending = pending[:0]
			} else {
				pending = w.flushSelected(ctx, pending, req.match)
			}
			close(req.reply)
		case now := <-tick.C:
			pending = w.sweep(pending, now, ctx)
		}
	}
}

// drain flushes every queued and pending job on shutdown, ignoring the window so
// no badge is lost.
func (w *mentionWorker) drain(pending []mentionJob, ctx context.Context) {
	for {
		select {
		case job := <-w.queue:
			pending = append(pending, job)
			continue
		default:
		}
		break
	}
	w.flush(ctx, pending)
}

// sweep flushes jobs whose coalesce window elapsed and keeps the rest.
func (w *mentionWorker) sweep(pending []mentionJob, now time.Time, ctx context.Context) []mentionJob {
	kept := pending[:0]
	var ready []mentionJob
	for _, job := range pending {
		if now.Sub(job.enqueueAt) >= mentionJobCoalesceWindow {
			ready = append(ready, job)
			continue
		}
		kept = append(kept, job)
	}
	if len(ready) > 0 {
		w.flush(ctx, ready)
	}
	return kept
}

// flushSelected applies the pending jobs match accepts and returns the rest in
// order, without disturbing other jobs' windows.
func (w *mentionWorker) flushSelected(ctx context.Context, pending []mentionJob, match func(mentionJob) bool) []mentionJob {
	kept := pending[:0]
	var ready []mentionJob
	for _, job := range pending {
		if match(job) {
			ready = append(ready, job)
			continue
		}
		kept = append(kept, job)
	}
	if len(ready) > 0 {
		w.flush(ctx, ready)
	}
	return kept
}

// flush resolves every job's recipients and writes one transaction per channel. A
// job whose apply returns no entries still counts as flushed. After a channel's
// transaction commits, each reader whose badge it raised gets one live
// mention_count frame, outside the transaction so a push never outruns its write.
func (w *mentionWorker) flush(ctx context.Context, jobs []mentionJob) {
	if len(jobs) == 0 {
		return
	}
	byChannel := make(map[int64][]db.MentionBatchEntry, 1)
	for _, job := range jobs {
		entries := job.apply(ctx)
		if len(entries) == 0 {
			continue
		}
		byChannel[job.channelID] = append(byChannel[job.channelID], entries...)
	}
	for channelID, entries := range byChannel {
		// Hold emitMu across the write and its frames so commit order matches frame order
		// against a concurrent removal decrement (see emitMu).
		w.emitMu.Lock()
		bumped, err := w.st.IncrementMentionCountsBatch(ctx, channelID, entries)
		if err != nil {
			w.emitMu.Unlock()
			slog.Error("mention worker: flush IncrementMentionCountsBatch", "err", err, "channel_id", channelID)
			continue
		}
		w.notifyBumped(channelID, bumped)
		w.emitMu.Unlock()
	}
}

// notifyBumped pushes one mention_count frame per reader whose badge the flush
// raised; a nil notifier is a no-op.
func (w *mentionWorker) notifyBumped(channelID int64, bumped map[int64]int64) {
	emitMentionBumped(w.notify, channelID, bumped)
}

// emitMentionBumped pushes one frame per bumped reader in sorted order so tests'
// recorded calls do not depend on map order. A nil n is a no-op.
func emitMentionBumped(n func(userID, channelID, count int64), channelID int64, bumped map[int64]int64) {
	if n == nil || len(bumped) == 0 {
		return
	}
	userIDs := make([]int64, 0, len(bumped))
	for uid := range bumped {
		userIDs = append(userIDs, uid)
	}
	slices.Sort(userIDs)
	for _, uid := range userIDs {
		n(uid, channelID, bumped[uid])
	}
}
