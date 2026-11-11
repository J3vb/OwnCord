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

// AuditStore is the batch-write surface AuditWriter needs; *DB satisfies it.
type AuditStore interface {
	PersistAudits(ctx context.Context, entries []AuditEntry) (int, error)
}

// AuditWriter drains audit entries from an in-memory channel into audit_log in
// batches, modeled on ws.EventPersister. It must never block the request path:
// TryEnqueue refuses when the queue is full or stopping and the DB path writes
// synchronously; Enqueue, with no fallback, drops and counts. A drop is logged
// with actor/action/target, never the detail string, which can carry sensitive text.
type AuditWriter struct {
	store      AuditStore
	queue      chan AuditEntry
	batchSize  int
	flushEvery time.Duration

	flushReq chan chan struct{}

	// unlinked is the erasure's rule set: erased subjects whose entries are
	// written unlinked (id 0, detail cleared, the marker's token) because the
	// erasure transaction can rewrite only persisted rows. Written by Unlink after
	// an erasure commits; read by the store at insert time under the writer connection.
	unlinkMu syncutil.Mutex
	unlinked map[int64]string

	startOnce sync.Once
	started   atomic.Bool
	stopOnce  sync.Once
	// sendMu makes "not stopped, so send" one step against Stop: TryEnqueue sends
	// under the read lock and Stop sets stopped under the write lock before
	// closing w.stop, so every accepted send is queued before run()'s final drain.
	sendMu  syncutil.RWMutex
	stopped bool
	stop    chan struct{}
	done    chan struct{}
	// stopCtxDone is the Done channel of Stop's context, read by run only after
	// observing stop closed (happens-before without a lock). Nil drains fully.
	stopCtxDone <-chan struct{}

	persisted atomic.Uint64
	dropped   atomic.Uint64
	flushes   atomic.Uint64
	errors    atomic.Uint64
}

// NewAuditWriter returns a writer wired to s, which must be non-nil; once queueSize is
// full, Enqueue drops loudly.
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
		queue:      make(chan AuditEntry, queueSize),
		batchSize:  batchSize,
		flushEvery: flushEvery,
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
		flushReq:   make(chan chan struct{}),
	}
}

// Start launches the flusher goroutine; calling it again is a no-op.
func (w *AuditWriter) Start(ctx context.Context) {
	w.startOnce.Do(func() {
		w.started.Store(true)
		go w.run(ctx)
	})
}

// Enqueue queues an entry without blocking; on a full queue or a stopping
// writer it is dropped, counted and logged with WriteAudit's identifying
// fields, never the detail. The DB path uses TryEnqueue instead.
func (w *AuditWriter) Enqueue(actorID int64, action, targetType string, targetID int64, detail string) {
	w.EnqueueEntry(AuditEntry{ActorID: actorID, Action: action, TargetType: targetType, TargetID: targetID, Detail: detail})
}

// EnqueueEntry is Enqueue for a whole entry, subject token included.
func (w *AuditWriter) EnqueueEntry(e AuditEntry) {
	if w == nil || w.TryEnqueue(e) {
		return
	}
	w.dropped.Add(1)
	if w.stopping() {
		slog.Error("audit log dropped: writer stopped",
			"action", e.Action,
			"actor_id", e.ActorID,
			"target_type", e.TargetType,
			"target_id", e.TargetID,
		)
		return
	}
	slog.Error("audit log dropped: queue full",
		"action", e.Action,
		"actor_id", e.ActorID,
		"target_type", e.TargetType,
		"target_id", e.TargetID,
	)
}

// TryEnqueue queues e without blocking and reports whether it was taken; refusal is
// uncounted so the caller writes it.
func (w *AuditWriter) TryEnqueue(e AuditEntry) bool {
	if w == nil {
		return false
	}
	w.sendMu.RLock()
	defer w.sendMu.RUnlock()
	if w.stopped || w.stopping() {
		return false
	}
	select {
	case w.queue <- e:
		return true
	default:
		return false
	}
}

// stopping reports whether Stop was called or run() has exited; the channel
// still accepts sends after that, which could strand an entry.
func (w *AuditWriter) stopping() bool {
	select {
	case <-w.stop:
		return true
	case <-w.done:
		return true
	default:
		return false
	}
}

// Stop signals the writer to drain and returns only after run has exited, because
// main.go closes the database right after. ctx bounds how long run() keeps draining
// before one final flush, not the wait. Without a prior Start it returns after closing
// the stop channel.
func (w *AuditWriter) Stop(ctx context.Context) {
	if w == nil {
		return
	}
	w.stopOnce.Do(func() {
		w.sendMu.Lock()
		defer w.sendMu.Unlock()
		w.stopped = true
		// Published before close(w.stop) so run()'s read after observing the close is race-free.
		w.stopCtxDone = ctx.Done()
		close(w.stop)
	})
	if !w.started.Load() {
		return
	}
	<-w.done

	// Entries can remain if run() exited early (Stop context expired mid-drain, or
	// a send raced its exit). The store is still open, so write them directly,
	// bounded so a stuck store cannot hold shutdown.
	stranded := w.drainQueued(nil)
	if len(stranded) == 0 {
		return
	}
	sweepCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), strandedWriteTimeout)
	defer cancel()
	persisted, err := w.store.PersistAudits(sweepCtx, stranded)
	if persisted > 0 {
		w.persisted.Add(uint64(persisted))
	}
	if failed := len(stranded) - persisted; failed > 0 {
		w.dropped.Add(uint64(failed)) //nolint:gosec // failed is non-negative
		slog.Error("audit writer: flush lost audit entries",
			"failed", failed, "batch", len(stranded), "error", err)
	}
}

const strandedWriteTimeout = 2 * time.Second

// Stats returns lifetime counters.
func (w *AuditWriter) Stats() (persisted, dropped, flushes, errs uint64) {
	return w.persisted.Load(), w.dropped.Load(), w.flushes.Load(), w.errors.Load()
}

// Unlink installs the erasure's unlinking rule for userID: every entry inserted from
// now on that names userID is written as erasureUnlinkAudit rewrote persisted rows.
// The erasure installs it after commit while holding the writer connection and the
// store reads it under that connection, so an earlier-queued entry lands raw ahead of
// the rewriting UPDATE and a later one lands unlinked. Permanent: an erased id is
// never reissued (DB.RaiseSequences).
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

// unlinkEntry applies the rules as erasureUnlinkAudit does: the actor's token
// on the actor side, the subject's on the target side.
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

// Flush is a barrier: it returns once every entry enqueued before the call has reached
// the store. The erasure takes it first so entries about the subject are on disk for
// the UPDATE to rewrite. A writer never started, or stopped, has nothing in flight.
func (w *AuditWriter) Flush(ctx context.Context) error {
	if w == nil || !w.started.Load() {
		return nil
	}
	// select picks randomly among ready cases, so a cancelled barrier must fail here, not race the
	// flushReq send.
	if err := ctx.Err(); err != nil {
		return err
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

func (w *AuditWriter) drainQueued(batch []AuditEntry) []AuditEntry {
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

	batch := make([]AuditEntry, 0, w.batchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		w.flushes.Add(1)
		persisted, err := w.store.PersistAudits(ctx, batch)
		if persisted > 0 {
			w.persisted.Add(uint64(persisted))
		}
		if failed := len(batch) - persisted; failed > 0 {
			w.errors.Add(uint64(failed)) //nolint:gosec // failed is non-negative
			slog.Error("audit writer: flush lost audit entries",
				"failed", failed, "batch", len(batch), "error", err)
		}
		batch = batch[:0]
	}

	for {
		select {
		case <-w.stop:
			// Drain what is left, bounded by w.stopCtxDone: once it fires, flush once
			// and exit. Any in-flight flush finishes before w.done closes, so Stop's
			// caller never closes the store under it.
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
			batch = w.drainQueued(batch)
			flush()
			close(reply)
		case <-tick.C:
			flush()
		}
	}
}

// SetAuditWriter installs w as the asynchronous audit path for WriteAudit calls backed
// by this *DB; nil uninstalls. Safe for concurrent use.
func (d *DB) SetAuditWriter(w *AuditWriter) {
	d.auditWriter.Store(w)
}

// EnqueueAuditEntry implements AsyncEntryAuditor and reports false without a writer, a
// full queue or a stopping writer, so the caller writes synchronously. The writer
// stays installed after Stop: the synchronous path reads the unlinking rules from it.
func (d *DB) EnqueueAuditEntry(e AuditEntry) bool {
	return d.auditWriter.Load().TryEnqueue(e)
}

// FlushAudits is the erasure's barrier: on return the installed writer's entries are on disk.
func (d *DB) FlushAudits(ctx context.Context) error {
	w := d.auditWriter.Load()
	if w == nil {
		return nil
	}
	return w.Flush(ctx)
}

// unlinkAuditsFor installs the unlinking rule for an erased subject;
// eraseAccount calls it after commit while holding the writer connection.
func (d *DB) unlinkAuditsFor(userID int64, token string) {
	if w := d.auditWriter.Load(); w != nil {
		w.Unlink(userID, token)
	}
}

func (d *DB) auditUnlinkRules() map[int64]string {
	w := d.auditWriter.Load()
	if w == nil {
		return nil
	}
	return w.unlinkRules()
}
