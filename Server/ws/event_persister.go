// EventPersister is an asynchronous batched writer that drains broadcast events
// from an in-memory channel into the EventStore. It must never block the broadcast
// hot path: when the queue is full events are dropped and a counter incremented.
// Reconnection tolerates gaps because the in-memory ring buffer stays the primary
// source for clients whose last_seq is recent.

package ws

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// pendingEvent is an event waiting to flush. seq is the hub-assigned sequence, so
// the stored row has the same seq as the payload sent to clients.
type pendingEvent struct {
	seq       int64
	eventType string
	channelID int64
	payload   []byte
}

// EventPersister batches broadcast events and writes them to an EventStore.
type EventPersister struct {
	store      EventStore
	queue      chan pendingEvent
	batchSize  int
	flushEvery time.Duration

	startOnce sync.Once
	started   atomic.Bool
	stopOnce  sync.Once
	stop      chan struct{}
	done      chan struct{}
	// flushReq carries Flush's barrier requests to run(); each is answered once
	// everything queued before it has been written.
	flushReq chan chan struct{}
	// stopCtxDone is the Done channel of the context passed to Stop. run's drain loop
	// reads it only after observing stop closed; the close/receive pair gives the
	// happens-before, so no lock. nil (an uncancellable ctx) means drain fully.
	stopCtxDone <-chan struct{}

	persisted atomic.Uint64
	dropped   atomic.Uint64
	flushes   atomic.Uint64
	errors    atomic.Uint64
}

// NewEventPersister returns a persister wired to s. s MUST be non-nil: run()
// dereferences p.store on every flush, so fail fast at construction rather than
// minutes later in the background goroutine. queueSize sets the channel buffer;
// once full, Enqueue counts a drop without blocking. batchSize and flushEvery
// control the flush triggers.
func NewEventPersister(s EventStore, queueSize, batchSize int, flushEvery time.Duration) *EventPersister {
	if s == nil {
		panic("ws: NewEventPersister requires a non-nil EventStore")
	}
	if queueSize <= 0 {
		queueSize = 1024
	}
	if batchSize <= 0 {
		batchSize = 50
	}
	if flushEvery <= 0 {
		flushEvery = 100 * time.Millisecond
	}
	return &EventPersister{
		store:      s,
		queue:      make(chan pendingEvent, queueSize),
		batchSize:  batchSize,
		flushEvery: flushEvery,
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
		flushReq:   make(chan chan struct{}),
	}
}

// Flush is a barrier: it returns once every event enqueued before the call has
// been written (or dropped by a failed write, logged as usual). Enqueue's send is
// synchronous into the FIFO queue, so draining it first gives the guarantee. A
// persister that is not running or has stopped returns immediately (a stopped one
// already drained). Bounded by ctx. Account erasure calls it before deleting an
// erased user's rows so a frame queued before the erasure cannot be written back.
func (p *EventPersister) Flush(ctx context.Context) error {
	if p == nil || !p.started.Load() {
		return nil
	}
	reply := make(chan struct{})
	select {
	case p.flushReq <- reply:
	case <-p.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-reply:
		return nil
	case <-p.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Start launches the background flusher. Idempotent, so test setups sharing a
// persister do not spawn duplicate runners.
func (p *EventPersister) Start(ctx context.Context) {
	p.startOnce.Do(func() {
		p.started.Store(true)
		go p.run(ctx)
	})
}

// Enqueue queues an event for persistence. Non-blocking; drops on a full queue.
// seq must be the value embedded in the wrapped payload so replay returns rows
// whose row-seq matches the payload-seq the client tracks.
//
// CONTRACT: payload must not be mutated by the caller after Enqueue returns. Call
// sites pass a fresh slice from wrapWithSeq, so no defensive copy is taken:
// Enqueue runs under the hub's seqMu and any per-call allocation serializes
// broadcast throughput.
//
// Connect and disconnect presence frames are persisted like any global broadcast:
// cold-tier replay requires every seq in its range to be persisted
// (reconnectVetColdTail's contiguity check), so unpersisted presence would force a
// full ready on almost every cold resume.
func (p *EventPersister) Enqueue(seq int64, eventType string, channelID int64, payload []byte) {
	if p == nil {
		return
	}
	// run() stops reading p.queue when it exits but the channel keeps accepting
	// sends; without this check a caller enqueueing after Stop (e.g. GracefulStop
	// broadcasting server_restart after main.go's LIFO defers stopped this persister)
	// would land silently in a dead channel, neither persisted nor counted. p.done
	// closes only when run() has exited, so this is exact.
	select {
	case <-p.done:
		p.dropStopped(seq, eventType, channelID)
		return
	default:
	}
	select {
	case p.queue <- pendingEvent{seq: seq, eventType: eventType, channelID: channelID, payload: payload}:
	default:
		p.dropped.Add(1)
		// The WSEventsDropped OTel counter is synced from this atomic by run()'s ticker
		// (which has a real context); an instrumentation call here would sit under the
		// caller's seqMu and trip contextcheck.
	}
}

// Stop signals the persister to drain and exit, returning only after run has fully
// exited (no longer touching the store). Load-bearing: main.go closes the database
// right after Stop (LIFO defers), so no flush may be in flight or it writes into a
// closed pool and loses events. ctx does not abandon that wait; it only bounds how
// long run() keeps draining before one final flush and exit, so a stuck flush
// delays shutdown by at most that flush. Safe without a prior Start: there is no
// goroutine to wait for.
func (p *EventPersister) Stop(ctx context.Context) {
	if p == nil {
		return
	}
	p.stopOnce.Do(func() {
		// Published before close(p.stop): run() reads stopCtxDone only after observing the
		// close, which makes this write visible without a data race.
		p.stopCtxDone = ctx.Done()
		close(p.stop)
	})
	if !p.started.Load() {
		// run() was never launched, so done will never close.
		return
	}
	// Always wait for the goroutine to exit; never race it against ctx.
	<-p.done

	// A concurrent Enqueue can win the race between run()'s last drain and the close
	// of p.done: it sees p.done open and sends as run() exits, so nothing reads that
	// entry. Sweep what the race stranded so it is dropped loudly, not silently
	// (mirrors db.AuditWriter.Stop).
	for {
		select {
		case evt := <-p.queue:
			p.dropStopped(evt.seq, evt.eventType, evt.channelID)
		default:
			return
		}
	}
}

// dropStopped counts and logs an event that reached the queue after run() exited.
func (p *EventPersister) dropStopped(seq int64, eventType string, channelID int64) {
	p.dropped.Add(1)
	slog.Error("event dropped: persister stopped",
		"seq", seq,
		"event_type", eventType,
		"channel_id", channelID,
	)
}

// drainQueued appends every event already in the queue to batch without blocking.
// A barrier drain can exceed batchSize; PersistEvents takes any size in one transaction.
func (p *EventPersister) drainQueued(batch []pendingEvent) []pendingEvent {
	for {
		select {
		case evt := <-p.queue:
			batch = append(batch, evt)
		default:
			return batch
		}
	}
}

func (p *EventPersister) Stats() (persisted, dropped, flushes, errs uint64) {
	return p.persisted.Load(), p.dropped.Load(), p.flushes.Load(), p.errors.Load()
}

func (p *EventPersister) run(ctx context.Context) {
	defer close(p.done)
	tick := time.NewTicker(p.flushEvery)
	defer tick.Stop()

	// Cache the AppMetrics bundle instead of looking it up per event.
	metrics := telemetry.NewAppMetrics()

	// Enqueue only bumps the p.dropped atomic (under seqMu, no context); this loop
	// syncs the OTel counter from it.
	var droppedReported uint64
	syncDropped := func() {
		if d := p.dropped.Load(); d > droppedReported {
			metrics.WSEventsDropped.Add(ctx, int64(d-droppedReported)) //nolint:gosec // monotonic counter delta
			droppedReported = d
		}
	}

	batch := make([]pendingEvent, 0, p.batchSize)
	rows := make([]db.PersistedEvent, 0, p.batchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		p.flushes.Add(1)
		rows = rows[:0]
		for _, evt := range batch {
			rows = append(rows, db.PersistedEvent{
				Seq:       evt.seq,
				EventType: evt.eventType,
				ChannelID: evt.channelID,
				Payload:   evt.payload,
			})
		}
		// One transaction per flush. PersistEvents is best-effort: on tx failure it
		// retries per-row so one bad event does not drop the batch.
		persisted, err := p.store.PersistEvents(ctx, rows)
		if persisted > 0 {
			p.persisted.Add(uint64(persisted))
			metrics.WSEventsPersisted.Add(ctx, int64(persisted))
		}
		if failed := len(batch) - persisted; failed > 0 {
			p.errors.Add(uint64(failed)) //nolint:gosec // failed is non-negative
			metrics.WSEventsPersistErrors.Add(ctx, int64(failed))
			slog.Warn("event persister: flush lost events",
				"failed", failed, "batch", len(batch), "err", err)
		}
		batch = batch[:0]
	}

	for {
		select {
		case <-p.stop:
			// Drain what is still in the channel before exiting, bounded by the Stop context
			// (p.stopCtxDone): once it fires, do one final flush and exit, so a slow store
			// delays shutdown by at most one flush. The goroutine finishes any in-flight flush
			// before closing p.done, so Stop's caller never closes the store under a live flusher.
			for {
				select {
				case evt := <-p.queue:
					batch = append(batch, evt)
					if len(batch) >= p.batchSize {
						flush()
					}
				case <-p.stopCtxDone:
					flush()
					return
				default:
					flush()
					return
				}
			}
		case <-ctx.Done():
			flush()
			return
		case evt := <-p.queue:
			batch = append(batch, evt)
			if len(batch) >= p.batchSize {
				flush()
			}
		case reply := <-p.flushReq:
			// Everything sent before the request is already queued; take it all, write it, answer.
			batch = p.drainQueued(batch)
			flush()
			close(reply)
		case <-tick.C:
			flush()
			syncDropped()
		}
	}
}
