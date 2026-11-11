// EventPersister is an asynchronous batched writer that drains broadcast events
// into the EventStore. It never blocks the broadcast hot path: a full queue drops
// events and bumps a counter. Reconnection tolerates gaps because the in-memory
// ring stays primary for recent last_seq.

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
	flushReq  chan chan struct{}
	// stopCtxDone is the Done channel of Stop's context. run's drain reads it
	// only after observing stop closed; that close/receive pair is the happens-
	// before, so no lock. nil means drain fully.
	stopCtxDone <-chan struct{}

	persisted atomic.Uint64
	dropped   atomic.Uint64
	flushes   atomic.Uint64
	errors    atomic.Uint64
}

// NewEventPersister returns a persister wired to s, which MUST be non-nil (run
// dereferences it on every flush; fail fast here). A full queue makes Enqueue
// count a drop without blocking.
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

// Flush is a barrier: it returns once every event enqueued before the call is
// written (or dropped by a failed write). A persister not running or stopped
// returns immediately. Bounded by ctx. Account erasure calls it before deleting a
// user's rows so a queued frame cannot be written back.
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

// Start launches the background flusher; idempotent.
func (p *EventPersister) Start(ctx context.Context) {
	p.startOnce.Do(func() {
		p.started.Store(true)
		go p.run(ctx)
	})
}

// Enqueue queues an event without blocking, dropping on a full queue. seq must be
// the value embedded in the payload so replayed row-seq matches the client's
// payload-seq.
// CONTRACT: the caller must not mutate payload after Enqueue returns. Enqueue
// runs under the hub's seqMu, where a defensive copy would serialize broadcast
// throughput.
// Presence frames are persisted like any global broadcast: cold-tier replay needs
// every seq in its range persisted (reconnectVetColdTail), or most cold resumes
// would take a full ready.
func (p *EventPersister) Enqueue(seq int64, eventType string, channelID int64, payload []byte) {
	if p == nil {
		return
	}
	// run() stops reading p.queue on exit but the channel keeps accepting sends;
	// without this check an Enqueue after Stop (e.g. GracefulStop's
	// server_restart after main.go's LIFO defers) would vanish uncounted. p.done
	// closes only after run exits, so this is exact.
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
		// The WSEventsDropped counter is synced from this atomic in run()'s
		// ticker; instrumenting here would sit under the caller's seqMu and trip
		// contextcheck.
	}
}

// Stop signals drain and exit, returning only after run has exited. Load-bearing:
// main.go closes the database right after Stop, so no flush may be in flight or
// it writes into a closed pool and loses events. ctx bounds only how long run
// keeps draining before one final flush, not the wait. Safe without a prior
// Start.
func (p *EventPersister) Stop(ctx context.Context) {
	if p == nil {
		return
	}
	p.stopOnce.Do(func() {
		// Published before close(p.stop): run() reads it only after observing the
		// close, so no data race.
		p.stopCtxDone = ctx.Done()
		close(p.stop)
	})
	if !p.started.Load() {
		// run() never launched, so done will never close.
		return
	}
	// Always wait for the goroutine; never race it against ctx.
	<-p.done

	// An Enqueue can win the race between run()'s last drain and the close of
	// p.done, stranding an entry nothing reads; sweep it so it is dropped loudly
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

func (p *EventPersister) dropStopped(seq int64, eventType string, channelID int64) {
	p.dropped.Add(1)
	slog.Error("event dropped: persister stopped",
		"seq", seq,
		"event_type", eventType,
		"channel_id", channelID,
	)
}

// drainQueued appends every queued event to batch without blocking; a barrier
// drain can exceed batchSize, which PersistEvents accepts in one transaction.
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

const persisterFinalFlushTimeout = 2 * time.Second

func (p *EventPersister) run(ctx context.Context) {
	defer close(p.done)
	tick := time.NewTicker(p.flushEvery)
	defer tick.Stop()

	metrics := telemetry.NewAppMetrics()

	// Enqueue only bumps the p.dropped atomic (under seqMu, no context); this
	// loop syncs the OTel counter from it.
	var droppedReported uint64
	syncDropped := func() {
		if d := p.dropped.Load(); d > droppedReported {
			metrics.WSEventsDropped.Add(ctx, int64(d-droppedReported)) //nolint:gosec // monotonic counter delta
			droppedReported = d
		}
	}

	batch := make([]pendingEvent, 0, p.batchSize)
	rows := make([]db.PersistedEvent, 0, p.batchSize)
	// flushWith writes the batch on fctx. The final flush after the owner context
	// ends uses a detached, bounded one because a cancelled context makes the
	// store reject the statement.
	flushWith := func(fctx context.Context) {
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
		// One transaction per flush; PersistEvents retries per-row on tx failure
		// so one bad event does not drop the batch.
		persisted, err := p.store.PersistEvents(fctx, rows)
		if persisted > 0 {
			p.persisted.Add(uint64(persisted))
			metrics.WSEventsPersisted.Add(fctx, int64(persisted))
		}
		if failed := len(batch) - persisted; failed > 0 {
			p.errors.Add(uint64(failed)) //nolint:gosec // failed is non-negative
			metrics.WSEventsPersistErrors.Add(fctx, int64(failed))
			slog.Warn("event persister: flush lost events",
				"failed", failed, "batch", len(batch), "err", err)
		}
		batch = batch[:0]
	}
	flush := func() { flushWith(ctx) }

	for {
		select {
		case <-p.stop:
			// Drain what is still queued before exiting, bounded by the Stop
			// context: once it fires, do one final flush and exit. run finishes
			// any in-flight flush before closing p.done, so Stop's caller never
			// closes the store under a live flusher.
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
			// The owner went away with events still queued: write them on a
			// context that outlives the cancellation, bounded so shutdown stays
			// short.
			fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), persisterFinalFlushTimeout)
			batch = p.drainQueued(batch)
			flushWith(fctx)
			cancel()
			return
		case evt := <-p.queue:
			batch = append(batch, evt)
			if len(batch) >= p.batchSize {
				flush()
			}
		case reply := <-p.flushReq:
			batch = p.drainQueued(batch)
			flush()
			close(reply)
		case <-tick.C:
			flush()
			syncDropped()
		}
	}
}
