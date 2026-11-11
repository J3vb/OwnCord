package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// ModerationAction is one row of the moderator-action ledger. ActorToken is filled by
// erasure; LiftedBy is a bare id with no token column.
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

// ModerationNotice is one unacknowledged warning, with no actor or report link.
type ModerationNotice struct {
	ID        int64
	Kind      string
	Reason    string
	CreatedAt string
}

type moderationActionRow struct {
	ID             int64
	Kind           string
	TargetID       int64
	ActorID        int64
	ActorToken     *string
	ReportID       *int64
	Reason         string
	ExpiresAt      *string
	AcknowledgedAt *string
	LiftedAt       *string
	LiftedBy       int64
	CreatedAt      string
}

func moderationActionFromRow(r moderationActionRow) ModerationAction {
	return ModerationAction{
		ID: r.ID, Kind: r.Kind, TargetID: r.TargetID, ActorID: r.ActorID,
		ActorToken: strOrEmpty(r.ActorToken), ReportID: r.ReportID, Reason: r.Reason,
		ExpiresAt: r.ExpiresAt, AcknowledgedAt: r.AcknowledgedAt, LiftedAt: r.LiftedAt,
		LiftedBy: r.LiftedBy, CreatedAt: r.CreatedAt,
	}
}

// ErrOutranked is recordModerationAction's refusal: the actor does not strictly
// outrank the target at write time. Every moderator action routes through it, so a
// target promoted since the service's cached check is refused; the single writer
// connection makes the position read atomic with the insert.
var ErrOutranked = errors.New("moderation: actor does not outrank target")

func rolePosition(ctx context.Context, tx *sql.Tx, userID int64) (int, bool) {
	var pos int
	err := tx.QueryRowContext(ctx,
		`SELECT r.position FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.position DESC, r.id ASC LIMIT 1`, userID,
	).Scan(&pos)
	if err != nil {
		return 0, false
	}
	return pos, true
}

// strictlyOutranks reads positions live inside tx so a demotion since an
// earlier cached check governs. A missing actor role refuses; a missing target role is unbeatable.
func strictlyOutranks(ctx context.Context, tx *sql.Tx, actorID, targetID int64) bool {
	actorPos, ok := rolePosition(ctx, tx, actorID)
	if !ok {
		return false
	}
	targetPos, ok := rolePosition(ctx, tx, targetID)
	if !ok {
		targetPos = math.MaxInt
	}
	return actorPos > targetPos
}

// recordModerationAction is the ledger write for warning, timeout, kick and ban, in
// the kind's own tx with the rank guard re-validated live (not "removal": see
// recordLedgerRow). actorID <= 0 is refused first.
func recordModerationAction(ctx context.Context, tx *sql.Tx, kind string, targetID, actorID int64, reportID *int64, reason string, expiresAt *string) (int64, error) {
	if actorID <= 0 {
		return 0, fmt.Errorf("recordModerationAction: %w", ErrOutranked)
	}
	if actorID == targetID {
		return 0, fmt.Errorf("recordModerationAction: actor equals target: %w", ErrOutranked)
	}
	if moderationActionPreRankCheckHook != nil {
		moderationActionPreRankCheckHook()
	}
	if !strictlyOutranks(ctx, tx, actorID, targetID) {
		return 0, ErrOutranked
	}
	if moderationActionPreInsertHook != nil {
		moderationActionPreInsertHook()
	}
	return insertModerationActionRow(ctx, tx, kind, targetID, actorID, reportID, reason, expiresAt)
}

// moderationActionPreRankCheckHook runs before either rolePosition call so a
// contention test can force a concurrent role change one step earlier. Test-only.
var moderationActionPreRankCheckHook func()

// moderationActionPreInsertHook runs after the rank check, before the insert, while tx
// holds the writer, so a test can contend for it. Test-only.
var moderationActionPreInsertHook func()

// moderationActionPreBeginTxHook runs before BeginTx in BanUserWithAction so a test
// can force a promotion first. Test-only.
var moderationActionPreBeginTxHook func()

// recordLedgerRow is "removal"'s ledger write, with no rank guard on purpose (channel
// MANAGE_MESSAGES alone governs) but with the human-actor guard and EXISTS(users), so
// an erased moderator cannot land as actor.
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

// WarnUser writes a warning row, whose entire effect is the row; the target
// acknowledges it on next connect. reportID links a report.
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

// TimeoutUser writes a timeout row, whose effect is the row (read into
// Subject.TimedOut), and in the same transaction lifts any other active
// timeout for targetID. An SFU mute's ownership lives on
// voice_states.server_muted_by and transfers inside MuteForTimeoutSession's
// transaction under the ws per-target lock; TimeoutUser only returns
// supersededIDs for service.applyTimeoutVoiceHalf.
func (d *DB) TimeoutUser(ctx context.Context, targetID, actorID int64, reportID *int64, reason string, expiresAt time.Time) (id int64, supersededIDs []int64, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, nil, fmt.Errorf("TimeoutUser begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	// SQLiteLayout, not ISOLayout: other timestamps here come from datetime('now') and compare as text.
	expires := expiresAt.UTC().Format(dbtime.SQLiteLayout)
	id, err = recordModerationAction(ctx, tx, "timeout", targetID, actorID, reportID, reason, &expires)
	if err != nil {
		return 0, nil, err
	}
	q := dbgen.New(tx)
	supersededIDs, err = q.SupersedeActiveTimeouts(ctx, dbgen.SupersedeActiveTimeoutsParams{
		LiftedBy: actorID, TargetID: targetID, ID: id,
	})
	if err != nil {
		return 0, nil, fmt.Errorf("TimeoutUser supersede: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, nil, fmt.Errorf("TimeoutUser commit: %w", err)
	}
	return id, supersededIDs, nil
}

// transferVoiceMuteOwnership repoints voice_states.server_muted_by from fromIDs
// onto toID inside tx; hand-rolled because the count is unbounded.
func transferVoiceMuteOwnership(ctx context.Context, tx *sql.Tx, fromIDs []int64, toID int64) error {
	placeholders := make([]string, len(fromIDs))
	args := make([]any, 0, len(fromIDs)+1)
	args = append(args, toID)
	for i, id := range fromIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}
	_, err := tx.ExecContext(ctx,
		"UPDATE voice_states SET server_muted_by = ? WHERE server_muted_by IN ("+strings.Join(placeholders, ",")+")", //nolint:gosec // placeholders are "?" repeated, not user input
		args...,
	)
	return err
}

// LiftTimeout ends targetID's active timeouts early after re-checking, inside its
// transaction, that the actor strictly outranks the target. It returns the lifted ids
// for ClearServerMuteOwnedBy.
func (d *DB) LiftTimeout(ctx context.Context, targetID, actorID int64) (liftedIDs []int64, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("LiftTimeout begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if !strictlyOutranks(ctx, tx, actorID, targetID) {
		return nil, ErrOutranked
	}

	ids, err := dbgen.New(tx).ListActiveTimeouts(ctx, targetID)
	if err != nil {
		return nil, fmt.Errorf("LiftTimeout: %w", err)
	}
	if len(ids) == 0 {
		return nil, nil
	}
	lifted, err := LiftTimeoutActionsByID(ctx, tx, ids, actorID)
	if err != nil {
		return nil, fmt.Errorf("LiftTimeout: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("LiftTimeout commit: %w", err)
	}
	return lifted, nil
}

// LiftTimeoutActionsByID marks each of ids lifted if still an active timeout; others
// are skipped. It runs in the caller's tx and does only the ledger write (no rank
// check, voice half or audit row; see ModerationService.FinalizeTimeoutLift),
// returning the ids lifted.
func LiftTimeoutActionsByID(ctx context.Context, tx *sql.Tx, ids []int64, liftedBy int64) ([]int64, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, 0, len(ids)+1)
	args = append(args, liftedBy)
	for i, id := range ids {
		placeholders[i] = "?"
		args = append(args, id)
	}
	rows, err := tx.QueryContext(ctx,
		"UPDATE moderation_actions SET lifted_at = datetime('now'), lifted_by = ?"+ //nolint:gosec // placeholders are "?" repeated, not user input
			" WHERE kind = 'timeout' AND lifted_at IS NULL AND id IN ("+strings.Join(placeholders, ",")+")"+
			" RETURNING id",
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("LiftTimeoutActionsByID: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("LiftTimeoutActionsByID scan: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// HasActiveTimeout is the uncached indexed lookup behind Subject.TimedOut.
func (d *DB) HasActiveTimeout(ctx context.Context, userID int64) (bool, error) {
	active, err := d.q.HasActiveTimeout(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("HasActiveTimeout: %w", err)
	}
	return active != 0, nil
}

// AcknowledgeWarning marks actionID acknowledged for userID's own rows; false for
// foreign, acknowledged or non-warning ids alike, so ids cannot be probed.
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
		out = append(out, moderationActionFromRow(moderationActionRow(r)))
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
		out = append(out, moderationActionFromRow(moderationActionRow(r)))
	}
	return out, nil
}

// BanUserWithAction is BanUser plus a ledger row in one transaction.
func (d *DB) BanUserWithAction(ctx context.Context, targetID int64, reason string, expires *time.Time, actorID int64, reportID *int64) (int64, error) {
	if moderationActionPreBeginTxHook != nil {
		moderationActionPreBeginTxHook()
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("BanUserWithAction begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	var expiresStr *string
	if expires != nil {
		s := expires.UTC().Format(dbtime.ISOLayout)
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

// ForceLogoutWithAction is ForceLogoutUser plus a ledger row in one transaction; an
// empty reason becomes "all sessions terminated".
func (d *DB) ForceLogoutWithAction(ctx context.Context, targetID, actorID int64, reportID *int64, reason string) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("ForceLogoutWithAction begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	if reason == "" {
		reason = "all sessions terminated"
	}

	if err := dbgen.New(tx).ForceLogoutUser(ctx, targetID); err != nil {
		return 0, fmt.Errorf("ForceLogoutWithAction: %w", err)
	}
	id, err := recordModerationAction(ctx, tx, "kick", targetID, actorID, reportID, reason, nil)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("ForceLogoutWithAction commit: %w", err)
	}
	return id, nil
}

func tableExists(ctx context.Context, q interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}, name string) bool {
	var got string
	err := q.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&got)
	return err == nil
}

// RetireModerationActions is the retention sweep: warning rows retire `days`
// after acknowledged_at, timeout rows after expires_at or lifted_at. Ban, kick
// and removal rows are never touched. An id an appeals row references is
// excluded so the UNIQUE(action_id) bar on re-appealing survives; tableExists
// covers a database mid-migration.
func (d *DB) RetireModerationActions(ctx context.Context, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour).Format(dbtime.SQLiteLayout)
	if tableExists(ctx, d.writer, "appeals") {
		n, err := d.q.RetireRetiredCandidatesExcludingAppealed(ctx, &cutoff)
		if err != nil {
			return 0, fmt.Errorf("RetireModerationActions: %w", err)
		}
		return n, nil
	}
	n, err := d.q.RetireRetiredCandidates(ctx, &cutoff)
	if err != nil {
		return 0, fmt.Errorf("RetireModerationActions: %w", err)
	}
	return n, nil
}
