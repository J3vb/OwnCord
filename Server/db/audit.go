package db

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// Auditor is the minimal audit-write surface WriteAudit needs. *DB satisfies
// it directly, and the service layer's Store interface does too, so every
// caller — api, admin, ws, service — can route its audit writes through this
// one helper regardless of whether it holds a *DB or a narrower interface.
type Auditor interface {
	LogAudit(ctx context.Context, actorID int64, action, targetType string, targetID int64, detail string) error
}

// WriteAudit records an audit entry best-effort.
//
// Per the D8 policy decision (docs/archive/plans/audit-2026-07-19-decisions.md), audit
// writes stay best-effort: a LogAudit failure must never fail or abort the
// caller's request. But a failed write must never be silently discarded
// either — this helper logs it with the actor/action/target context so the
// gap is visible in the logs. The detail string is intentionally not logged;
// it can carry request-specific or sensitive text and the structured fields
// already identify what was attempted.
func WriteAudit(ctx context.Context, a Auditor, actorID int64, action, targetType string, targetID int64, detail string) {
	if aa, ok := a.(AsyncEntryAuditor); ok && aa.EnqueueAuditEntry(AuditEntry{ActorID: actorID, Action: action, TargetType: targetType, TargetID: targetID, Detail: detail}) {
		return
	}
	if err := a.LogAudit(ctx, actorID, action, targetType, targetID, detail); err != nil {
		slog.Error("audit log write failed",
			"action", action,
			"actor_id", actorID,
			"target_type", targetType,
			"target_id", targetID,
			"error", err,
		)
	}
}

// EntryAuditor is the whole-entry form of Auditor, which *DB and the
// service Store satisfy; WriteAuditEntry needs it for the subject token.
type EntryAuditor interface {
	LogAuditEntry(ctx context.Context, e AuditEntry) error
}

// The production auditor must keep satisfying it: WriteAuditEntry's assertion
// falls back to the token-less write when it stops matching, which would drop
// an erasure's subject token with nothing failing to say so.
var _ EntryAuditor = (*DB)(nil)

// AsyncEntryAuditor is the optional asynchronous fast path for WriteAudit.
// An Auditor that also implements it — in practice *DB, once main.go installs
// an AuditWriter via SetAuditWriter — can take the entry off the request
// path. It reports true when the writer queued the entry, and false when no
// writer is installed, its queue is full or it is stopping, in which case
// WriteAudit performs the synchronous best-effort write. The token CLI and
// tests never install a writer, so they stay synchronous. The assertion sees
// the dynamic type, so a *DB held behind the service Store still takes this
// path.
type AsyncEntryAuditor interface {
	EnqueueAuditEntry(e AuditEntry) bool
}

// The production auditor must keep satisfying it: the assertion at each call
// site is what selects the fast path, so a lost method would move every audit
// write back onto the request path and only a benchmark would notice.
var _ AsyncEntryAuditor = (*DB)(nil)

// WriteAuditEntry is WriteAudit for an entry that carries a subject token:
// an erasure's own rows name the subject by token, never by id.
// Same best-effort policy, same async fast path when a writer is installed;
// an Auditor without the entry forms gets the token-less write.
func WriteAuditEntry(ctx context.Context, a Auditor, e AuditEntry) {
	if aa, ok := a.(AsyncEntryAuditor); ok && aa.EnqueueAuditEntry(e) {
		return
	}
	var err error
	if ea, ok := a.(EntryAuditor); ok {
		err = ea.LogAuditEntry(ctx, e)
	} else {
		err = a.LogAudit(ctx, e.ActorID, e.Action, e.TargetType, e.TargetID, e.Detail)
	}
	if err != nil {
		slog.Error("audit log write failed",
			"action", e.Action,
			"actor_id", e.ActorID,
			"target_type", e.TargetType,
			"target_id", e.TargetID,
			"error", err,
		)
	}
}

// LogAudit inserts an audit log entry. It goes through LogAuditEntry so the
// erasure's unlinking rules apply to it too: WriteAudit takes this path when
// the audit writer cannot queue an entry.
func (d *DB) LogAudit(ctx context.Context, actorID int64, action, targetType string, targetID int64, detail string) error {
	if err := d.LogAuditEntry(ctx, AuditEntry{
		ActorID:    actorID,
		Action:     action,
		TargetType: targetType,
		TargetID:   targetID,
		Detail:     detail,
	}); err != nil {
		return fmt.Errorf("LogAudit: %w", err)
	}
	return nil
}

// LogAuditEntry inserts an audit entry with every field, tokens included
// (LogAudit is the token-less form). The erasure's unlinking rules are applied
// once the writer connection is held, so an entry about a subject whose
// erasure committed while this call waited is written unlinked.
func (d *DB) LogAuditEntry(ctx context.Context, e AuditEntry) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("LogAuditEntry begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	e = unlinkEntry(e, d.auditUnlinkRules())
	if err := dbgen.New(tx).LogAuditEntry(ctx, dbgen.LogAuditEntryParams{
		ActorID:      e.ActorID,
		Action:       e.Action,
		TargetType:   e.TargetType,
		TargetID:     e.TargetID,
		Detail:       e.Detail,
		SubjectToken: nullableToken(e.SubjectToken),
		ActorToken:   nullableToken(e.ActorToken),
	}); err != nil {
		return fmt.Errorf("LogAuditEntry: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("LogAuditEntry commit: %w", err)
	}
	return nil
}

// PersistAudits inserts a batch of audit entries in one transaction with one
// prepared insert, so the audit writer's flush costs one fsync instead of one
// per entry. Only LogAudit-shaped fields are written; ID, ActorName and
// CreatedAt on the input are ignored (id autoincrements, created_at defaults,
// actor_name is a join product). Like PersistEvents, a failed batch falls back
// to per-row inserts so the good rows land. It returns the rows persisted and,
// if any was lost, the first per-row error.
func (d *DB) PersistAudits(ctx context.Context, entries []AuditEntry) (int, error) {
	if len(entries) == 0 {
		return 0, nil
	}
	if err := d.persistAuditsTx(ctx, entries); err == nil {
		return len(entries), nil
	}
	// Fallback: insert rows individually so one bad row does not drop the batch.
	persisted := 0
	var firstErr error
	for i := range entries {
		e := &entries[i]
		if err := d.LogAuditEntry(ctx, *e); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		persisted++
	}
	return persisted, firstErr
}

// persistAuditsTx inserts all entries inside one transaction; any failure
// rolls the whole batch back.
func (d *DB) persistAuditsTx(ctx context.Context, entries []AuditEntry) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("PersistAudits begin tx: %w", err)
	}
	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, subject_token, actor_token) VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''))`,
	)
	if err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("PersistAudits prepare: %w", err)
	}
	defer func() { _ = stmt.Close() }()
	// The erasure's unlinking rules, read now that the writer connection is held:
	// an erasure that committed while this batch waited has installed its rule,
	// and entries about the subject go down unlinked, not raw after its UPDATE.
	rules := d.auditUnlinkRules()
	for i := range entries {
		e := unlinkEntry(entries[i], rules)
		if _, err := stmt.ExecContext(ctx, e.ActorID, e.Action, e.TargetType, e.TargetID, e.Detail, e.SubjectToken, e.ActorToken); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("PersistAudits insert action %q: %w", e.Action, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("PersistAudits commit: %w", err)
	}
	return nil
}

// GetAuditLog returns audit log entries ordered newest-first with pagination.
func (d *DB) GetAuditLog(ctx context.Context, limit, offset int) ([]AuditEntry, error) {
	return d.SearchAuditLog(ctx, "", "", false, limit, offset)
}

// SearchAuditLog is GetAuditLog narrowed to one action (exact) and to rows
// whose actor name, action, target type or detail contains query (ASCII
// case-insensitive). An empty action or query does not narrow. hideSignins
// drops the user_login and ws_connect rows.
//
// ponytail: a substring scan over the whole table, fine at an admin's page
// rate; an FTS5 index over audit_log is the upgrade if the table outgrows it.
func (d *DB) SearchAuditLog(ctx context.Context, action, query string, hideSignins bool, limit, offset int) ([]AuditEntry, error) {
	var hide int64
	if hideSignins {
		hide = 1
	}
	rows, err := d.q.GetAuditLog(ctx, dbgen.GetAuditLogParams{
		Action:      action,
		HideSignins: hide,
		Query:       query,
		RowLimit:    int64(limit),
		RowOffset:   int64(offset),
	})
	if err != nil {
		return nil, fmt.Errorf("SearchAuditLog: %w", err)
	}
	entries := make([]AuditEntry, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		entries = append(entries, AuditEntry{
			ID:           r.ID,
			ActorID:      r.ActorID,
			ActorName:    r.ActorName,
			Action:       r.Action,
			TargetType:   r.TargetType,
			TargetID:     r.TargetID,
			Detail:       r.Detail,
			SubjectToken: r.SubjectToken,
			ActorToken:   r.ActorToken,
			CreatedAt:    r.CreatedAt,
		})
	}
	return entries, nil
}

// ListAuditActions returns up to limit distinct action names in the whole
// audit log, sorted.
func (d *DB) ListAuditActions(ctx context.Context, limit int) ([]string, error) {
	actions, err := d.q.ListAuditActions(ctx, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("ListAuditActions: %w", err)
	}
	return actions, nil
}

// nullableToken maps an empty token to NULL, so the partial indexes on the
// token columns hold only the rows that carry one.
func nullableToken(token string) *string {
	if token == "" {
		return nil
	}
	return &token
}
