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

	"github.com/owncord/server/store"
)

// pendingEvent is a single event waiting to be flushed to the EventStore.
type pendingEvent struct {
	eventType string
	channelID int64
	payload   []byte
}

// EventPersister batches broadcast events and writes them to an EventStore.
type EventPersister struct {
	store     store.EventStore
	queue     chan pendingEvent
	batchSize int
	flushEvy  time.Duration

	stopOnce sync.Once
	stop     chan struct{}
	done     chan struct{}

	persisted atomic.Uint64
	dropped   atomic.Uint64
	flushes   atomic.Uint64
	errors    atomic.Uint64
}

// NewEventPersister returns a persister wired to s. queueSize sets the
// channel buffer; once full, Enqueue increments the dropped counter without
// blocking. batchSize and flushEvery control the flush triggers.
func NewEventPersister(s store.EventStore, queueSize, batchSize int, flushEvery time.Duration) *EventPersister {
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
		store:     s,
		queue:     make(chan pendingEvent, queueSize),
		batchSize: batchSize,
		flushEvy:  flushEvery,
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
}

// Start launches the background flusher goroutine.
func (p *EventPersister) Start(ctx context.Context) {
	go p.run(ctx)
}

// Enqueue queues an event for persistence. Non-blocking; drops on full queue.
func (p *EventPersister) Enqueue(eventType string, channelID int64, payload []byte) {
	if p == nil {
		return
	}
	// Defensive copy: callers may reuse buffers.
	cp := make([]byte, len(payload))
	copy(cp, payload)
	select {
	case p.queue <- pendingEvent{eventType: eventType, channelID: channelID, payload: cp}:
	default:
		p.dropped.Add(1)
	}
}

// Stop signals the persister to drain remaining events and exit. Blocks until
// the goroutine exits or ctx is cancelled.
func (p *EventPersister) Stop(ctx context.Context) {
	if p == nil {
		return
	}
	p.stopOnce.Do(func() { close(p.stop) })
	select {
	case <-p.done:
	case <-ctx.Done():
	}
}

// Stats returns lifetime counters.
func (p *EventPersister) Stats() (persisted, dropped, flushes, errs uint64) {
	return p.persisted.Load(), p.dropped.Load(), p.flushes.Load(), p.errors.Load()
}

func (p *EventPersister) run(ctx context.Context) {
	defer close(p.done)
	tick := time.NewTicker(p.flushEvy)
	defer tick.Stop()

	batch := make([]pendingEvent, 0, p.batchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		p.flushes.Add(1)
		for _, evt := range batch {
			if _, err := p.store.PersistEvent(ctx, evt.eventType, evt.channelID, evt.payload); err != nil {
				p.errors.Add(1)
				slog.Warn("event persister: PersistEvent failed",
					"event_type", evt.eventType, "channel_id", evt.channelID, "err", err)
				continue
			}
			p.persisted.Add(1)
		}
		batch = batch[:0]
	}

	for {
		select {
		case <-p.stop:
			// Drain anything still in the channel before exiting.
			for {
				select {
				case evt := <-p.queue:
					batch = append(batch, evt)
					if len(batch) >= p.batchSize {
						flush()
					}
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
		}
	}
}
