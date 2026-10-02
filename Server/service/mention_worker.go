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

// mentionQueueSize bounds the mention worker's pending jobs. Under a mention
// storm past this many un-flushed jobs, later jobs are dropped and counted
// rather than growing the queue or blocking the sender: mention badges are
// cosmetic and a message send must never wait on badge bookkeeping.
const mentionQueueSize = 4096

// mentionFlushInterval is how often the worker checks pending jobs for the
// coalesce window. It only bounds flush latency, not throughput.
const mentionFlushInterval = 50 * time.Millisecond

// mentionJobCoalesceWindow delays a job's write so many messages sent close
// together share one writer transaction. A single @everyone at 2,000 members
// used to be its own 2,000-row writer transaction; a 5% @here burst now costs
// at most about one transaction per window instead of one per message.
const mentionJobCoalesceWindow = 250 * time.Millisecond

// mentionJob is one message's deferred mention-badge work. enqueueAt starts
// its coalesce window; channelID groups jobs that can share one transaction;
// msgID lets a removal path flush exactly this message's job before it
// reverses that message's increments (flushMessages); apply resolves the
// recipients at flush time (so the block and visibility filters are evaluated
// then, and the read-state guard still sees reads that landed after the send)
// and returns one batch entry per message.
type mentionJob struct {
	enqueueAt time.Time
	channelID int64
	msgID     int64
	apply     func(ctx context.Context) []db.MentionBatchEntry
}

// mentionFlushReq is a flush request handled on the worker loop. match selects
// the pending jobs to apply now; nil selects all of them (the full barrier:
// tests and shutdown). A removal path passes a narrower match so it flushes
// exactly the messages it is about to reverse and leaves the rest in their
// coalesce window. reply is closed once the matching jobs have been applied.
type mentionFlushReq struct {
	match func(mentionJob) bool
	reply chan struct{}
}

// mentionWorker is the single background worker that owns every mention-badge
// written while it is running (P5-O05). MessageService.SendMessage no longer
// fires a goroutine per send; it enqueues here, so 100 concurrent @everyone
// sends cost one worker instead of 100 goroutines. Jobs coalesce per window
// and flush as one writer transaction per channel. The composition root starts
// it (app.startHub) and stops it on shutdown; SendMessage only routes through
// it while it is running, and otherwise resolves and writes inline.
type mentionWorker struct {
	st Store

	queue chan mentionJob

	startOnce sync.Once
	started   atomic.Bool
	stopOnce  sync.Once
	stopped   atomic.Bool
	stop      chan struct{}
	done      chan struct{}
	// flushReq carries flush requests to loop: each is answered once the jobs
	// it selects have been applied. Tests and the removal paths use it to read
	// or establish counts without waiting out the coalesce window.
	flushReq chan mentionFlushReq

	// dropped counts jobs refused because the queue was full or the worker had
	// stopped. Cosmetic badge work is dropped rather than blocking a send.
	dropped atomic.Uint64

	// notify delivers one live mention_count frame to a reader whose badge a
	// flush raised (DP-27). Captured from MessageService.NotifyMentionCount at
	// start-up (the hook is installed before StartMentionWorker runs); nil in
	// a directly-constructed worker and whenever no hub is wired, in which
	// case notification is skipped.
	notify func(userID, channelID, count int64)
}

func newMentionWorker(st Store) *mentionWorker {
	return &mentionWorker{
		st:       st,
		queue:    make(chan mentionJob, mentionQueueSize),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
		flushReq: make(chan mentionFlushReq),
	}
}

// run starts the worker's loop. Idempotent.
func (w *mentionWorker) run(ctx context.Context) {
	w.startOnce.Do(func() {
		w.started.Store(true)
		go w.loop(ctx)
	})
}

// enqueue queues a job. Non-blocking: a stopped worker or a full queue drops
// the job and counts it, because the sender must never wait on badge work.
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

// stopAndDrain stops the loop, waits for it to exit, then processes anything a
// racing enqueue stranded in the queue. It returns only after every job has
// been applied (or dropped), so the caller can close the database safely.
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
// window — a barrier so a test can read counts deterministically. It returns
// once the loop has applied them.
func (w *mentionWorker) flushNow(ctx context.Context) {
	w.sendFlush(ctx, nil)
}

// flushMessages applies the pending jobs for exactly msgIDs, ignoring the
// coalesce window, and returns once they are written. A removal path calls it
// before it reverses those messages' increments, so the increment and its
// reversal stay symmetric: without it, a message deleted inside the coalesce
// window is reversed before its increment lands, and the delayed increment
// then either raises a phantom badge (no guard) or is skipped by the liveness
// guard and silently reverses a pre-existing genuine badge (this fix's
// predecessor). Waiting here also means IncrementMentionCountsBatch' liveness
// guard sees the message still live, so the increment lands and the reversal
// takes exactly it back.
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
// window, and returns once they are written. PurgeMessages calls it before its
// reversal so the messages it is about to purge have their increments on disk.
func (w *mentionWorker) flushChannel(ctx context.Context, channelID int64) {
	w.sendFlush(ctx, func(job mentionJob) bool { return job.channelID == channelID })
}

// sendFlush sends one flush request to the loop and waits for it to be
// answered. A nil match is the full barrier; a non-nil match flushes only the
// jobs it selects. It never blocks on a stopped or absent worker.
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
			// Everything queued before the request is on the channel (its send
			// is synchronous); take it all before flushing.
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

// drain flushes every queued and pending job on shutdown, ignoring the
// coalesce window so no badge is lost to the timer.
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

// sweep flushes the jobs whose coalesce window has elapsed and keeps the rest.
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

// flushSelected applies the pending jobs match accepts and returns the rest,
// preserving their order. A removal path uses it to flush exactly the messages
// it is about to reverse without disturbing the other jobs' coalesce windows.
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

// flush resolves every job's recipients and writes them as one transaction per
// channel. A job whose apply returns no entries still counts as flushed: it
// simply had no recipients by the time the filters ran.
//
// After a channel's transaction commits, each reader whose badge it actually
// raised gets one live mention_count frame (DP-27), so an unfocused channel's
// taskbar/tray badge updates without waiting for the next ready. The
// notification runs outside the transaction and after it commits, so a push
// can never outrun the write it describes.
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
		bumped, err := w.st.IncrementMentionCountsBatch(ctx, channelID, entries)
		if err != nil {
			slog.Error("mention worker: flush IncrementMentionCountsBatch", "err", err, "channel_id", channelID)
			continue
		}
		w.notifyBumped(channelID, bumped)
	}
}

// notifyBumped pushes one mention_count frame per reader whose badge the
// flush raised. A nil notifier (no hub, every test) is a no-op.
func (w *mentionWorker) notifyBumped(channelID int64, bumped map[int64]int64) {
	emitMentionBumped(w.notify, channelID, bumped)
}

// emitMentionBumped pushes one mention_count frame per reader whose badge a
// flush raised (DP-27), in a deterministic order so a test's recorded calls do
// not depend on map iteration order. A nil n (no hub) is a no-op.
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
