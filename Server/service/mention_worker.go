package service

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// mentionQueueSize bounds pending jobs. Past it, later jobs are dropped and counted:
// badges are cosmetic and a send must never wait on badge bookkeeping.
const mentionQueueSize = 4096

// mentionFlushInterval is how often the worker checks the coalesce window; it bounds latency, not throughput.
const mentionFlushInterval = 50 * time.Millisecond

// mentionJobCoalesceWindow delays a job's write so messages sent close together share one
// writer transaction (a 2,000-member @everyone was its own 2,000-row transaction).
const mentionJobCoalesceWindow = 250 * time.Millisecond

// mentionJob is one message's deferred badge work: enqueueAt starts its coalesce window,
// channelID groups jobs sharing a transaction, msgID lets a removal flush exactly this
// job, apply resolves recipients at flush time (so guards see post-send state).
type mentionJob struct {
	enqueueAt time.Time
	channelID int64
	msgID     int64
	apply     func(ctx context.Context) []db.MentionBatchEntry
}

type mentionFlushReq struct {
	match func(mentionJob) bool
	reply chan struct{}
}

type mentionBatchStore interface {
	// IncrementMentionCountsBatch applies a coalesced window of mention jobs in one writer
	// transaction and returns userID to mention_count for exactly the recipients whose
	// read-state guard admitted the bump (the live-badge signal).
	IncrementMentionCountsBatch(ctx context.Context, channelID int64, entries []db.MentionBatchEntry) (map[int64]int64, error)
}

// mentionWorker is the single background worker owning every mention badge write while
// running, so 100 concurrent @everyone sends cost one worker. Jobs flush as one writer
// transaction per channel per window. SendMessage routes through it only while running.
type mentionWorker struct {
	st mentionBatchStore

	queue chan mentionJob

	startOnce sync.Once
	started   atomic.Bool
	stopOnce  sync.Once
	stopped   atomic.Bool
	stop      chan struct{}
	done      chan struct{}
	// flushReq carries flush requests to loop, each answered once applied; tests and removal paths use it to
	// skip the coalesce window.
	flushReq chan mentionFlushReq

	dropped atomic.Uint64

	// prepare resolves which of a flush's recipients may get a live frame and returns the
	// sender, before the channel's emit lock is taken. Nil for a directly-constructed worker or no hub.
	prepare mentionSendPrep

	// emitLocks serializes a mention write with its mention_count frames, per channel, so each
	// frame reflects a later commit than the one before. The coalesced flush and a removal's
	// synchronous reverse both hold it; otherwise a delete inside the window could be
	// overtaken by an older total, leaving the badge stale-low until the next ready.
	// StartMentionWorker points this at mentionState's locks.
	emitLocks *mentionEmitLocks
}

func newMentionWorker(st mentionBatchStore) *mentionWorker {
	return &mentionWorker{
		st:        st,
		queue:     make(chan mentionJob, mentionQueueSize),
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
		flushReq:  make(chan mentionFlushReq),
		emitLocks: &mentionEmitLocks{},
	}
}

func (w *mentionWorker) run(ctx context.Context) {
	w.startOnce.Do(func() {
		w.started.Store(true)
		go w.loop(ctx)
	})
}

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

// stopAndDrain stops the loop, waits, then processes anything a racing enqueue stranded;
// returns after every job is applied or dropped so the caller can close the database.
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

func (w *mentionWorker) flushNow(ctx context.Context) {
	w.sendFlush(ctx, nil)
}

// flushMessages applies the pending jobs for exactly msgIDs, ignoring the window, and
// returns once written. A removal calls it before reversing so they stay symmetric: a
// message deleted inside the window would be reversed before its increment lands, and the
// delayed increment would raise a phantom badge or, skipped by the liveness guard,
// reverse a genuine one.
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

func (w *mentionWorker) flushChannel(ctx context.Context, channelID int64) {
	w.sendFlush(ctx, func(job mentionJob) bool { return job.channelID == channelID })
}

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

// flush resolves every job's recipients and writes one transaction per channel; a job
// whose apply returns no entries still counts as flushed. After commit each raised reader
// gets one live frame, outside the transaction so a push never outruns its write.
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
		w.flushChannelEntries(ctx, channelID, entries)
	}
}

// flushChannelEntries writes one channel's entries and pushes their frames. The audience
// is resolved outside the lock; the emit lock covers only the write and frame enqueue, so
// commit order matches frame order against a concurrent decrement or read-pointer move.
func (w *mentionWorker) flushChannelEntries(ctx context.Context, channelID int64, entries []db.MentionBatchEntry) {
	var send func(userID, count int64)
	if w.prepare != nil {
		send = w.prepare(ctx, channelID, entryUserIDs(entries))
	}
	mu := w.emitLocks.forChannel(channelID)
	mu.Lock()
	defer mu.Unlock()
	bumped, err := w.st.IncrementMentionCountsBatch(ctx, channelID, entries)
	if err != nil {
		slog.Error("mention worker: flush IncrementMentionCountsBatch", "err", err, "channel_id", channelID)
		return
	}
	emitMentionBumped(send, bumped)
}

func entryUserIDs(entries []db.MentionBatchEntry) []int64 {
	n := 0
	for _, e := range entries {
		n += len(e.UserIDs)
	}
	ids := make([]int64, 0, n)
	for _, e := range entries {
		ids = append(ids, e.UserIDs...)
	}
	slices.Sort(ids)
	return slices.Compact(ids)
}

func bumpedUserIDs(bumped map[int64]int64) []int64 {
	ids := make([]int64, 0, len(bumped))
	for uid := range bumped {
		ids = append(ids, uid)
	}
	slices.Sort(ids)
	return ids
}

func emitMentionBumped(send func(userID, count int64), bumped map[int64]int64) {
	if send == nil || len(bumped) == 0 {
		return
	}
	for _, uid := range bumpedUserIDs(bumped) {
		send(uid, bumped[uid])
	}
}
