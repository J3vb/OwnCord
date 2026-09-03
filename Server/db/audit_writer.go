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
	"maps"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// AuditStore is the minimal batch-write surface AuditWriter needs. *DB
// satisfies it directly; tests substitute a fake.
type AuditStore interface {
	PersistAudits(ctx context.Context, entries []AuditEntry) (int, error)
}

// pendingAudit is a single audit entry waiting to be flushed to the store.
// Fields mirror LogAudit's parameters.
type pendingAudit struct {
	actorID      int64
	action       string
	targetType   string
	targetID     int64
	detail       string
	subjectToken string
	actorToken   string
}

// AuditWriter batches audit entries and writes them to an AuditStore.
type AuditWriter struct {
	store      AuditStore
	queue      chan pendingAudit
	batchSize  int
	flushEvery time.Duration

	// flushReq carries Flush's barrier requests to run(): each is answered
	// once everything queued before it has been handed to the store.
	flushReq chan chan struct{}

	// unlinked is the erasure's rule set (B4-10): the erased subjects, by
	// user id, whose entries are written unlinked — id 0, detail cleared,
	// the deletion marker's token in place — because the erasure
	// transaction can rewrite only the rows already persisted. Written by
	// Unlink once an erasure has committed; read by the store at insert
	// time, under the writer connection (DB.PersistAudits, DB.LogAuditEntry).
	unlinkMu syncutil.Mutex
	unlinked map[int64]string

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
		flushReq:   make(chan chan struct{}),
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
	w.EnqueueEntry(AuditEntry{ActorID: actorID, Action: action, TargetType: targetType, TargetID: targetID, Detail: detail})
}

// EnqueueEntry is Enqueue for a whole entry, subject token included (B4-10).
func (w *AuditWriter) EnqueueEntry(e AuditEntry) {
	if w == nil {
		return
	}
	actorID, action, targetType, targetID, detail := e.ActorID, e.Action, e.TargetType, e.TargetID, e.Detail
	// run() stops reading w.queue the instant it exits, but the channel keeps
	// its buffer and keeps accepting sends — without this check a caller that
	// enqueues after Stop has returned (main.go closes the DB right after)
	// would land silently in a dead channel, violating D8. w.done closes only
	// when run() has actually exited, so this is exact, not a best guess.
	select {
	case <-w.done:
		w.dropped.Add(1)
		slog.Error("audit log dropped: writer stopped",
			"action", action,
			"actor_id", actorID,
			"target_type", targetType,
			"target_id", targetID,
		)
		return
	default:
	}
	select {
	case w.queue <- pendingAudit{actorID: actorID, action: action, targetType: targetType, targetID: targetID, detail: detail, subjectToken: e.SubjectToken, actorToken: e.ActorToken}:
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

// Stop signals the writer to drain remaining entries and exit, and returns
// only after the run goroutine has fully exited (i.e. has stopped touching the
// store). This is the load-bearing contract: main.go closes the database right
// after Stop returns (LIFO defers), so Stop must guarantee no flush is still
// in flight — otherwise a late flush writes into a closed pool and audits are
// lost. ctx does NOT abandon that wait; it only bounds how long run() keeps
// draining the queue before it stops accepting new entries, does one final
// flush, and exits (see run). A single stuck flush therefore delays shutdown
// by at most that flush rather than closing the DB underneath it.
//
// Safe to call without a prior Start: in that case there's no goroutine to
// wait for and Stop returns immediately after closing the stop channel.
func (w *AuditWriter) Stop(ctx context.Context) {
	if w == nil {
		return
	}
	w.stopOnce.Do(func() {
		// Published before close(w.stop): run() reads stopCtxDone only after
		// its receive on w.stop observes the close, and the close/receive
		// pair makes this write visible without a data race.
		w.stopCtxDone = ctx.Done()
		close(w.stop)
	})
	if !w.started.Load() {
		// run() was never launched, so done will never be closed.
		return
	}
	// Always wait for the goroutine to exit — never race it against ctx.
	<-w.done

	// A concurrent Enqueue can win the race between run()'s last drain
	// attempt and the close of w.done above: it observes w.done not yet
	// closed and sends into w.queue just as run() is exiting, so nothing
	// ever reads that entry. Sweep whatever the race stranded here so it is
	// dropped loudly (D8) instead of silently.
	for {
		select {
		case a := <-w.queue:
			w.dropped.Add(1)
			slog.Error("audit log dropped: writer stopped",
				"action", a.action,
				"actor_id", a.actorID,
				"target_type", a.targetType,
				"target_id", a.targetID,
			)
		default:
			return
		}
	}
}

// Stats returns lifetime counters.
func (w *AuditWriter) Stats() (persisted, dropped, flushes, errs uint64) {
	return w.persisted.Load(), w.dropped.Load(), w.flushes.Load(), w.errors.Load()
}

// Unlink installs the erasure's unlinking rule for userID (B4-10): from now
// on every entry the store inserts that names userID — as actor, or as a
// user target — is written the way the erasure transaction rewrote the
// rows already persisted (erasureUnlinkAudit): id 0, detail cleared, the
// deletion marker's token in place. The erasure installs it once its
// transaction has committed, while it still holds the writer connection
// (DB.eraseAccount), and the store reads it under that connection at
// insert time, so an entry queued before the transaction lands raw ahead
// of the UPDATE that rewrites it, and one a request enqueues after it is
// written unlinked; a refused erasure installs nothing. The rule is
// permanent: an erased id is never handed out again (DB.RaiseSequences),
// so nothing but a late entry about the subject can match it.
func (w *AuditWriter) Unlink(userID int64, token string) {
	if w == nil {
		return
	}
	w.unlinkMu.Lock()
	defer w.unlinkMu.Unlock()
	if w.unlinked == nil {
		w.unlinked = make(map[int64]string)
	}
	w.unlinked[userID] = token
}

// unlinkRules snapshots the rule set for one insert batch; nil when empty,
// so the common case costs one lock and no allocation.
func (w *AuditWriter) unlinkRules() map[int64]string {
	w.unlinkMu.Lock()
	defer w.unlinkMu.Unlock()
	if len(w.unlinked) == 0 {
		return nil
	}
	rules := make(map[int64]string, len(w.unlinked))
	maps.Copy(rules, w.unlinked)
	return rules
}

// unlinkEntry applies the rule set to one entry: the same rewrite
// erasureUnlinkAudit makes to a persisted row — the actor's token on the
// actor side, the subject's on the target side, so an entry naming two
// erased subjects keeps both.
func unlinkEntry(e AuditEntry, rules map[int64]string) AuditEntry {
	if len(rules) == 0 {
		return e
	}
	if token, ok := rules[e.ActorID]; ok && e.ActorID != 0 {
		e.ActorID, e.Detail, e.ActorToken = 0, "", token
	}
	if token, ok := rules[e.TargetID]; ok && e.TargetID != 0 && e.TargetType == "user" {
		e.TargetID, e.Detail, e.SubjectToken = 0, "", token
	}
	return e
}

// Flush is a barrier: it returns once every entry enqueued before the call
// has been handed to the store — the erasure's audit-writer barrier
// (B4-10), taken before the erasure transaction so an entry queued about
// the subject is on disk, with its ids, for the transaction's UPDATE to
// rewrite; a refused transaction then leaves it as it was. A writer that
// was never started, or has stopped, has nothing in flight to wait for:
// its queue is drained by Start or swept by Stop.
func (w *AuditWriter) Flush(ctx context.Context) error {
	if w == nil || !w.started.Load() {
		return nil
	}
	reply := make(chan struct{})
	select {
	case w.flushReq <- reply:
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-reply:
		return nil
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// drainQueued moves everything currently in the queue into batch.
func (w *AuditWriter) drainQueued(batch []pendingAudit) []pendingAudit {
	for {
		select {
		case a := <-w.queue:
			batch = append(batch, a)
		default:
			return batch
		}
	}
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
				ActorID:      a.actorID,
				Action:       a.action,
				TargetType:   a.targetType,
				TargetID:     a.targetID,
				Detail:       a.detail,
				SubjectToken: a.subjectToken,
				ActorToken:   a.actorToken,
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
			// Drain anything still in the channel before exiting. The drain is
			// bounded by the Stop context (w.stopCtxDone): once it fires we do
			// one final flush and exit rather than keep pulling, so a slow
			// store delays shutdown by at most one flush instead of
			// unboundedly. Either way the goroutine finishes any in-flight
			// flush before returning (and closing w.done), so Stop's caller
			// never closes the store under a live flusher.
			for {
				select {
				case a := <-w.queue:
					batch = append(batch, a)
					if len(batch) >= w.batchSize {
						flush()
					}
				case <-w.stopCtxDone:
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
		case a := <-w.queue:
			batch = append(batch, a)
			if len(batch) >= w.batchSize {
				flush()
			}
		case reply := <-w.flushReq:
			// Everything sent before the request is already in the queue;
			// take it all, write it, then answer.
			batch = w.drainQueued(batch)
			flush()
			close(reply)
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
	return d.EnqueueAuditEntry(AuditEntry{ActorID: actorID, Action: action, TargetType: targetType, TargetID: targetID, Detail: detail})
}

// EnqueueAuditEntry implements AsyncEntryAuditor: the whole-entry form of
// EnqueueAudit, carrying the subject token (B4-10).
func (d *DB) EnqueueAuditEntry(e AuditEntry) bool {
	w := d.auditWriter.Load()
	if w == nil {
		return false
	}
	w.EnqueueEntry(e)
	return true
}

// FlushAudits is the erasure's audit-writer barrier (B4-10): everything
// the installed writer holds is on disk when it returns, with its ids, so
// the erasure transaction's UPDATE rewrites it and a refused transaction
// leaves it untouched. Without a writer every audit write was synchronous
// and nothing is queued.
func (d *DB) FlushAudits(ctx context.Context) error {
	w := d.auditWriter.Load()
	if w == nil {
		return nil
	}
	return w.Flush(ctx)
}

// unlinkAuditsFor installs the writer's unlinking rule for an erased
// subject (AuditWriter.Unlink); called by eraseAccount after its
// transaction committed, while it still holds the writer connection.
func (d *DB) unlinkAuditsFor(userID int64, token string) {
	if w := d.auditWriter.Load(); w != nil {
		w.Unlink(userID, token)
	}
}

// auditUnlinkRules is the installed writer's rule set, nil without one.
func (d *DB) auditUnlinkRules() map[int64]string {
	w := d.auditWriter.Load()
	if w == nil {
		return nil
	}
	return w.unlinkRules()
}
