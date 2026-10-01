package service

import (
	"context"
	"log/slog"
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
// apply resolves the recipients at flush time (so the block and visibility
// filters are evaluated then, and the read-state guard still sees reads that
// landed after the send) and returns one batch entry per message.
type mentionJob struct {
	enqueueAt time.Time
	channelID int64
	apply     func(ctx context.Context) []db.MentionBatchEntry
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
	// flushReq carries FlushNow's barrier requests to loop: each is answered
	// once every job queued before it has been applied. Tests use it to read
	// counts deterministically without waiting out the coalesce window.
	flushReq chan chan struct{}

	// dropped counts jobs refused because the queue was full or the worker had
	// stopped. Cosmetic badge work is dropped rather than blocking a send.
	dropped atomic.Uint64
}

func newMentionWorker(st Store) *mentionWorker {
	return &mentionWorker{
		st:       st,
		queue:    make(chan mentionJob, mentionQueueSize),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
		flushReq: make(chan chan struct{}),
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
	reply := make(chan struct{})
	select {
	case w.flushReq <- reply:
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
		case reply := <-w.flushReq:
			// Everything queued before the request is on the channel (its send
			// is synchronous); take it all, flush both it and any window-aged
			// pending job, then answer.
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
			pending = pending[:0]
			close(reply)
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

// flush resolves every job's recipients and writes them as one transaction per
// channel. A job whose apply returns no entries still counts as flushed: it
// simply had no recipients by the time the filters ran.
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
		if err := w.st.IncrementMentionCountsBatch(ctx, channelID, entries); err != nil {
			slog.Error("mention worker: flush IncrementMentionCountsBatch", "err", err, "channel_id", channelID)
		}
	}
}
