// Phase B Step 7 — Event Persistence Layer.
//
// EventPersister is an asynchronous batched writer that drains broadcast
// events from an in-memory channel into the EventStore. It must never block
// the broadcast hot path: when the queue is full, events are dropped and a
// counter is incremented. The reconnection handler tolerates gaps because the
// in-memory ring buffer remains the primary cold-start source for clients
// whose last_seq is recent.

package ws

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/telemetry"
)

// pendingEvent is a single event waiting to be flushed to the EventStore.
// seq carries the hub-assigned monotonic sequence so the row written to the
// store has the same seq as the wrapped payload sent to clients.
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
	// stopCtxDone is the Done channel of the context passed to Stop. run's
	// drain-on-stop loop reads it only after observing stop closed — the
	// close/receive pair provides the happens-before, so there is no data
	// race and no lock. A nil value (an uncancellable Stop ctx, e.g.
	// context.Background) means "drain fully".
	stopCtxDone <-chan struct{}

	persisted atomic.Uint64
	dropped   atomic.Uint64
	flushes   atomic.Uint64
	errors    atomic.Uint64
}

// NewEventPersister returns a persister wired to s. s MUST be non-nil —
// run() dereferences p.store on every flush, so a nil store would panic on
// the first tick. We fail fast here so the misconfiguration surfaces at
// construction time (main.go, tests) instead of minutes later in the
// background goroutine.
//
// queueSize sets the channel buffer; once full, Enqueue increments the
// dropped counter without blocking. batchSize and flushEvery control the
// flush triggers.
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
	}
}

// Start launches the background flusher goroutine. Idempotent — calling
// Start more than once is a no-op so test setups that share a persister
// across cases don't spawn duplicate runners.
func (p *EventPersister) Start(ctx context.Context) {
	p.startOnce.Do(func() {
		p.started.Store(true)
		go p.run(ctx)
	})
}

// Enqueue queues an event for persistence. Non-blocking; drops on full queue.
// seq is the hub-assigned monotonic sequence for this event — it must be the
// same value embedded in the wrapped payload so reconnect replay returns rows
// whose row-seq matches the payload-seq the client tracks.
//
// CONTRACT: payload must not be mutated by the caller after Enqueue returns.
// All current call sites pass a fresh slice from wrapWithSeq, so no defensive
// copy is taken here. This matters because Enqueue is invoked under the hub's
// seqMu lock and any per-call allocation directly serializes broadcast
// throughput.
func (p *EventPersister) Enqueue(seq int64, eventType string, channelID int64, payload []byte) {
	if p == nil {
		return
	}
	select {
	case p.queue <- pendingEvent{seq: seq, eventType: eventType, channelID: channelID, payload: payload}:
	default:
		p.dropped.Add(1)
		// The WSEventsDropped OTel counter is synced from this atomic by
		// run()'s ticker (which has a real context) — an instrumentation call
		// here would sit under the caller's seqMu and trip contextcheck.
	}
}

// Stop signals the persister to drain remaining events and exit, and returns
// only after the run goroutine has fully exited (i.e. has stopped touching
// the store). This is the load-bearing contract: main.go closes the database
// right after Stop returns (LIFO defers), so Stop must guarantee no flush is
// still in flight — otherwise a late flush writes into a closed pool and
// events are lost. ctx does NOT abandon that wait; it only bounds how long
// run() keeps draining the queue before it stops accepting new entries, does
// one final flush, and exits (see run). A single stuck flush therefore
// delays shutdown by at most that flush rather than closing the DB
// underneath it.
//
// Safe to call without a prior Start: in that case there's no goroutine to
// wait for and Stop returns immediately after closing the stop channel.
func (p *EventPersister) Stop(ctx context.Context) {
	if p == nil {
		return
	}
	p.stopOnce.Do(func() {
		// Published before close(p.stop): run() reads stopCtxDone only after
		// its receive on p.stop observes the close, and the close/receive
		// pair makes this write visible without a data race.
		p.stopCtxDone = ctx.Done()
		close(p.stop)
	})
	if !p.started.Load() {
		// run() was never launched, so done will never be closed.
		return
	}
	// Always wait for the goroutine to exit — never race it against ctx.
	<-p.done
}

// Stats returns lifetime counters.
func (p *EventPersister) Stats() (persisted, dropped, flushes, errs uint64) {
	return p.persisted.Load(), p.dropped.Load(), p.flushes.Load(), p.errors.Load()
}

func (p *EventPersister) run(ctx context.Context) {
	defer close(p.done)
	tick := time.NewTicker(p.flushEvery)
	defer tick.Stop()

	// Cache the AppMetrics bundle once instead of looking it up per event.
	metrics := telemetry.NewAppMetrics()

	// Enqueue only bumps the p.dropped atomic (it runs under the hub's seqMu
	// with no context); this loop owns syncing the OTel counter from it.
	var droppedReported uint64
	syncDropped := func() {
		if d := p.dropped.Load(); d > droppedReported {
			metrics.WSEventsDropped.Add(ctx, int64(d-droppedReported)) //nolint:gosec // monotonic counter delta
			droppedReported = d
		}
	}

	batch := make([]pendingEvent, 0, p.batchSize)
	// Scratch slice reused across flushes for the store's batch shape.
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
		// One transaction per flush instead of one autocommit write per event.
		// PersistEvents keeps the best-effort contract: on tx failure it retries
		// per-row so a single bad event doesn't drop the batch.
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
			// Drain anything still in the channel before exiting. The drain
			// is bounded by the Stop context (p.stopCtxDone): once it fires
			// we do one final flush and exit rather than keep pulling, so a
			// slow store delays shutdown by at most one flush instead of
			// unboundedly. Either way the goroutine finishes any in-flight
			// flush before returning (and closing p.done), so Stop's caller
			// never closes the store under a live flusher.
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
		case <-tick.C:
			flush()
			syncDropped()
		}
	}
}
