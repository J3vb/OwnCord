// Async audit writer.
//
// AuditWriter is an asynchronous batched writer that drains audit entries
// from an in-memory channel into the audit_log table. It is modeled on
// ws.EventPersister: it must never block the request path, so when the queue
// is full the entry is dropped and a counter is incremented. Per the D8
// policy decision (docs/plans/audit-2026-07-19-decisions.md) a drop is never
// silent — it is logged with the actor/action/target context (never the
// detail string, which can carry sensitive text), and flush losses are
// logged the same way.

package db

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// AuditStore is the minimal batch-write surface AuditWriter needs. *DB
// satisfies it directly; tests substitute a fake.
type AuditStore interface {
	PersistAudits(ctx context.Context, entries []AuditEntry) (int, error)
}

// pendingAudit is a single audit entry waiting to be flushed to the store.
// Fields mirror LogAudit's parameters.
type pendingAudit struct {
	actorID    int64
	action     string
	targetType string
	targetID   int64
	detail     string
}

// AuditWriter batches audit entries and writes them to an AuditStore.
type AuditWriter struct {
	store      AuditStore
	queue      chan pendingAudit
	batchSize  int
	flushEvery time.Duration

	startOnce sync.Once
	started   atomic.Bool
	stopOnce  sync.Once
	stop      chan struct{}
	done      chan struct{}

	persisted atomic.Uint64
	dropped   atomic.Uint64
	flushes   atomic.Uint64
	errors    atomic.Uint64
}

// NewAuditWriter returns a writer wired to s. s MUST be non-nil — run()
// dereferences w.store on every flush, so a nil store would panic on the
// first tick. We fail fast here so the misconfiguration surfaces at
// construction time (main.go, tests) instead of minutes later in the
// background goroutine.
//
// queueSize sets the channel buffer; once full, Enqueue drops (loudly, per
// D8) without blocking. batchSize and flushEvery control the flush triggers.
func NewAuditWriter(s AuditStore, queueSize, batchSize int, flushEvery time.Duration) *AuditWriter {
	if s == nil {
		panic("db: NewAuditWriter requires a non-nil AuditStore")
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
	return &AuditWriter{
		store:      s,
		queue:      make(chan pendingAudit, queueSize),
		batchSize:  batchSize,
		flushEvery: flushEvery,
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
	}
}

// Start launches the background flusher goroutine. Idempotent — calling
// Start more than once is a no-op so test setups that share a writer across
// cases don't spawn duplicate runners.
func (w *AuditWriter) Start(ctx context.Context) {
	w.startOnce.Do(func() {
		w.started.Store(true)
		go w.run(ctx)
	})
}

// Enqueue queues an audit entry for persistence. Non-blocking; on a full
// queue the entry is dropped, but never silently (D8): the drop is counted
// and logged with the same identifying fields WriteAudit uses for a
// synchronous failure. The detail string is intentionally not logged.
func (w *AuditWriter) Enqueue(actorID int64, action, targetType string, targetID int64, detail string) {
	if w == nil {
		return
	}
	select {
	case w.queue <- pendingAudit{actorID: actorID, action: action, targetType: targetType, targetID: targetID, detail: detail}:
	default:
		w.dropped.Add(1)
		slog.Error("audit log dropped: queue full",
			"action", action,
			"actor_id", actorID,
			"target_type", targetType,
			"target_id", targetID,
		)
	}
}

// Stop signals the writer to drain remaining entries and exit. Blocks until
// the goroutine exits or ctx is cancelled. Safe to call without a prior
// Start: in that case there's no goroutine to wait for and Stop returns
// immediately after closing the stop channel.
func (w *AuditWriter) Stop(ctx context.Context) {
	if w == nil {
		return
	}
	w.stopOnce.Do(func() { close(w.stop) })
	if !w.started.Load() {
		// run() was never launched, so done will never be closed.
		return
	}
	select {
	case <-w.done:
	case <-ctx.Done():
	}
}

// Stats returns lifetime counters.
func (w *AuditWriter) Stats() (persisted, dropped, flushes, errs uint64) {
	return w.persisted.Load(), w.dropped.Load(), w.flushes.Load(), w.errors.Load()
}

func (w *AuditWriter) run(ctx context.Context) {
	defer close(w.done)
	tick := time.NewTicker(w.flushEvery)
	defer tick.Stop()

	batch := make([]pendingAudit, 0, w.batchSize)
	// Scratch slice reused across flushes for the store's batch shape.
	rows := make([]AuditEntry, 0, w.batchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		w.flushes.Add(1)
		rows = rows[:0]
		for _, a := range batch {
			rows = append(rows, AuditEntry{
				ActorID:    a.actorID,
				Action:     a.action,
				TargetType: a.targetType,
				TargetID:   a.targetID,
				Detail:     a.detail,
			})
		}
		// One transaction per flush instead of one autocommit write per entry.
		// PersistAudits keeps the best-effort contract: on tx failure it
		// retries per-row so a single bad entry doesn't drop the batch.
		persisted, err := w.store.PersistAudits(ctx, rows)
		if persisted > 0 {
			w.persisted.Add(uint64(persisted))
		}
		if failed := len(batch) - persisted; failed > 0 {
			w.errors.Add(uint64(failed)) //nolint:gosec // failed is non-negative
			// D8: a lost audit write is never silent. PersistAudits already
			// wraps the first row error with its action context.
			slog.Error("audit writer: flush lost audit entries",
				"failed", failed, "batch", len(batch), "error", err)
		}
		batch = batch[:0]
	}

	for {
		select {
		case <-w.stop:
			// Drain anything still in the channel before exiting.
			for {
				select {
				case a := <-w.queue:
					batch = append(batch, a)
					if len(batch) >= w.batchSize {
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
		case a := <-w.queue:
			batch = append(batch, a)
			if len(batch) >= w.batchSize {
				flush()
			}
		case <-tick.C:
			flush()
		}
	}
}

// ── *DB integration ─────────────────────────────────────────────────────────

// SetAuditWriter installs w as this DB's asynchronous audit path. Once
// installed, WriteAudit calls whose Auditor is backed by this *DB enqueue on
// the writer instead of inserting synchronously. Paths that never install a
// writer — the token CLI, tests — keep the synchronous behavior. Safe for
// concurrent use; storing nil uninstalls.
func (d *DB) SetAuditWriter(w *AuditWriter) {
	d.auditWriter.Store(w)
}

// EnqueueAudit implements AsyncAuditor. It reports false when no writer is
// installed so WriteAudit falls back to the synchronous path.
func (d *DB) EnqueueAudit(actorID int64, action, targetType string, targetID int64, detail string) bool {
	w := d.auditWriter.Load()
	if w == nil {
		return false
	}
	w.Enqueue(actorID, action, targetType, targetID, detail)
	return true
}
