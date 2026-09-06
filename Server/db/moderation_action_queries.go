package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// sqliteDatetimeFormat matches SQLite's own datetime('now') output
// ("YYYY-MM-DD HH:MM:SS", space-separated, no zone suffix) — created_at,
// acknowledged_at and lifted_at on this table are all set that way by SQL
// DEFAULTs and UPDATEs. Every Go-computed timestamp this file compares
// against one of those columns (expires_at, and RetireModerationActions'
// cutoff) MUST use this same format: SQLite compares TEXT dates lexically,
// and 'T' (0x54) sorts after ' ' (0x20), so an RFC3339 "...T...Z" value
// compares as greater than a same-day datetime('now') value regardless of
// the actual times — the bug this format constant exists to not reintroduce.
const sqliteDatetimeFormat = "2006-01-02 15:04:05"

// ModerationAction is one row of the moderator-action ledger (migration 049,
// B5-9): every warning, timeout, kick, ban and removal. ActorToken is filled
// by erasure (the audit_log two-token pattern) when the acting moderator has
// since erased their own account; LiftedBy is a bare id with no token column
// of its own, mirroring reports.assignee_id.
type ModerationAction struct {
	ID             int64
	Kind           string
	TargetID       int64
	ActorID        int64
	ActorToken     string
	ReportID       *int64
	Reason         string
	ExpiresAt      *string
	AcknowledgedAt *string
	LiftedAt       *string
	LiftedBy       int64
	CreatedAt      string
}

// ModerationNotice is one unacknowledged warning, the shape ready's notices
// slot and the acknowledgement route need — never the actor, never the
// report link.
type ModerationNotice struct {
	ID        int64
	Kind      string
	Reason    string
	CreatedAt string
}

func moderationActionFromRow(r dbgen.ModerationAction) ModerationAction {
	return ModerationAction{
		ID: r.ID, Kind: r.Kind, TargetID: r.TargetID, ActorID: r.ActorID,
		ActorToken: strOrEmpty(r.ActorToken), ReportID: r.ReportID, Reason: r.Reason,
		ExpiresAt: r.ExpiresAt, AcknowledgedAt: r.AcknowledgedAt, LiftedAt: r.LiftedAt,
		LiftedBy: r.LiftedBy, CreatedAt: r.CreatedAt,
	}
}

// ErrOutranked is recordModerationAction's refusal: the actor does not
// strictly outrank the target by role POSITION at write time. Every moderator
// action routes through this one function, so a target promoted between the
// service layer's initial (cached) check and this write is refused here
// too, not sanctioned (B5-9 concurrent-role-change property test) — the
// writer pool is a single connection (SetMaxOpenConns(1)), so no other write
// transaction can be in flight while tx holds it, and the position read here
// is therefore atomic with the insert against any concurrent role change.
var ErrOutranked = errors.New("moderation: actor does not outrank target")

// rolePosition reads userID's role position live, inside tx. A lookup
// failure (no such user, no such role) returns ok=false rather than an
// error — the caller treats "cannot establish a position" as "refuse",
// exactly as a missing target should.
func rolePosition(ctx context.Context, tx *sql.Tx, userID int64) (int, bool) {
	var pos int
	err := tx.QueryRowContext(ctx,
		`SELECT r.position FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, userID,
	).Scan(&pos)
	if err != nil {
		return 0, false
	}
	return pos, true
}

// recordModerationAction is warning/timeout/kick/ban's one ledger write
// (ModerationService's recordAction, plan item 2): a warning or timeout's
// entire effect, or the ledger row riding alongside kick/ban's existing
// effect, in the same tx as that effect. The rank guard is re-validated
// here, live, against the CURRENT roles table — never trusted from a
// caller's earlier (possibly cached) check — mirroring the strict-outranks
// rule ModerationService already enforces in Go for exactly these four
// kinds before ever reaching this function.
//
// Not used for "removal": DeleteMessage/PurgeMessages authorize on channel
// MANAGE_MESSAGES alone, with no hierarchy requirement (a moderator need
// not outrank the message's author), and PurgeMessages' one-row-per-purge
// ledger entry targets the ACTOR themselves (no single author exists across
// a bulk purge) — both would be wrongly refused by this guard. See
// recordLedgerRow.
//
// actorID <= 0 is refused unconditionally before anything else: workstream
// 10's absence proof requires every ledger row to carry a human actor
// (Server/service/moderation.go enforces this at the service boundary too,
// but the guard is repeated here because this function is the one place
// every one of these four kinds funnels through).
func recordModerationAction(ctx context.Context, tx *sql.Tx, kind string, targetID, actorID int64, reportID *int64, reason string, expiresAt *string) (int64, error) {
	if actorID <= 0 {
		return 0, fmt.Errorf("recordModerationAction: %w", ErrOutranked)
	}
	if actorID == targetID {
		return 0, fmt.Errorf("recordModerationAction: actor equals target: %w", ErrOutranked)
	}
	actorPos, ok := rolePosition(ctx, tx, actorID)
	if !ok {
		return 0, fmt.Errorf("recordModerationAction: actor role: %w", ErrOutranked)
	}
	targetPos, ok := rolePosition(ctx, tx, targetID)
	if !ok {
		// A missing target (erased, or never existed) is treated as an
		// unbeatable rank rather than a crash: the caller already looked the
		// target up before deciding to act, so this is the same race the
		// effect's own write is exposed to.
		targetPos = math.MaxInt
	}
	if actorPos <= targetPos {
		return 0, ErrOutranked
	}
	return insertModerationActionRow(ctx, tx, kind, targetID, actorID, reportID, reason, expiresAt)
}

// recordLedgerRow is "removal"'s ledger write: no rank guard (see
// recordModerationAction's doc comment for why one would be wrong here),
// but still the absence-proof actor guard every kind carries, plus the
// EXISTS(users) check B5-8's review round asks every moderator write to
// carry (erasure.go, erasureUnlinkReports's sibling comment): a moderator
// concurrently erased between the caller's authorization and this write
// must not land as the actor of a ledger row. recordModerationAction gets
// the same property incidentally, through the rank JOIN failing when the
// actor row is gone; this function has no such JOIN, so the check is
// explicit here. Both callers (DeleteMessageWithRemoval,
// PurgeChannelMessagesWithAction) have no use for the new row's id, unlike
// recordModerationAction's callers.
func recordLedgerRow(ctx context.Context, tx *sql.Tx, kind string, targetID, actorID int64, reportID *int64, reason string) error {
	if actorID <= 0 {
		return fmt.Errorf("recordLedgerRow: %w", ErrOutranked)
	}
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id = ?`, actorID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("recordLedgerRow: actor erased: %w", ErrOutranked)
		}
		return fmt.Errorf("recordLedgerRow: actor lookup: %w", err)
	}
	_, err := insertModerationActionRow(ctx, tx, kind, targetID, actorID, reportID, reason, nil)
	return err
}

func insertModerationActionRow(ctx context.Context, tx *sql.Tx, kind string, targetID, actorID int64, reportID *int64, reason string, expiresAt *string) (int64, error) {
	id, err := dbgen.New(tx).InsertModerationAction(ctx, dbgen.InsertModerationActionParams{
		Kind: kind, TargetID: targetID, ActorID: actorID, ReportID: reportID, Reason: reason, ExpiresAt: expiresAt,
	})
	if err != nil {
		return 0, fmt.Errorf("insertModerationActionRow: %w", err)
	}
	return id, nil
}

// WarnUser writes a warning row — its entire effect is the row: the target
// acknowledges it on next connect (AcknowledgeWarning) and a live target
// gets a mod_action frame. reportID links a report-linked warning.
func (d *DB) WarnUser(ctx context.Context, targetID, actorID int64, reportID *int64, reason string) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("WarnUser begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	id, err := recordModerationAction(ctx, tx, "warning", targetID, actorID, reportID, reason, nil)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("WarnUser commit: %w", err)
	}
	return id, nil
}

// TimeoutUser writes a timeout row with the given expiry — its entire
// effect is the row, read back by HasActiveTimeout through the predicates.
func (d *DB) TimeoutUser(ctx context.Context, targetID, actorID int64, reportID *int64, reason string, expiresAt time.Time) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("TimeoutUser begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	expires := expiresAt.UTC().Format(sqliteDatetimeFormat)
	id, err := recordModerationAction(ctx, tx, "timeout", targetID, actorID, reportID, reason, &expires)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("TimeoutUser commit: %w", err)
	}
	return id, nil
}

// LiftTimeout ends targetID's active timeout early, guarded on EXISTS(users)
// for actorID (a concurrently erased lifter cannot land). Reports whether a
// row was lifted; false means there was no active timeout to lift.
func (d *DB) LiftTimeout(ctx context.Context, targetID, actorID int64) (bool, error) {
	row, err := d.q.GetActiveTimeout(ctx, targetID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("LiftTimeout: %w", err)
	}
	n, err := d.q.LiftTimeout(ctx, dbgen.LiftTimeoutParams{LiftedBy: actorID, ActionID: row.ID})
	if err != nil {
		return false, fmt.Errorf("LiftTimeout: %w", err)
	}
	return n == 1, nil
}

// HasActiveTimeout is the one indexed lookup permissions.Checker.Subject and
// service.PermissionService.Subject run, uncached, to fill Subject.TimedOut.
func (d *DB) HasActiveTimeout(ctx context.Context, userID int64) (bool, error) {
	active, err := d.q.HasActiveTimeout(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("HasActiveTimeout: %w", err)
	}
	return active != 0, nil
}

// AcknowledgeWarning marks actionID acknowledged for userID — own rows
// only. Reports whether a row was updated; false covers a foreign id, an
// already-acknowledged one, and a non-warning id alike, so this can never be
// used to probe another user's warning ids.
func (d *DB) AcknowledgeWarning(ctx context.Context, userID, actionID int64) (bool, error) {
	n, err := d.q.AcknowledgeWarning(ctx, dbgen.AcknowledgeWarningParams{ID: actionID, TargetID: userID})
	if err != nil {
		return false, fmt.Errorf("AcknowledgeWarning: %w", err)
	}
	return n == 1, nil
}

// ListUnacknowledgedWarnings is ready's notices slot.
func (d *DB) ListUnacknowledgedWarnings(ctx context.Context, userID int64) ([]ModerationNotice, error) {
	rows, err := d.q.ListUnacknowledgedWarnings(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("ListUnacknowledgedWarnings: %w", err)
	}
	out := make([]ModerationNotice, 0, len(rows))
	for _, r := range rows {
		out = append(out, ModerationNotice{ID: r.ID, Kind: r.Kind, Reason: r.Reason, CreatedAt: r.CreatedAt})
	}
	return out, nil
}

// ListModerationActionsForTarget is GET /api/v1/moderation/users/{id}/actions.
func (d *DB) ListModerationActionsForTarget(ctx context.Context, targetID int64) ([]ModerationAction, error) {
	rows, err := d.q.ListModerationActionsForTarget(ctx, targetID)
	if err != nil {
		return nil, fmt.Errorf("ListModerationActionsForTarget: %w", err)
	}
	out := make([]ModerationAction, 0, len(rows))
	for _, r := range rows {
		out = append(out, moderationActionFromRow(r))
	}
	return out, nil
}

// ListModerationActionsForReport is the queue detail's "actions taken" list.
func (d *DB) ListModerationActionsForReport(ctx context.Context, reportID int64) ([]ModerationAction, error) {
	rows, err := d.q.ListModerationActionsForReport(ctx, &reportID)
	if err != nil {
		return nil, fmt.Errorf("ListModerationActionsForReport: %w", err)
	}
	out := make([]ModerationAction, 0, len(rows))
	for _, r := range rows {
		out = append(out, moderationActionFromRow(r))
	}
	return out, nil
}

// BanUserWithAction is BanUser plus a ledger row, in one transaction
// (B5-9): a failure recording the row rolls the ban back too, so a ban
// never lands without the ledger entry an appeal will need to reference.
func (d *DB) BanUserWithAction(ctx context.Context, targetID int64, reason string, expires *time.Time, actorID int64, reportID *int64) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("BanUserWithAction begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	var expiresStr *string
	if expires != nil {
		s := expires.UTC().Format("2006-01-02T15:04:05Z")
		expiresStr = &s
	}
	reasonCopy := reason
	if err := dbgen.New(tx).BanUser(ctx, dbgen.BanUserParams{
		BanReason: &reasonCopy, BanExpires: expiresStr, ID: targetID,
	}); err != nil {
		return 0, fmt.Errorf("BanUserWithAction: %w", err)
	}
	id, err := recordModerationAction(ctx, tx, "ban", targetID, actorID, reportID, reason, nil)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("BanUserWithAction commit: %w", err)
	}
	return id, nil
}

// ForceLogoutWithAction is ForceLogoutUser plus a ledger row, in one
// transaction: a failure recording the row rolls the session revocation
// back too.
func (d *DB) ForceLogoutWithAction(ctx context.Context, targetID, actorID int64, reportID *int64) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("ForceLogoutWithAction begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if err := dbgen.New(tx).ForceLogoutUser(ctx, targetID); err != nil {
		return 0, fmt.Errorf("ForceLogoutWithAction: %w", err)
	}
	id, err := recordModerationAction(ctx, tx, "kick", targetID, actorID, reportID, "all sessions terminated", nil)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("ForceLogoutWithAction commit: %w", err)
	}
	return id, nil
}

// tableExists reports whether name is a table in the database's own schema
// (sqlite_master), so a retention sweep can adapt to a table B5-10 has not
// landed yet without a compile-time dependency on it.
func tableExists(ctx context.Context, q interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}, name string) bool {
	var got string
	err := q.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&got)
	return err == nil
}

// RetireModerationActions is the maintenance-tick retention sweep
// (moderation.action_retention_days): warning rows retire `days` after
// acknowledged_at, timeout rows the same number of days after expires_at or
// lifted_at when lifted early. Ban, kick and removal rows are never touched.
//
// B5-10: once the appeals table exists, this must additionally exclude any
// id an appeals row references (appeals.action_id) — the join is not written
// yet because the table does not exist on this branch. tableExists guards
// against running that join prematurely; extend it here when B5-10 lands
// rather than adding a second sweep.
func (d *DB) RetireModerationActions(ctx context.Context, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	if tableExists(ctx, d.writer, "appeals") {
		// B5-10: exclude ids referenced by an appeals row before deleting.
		// Falling through to the unconditional sweep below would be wrong
		// once appeals exist, so refuse to guess at the join shape here.
		return 0, fmt.Errorf("RetireModerationActions: appeals table exists but B5-9 has no exclusion query for it (B5-10 must add one)")
	}
	cutoff := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour).Format(sqliteDatetimeFormat)
	n, err := d.q.RetireRetiredCandidates(ctx, &cutoff)
	if err != nil {
		return 0, fmt.Errorf("RetireModerationActions: %w", err)
	}
	return n, nil
}
