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

// ModerationAction is one row of the moderator-action ledger: every warning,
// timeout, kick, ban and removal. ActorToken is filled by erasure when the
// acting moderator erased their account; LiftedBy is a bare id with no token
// column, like reports.assignee_id.
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

// ModerationNotice is one unacknowledged warning, as ready's notices slot and
// the acknowledgement route need it; it carries no actor or report link.
type ModerationNotice struct {
	ID        int64
	Kind      string
	Reason    string
	CreatedAt string
}

// moderationActionRow mirrors dbgen.ModerationAction's fields so
// moderationActionFromRow avoids a field-by-field copy per row type.
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

// ErrOutranked is recordModerationAction's refusal: the actor does not
// strictly outrank the target by role position at write time. Every moderator
// action routes through that function, so a target promoted since the
// service's cached check is refused here. The writer pool is a single
// connection, so the position read is atomic with the insert against any
// concurrent role change.
var ErrOutranked = errors.New("moderation: actor does not outrank target")

// rolePosition reads the position of userID's top role live, inside tx. A
// failed lookup returns ok=false, which callers treat as "refuse".
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

// strictlyOutranks reports whether actorID strictly outranks targetID by role
// position, read live inside tx. recordModerationAction, LiftTimeout and an
// appeal overturn all use it so a demotion since an earlier cached check
// governs. A missing actor role refuses; a missing target role is unbeatable.
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

// recordModerationAction is the one ledger write for warning, timeout, kick
// and ban, in the same tx as the kind's effect. The rank guard is re-validated
// live against the current roles table, mirroring ModerationService's check.
//
// Not used for "removal": DeleteMessage and PurgeMessages authorize on channel
// MANAGE_MESSAGES alone with no hierarchy requirement, and a bulk purge's
// ledger entry targets the actor, so this guard would wrongly refuse both. See
// recordLedgerRow.
//
// actorID <= 0 is refused first: every ledger row must carry a human actor.
// The service enforces this too, but all four kinds funnel through here.
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
	// A missing target (erased or never existed) is treated as unbeatable rather
	// than a crash; the caller looked it up earlier, so this is the same race the
	// effect's own write faces.
	if !strictlyOutranks(ctx, tx, actorID, targetID) {
		return 0, ErrOutranked
	}
	if moderationActionPreInsertHook != nil {
		moderationActionPreInsertHook()
	}
	return insertModerationActionRow(ctx, tx, kind, targetID, actorID, reportID, reason, expiresAt)
}

// moderationActionPreRankCheckHook runs inside recordModerationAction's
// transaction before either rolePosition call, so a contention test can force
// a concurrent role change to contend for the writer connection one step
// earlier than moderationActionPreInsertHook. Test-only.
var moderationActionPreRankCheckHook func()

// moderationActionPreInsertHook runs after the rank check read both positions
// and before the insert, while tx still holds the writer's one connection. A
// contention test uses it to make a real second writer (a role change on the
// same target) contend for that connection. Test-only; set via
// SetModerationActionPreInsertHookForTest.
var moderationActionPreInsertHook func()

// moderationActionPreBeginTxHook runs at the top of BanUserWithAction before
// BeginTx, with no transaction open. It lets a test force a promotion to
// complete first, proving the rank check still runs live inside the tx; a
// barrier after BeginTx would stay green if the position read moved to a bare
// connection before it. Test-only.
var moderationActionPreBeginTxHook func()

// recordLedgerRow is "removal"'s ledger write. It has no rank guard on
// purpose (see recordModerationAction): removal is governed by channel
// MANAGE_MESSAGES alone through every entry point, including the report-linked
// one (ActOnReport, kind="removal"). It keeps the human-actor guard and an
// EXISTS(users) check (as in erasure.go) so a moderator erased between
// authorization and this write cannot land as a ledger row's actor;
// recordModerationAction gets that through its rank JOIN, this function has
// none. Callers do not need the new row's id.
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

// WarnUser writes a warning row, whose entire effect is the row: the target
// acknowledges it on next connect (AcknowledgeWarning) and a live target gets
// a mod_action frame. reportID links a report-linked warning.
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

// TimeoutUser writes a timeout row with the given expiry, whose entire effect
// is the row (read into Subject.TimedOut), and in the same transaction lifts
// any other still-active timeout for targetID, so LiftTimeout never orphans
// overlapping rows.
//
// Ownership of an SFU mute lives on the voice session
// (voice_states.server_muted_by), not this ledger. Superseding a row that
// owns a mute must transfer it to the new row, but that transfer runs inside
// MuteForTimeoutSession's transaction under the ws per-target lock, so it
// cannot land between that lock's DB write and its SFU call. TimeoutUser only
// returns supersededIDs for the caller (service.applyTimeoutVoiceHalf) to pass
// through.
func (d *DB) TimeoutUser(ctx context.Context, targetID, actorID int64, reportID *int64, reason string, expiresAt time.Time) (id int64, supersededIDs []int64, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, nil, fmt.Errorf("TimeoutUser begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	// SQLiteLayout, not ISOLayout: this table's other timestamps come from
	// datetime('now') and SQL compares expires_at with them as text.
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

// transferVoiceMuteOwnership repoints voice_states.server_muted_by from any of
// fromIDs onto toID, inside tx. Hand-rolled because the number of superseded
// rows is unbounded, so no fixed-arity sqlc query fits.
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

// LiftTimeout ends targetID's active timeouts early. It re-checks live, inside
// its transaction, that the actor strictly outranks the target, then lifts
// every still-active timeout row (normally one). It returns the lifted ids so
// the caller can clear the voice_states row owned by one of them
// (ClearServerMuteOwnedBy).
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

// LiftTimeoutActionsByID marks each of ids lifted if still an active timeout;
// an already-lifted or non-timeout id is skipped, not an error. It runs inside
// the caller's tx (LiftTimeout and an appeal overturn both use it) and does
// only the ledger write: no rank check, voice half or audit row. The caller
// owns authorization and post-commit effects
// (ModerationService.FinalizeTimeoutLift). It returns the ids actually lifted.
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

// HasActiveTimeout is the indexed lookup permissions.Checker.Subject runs,
// uncached, to fill Subject.TimedOut.
func (d *DB) HasActiveTimeout(ctx context.Context, userID int64) (bool, error) {
	active, err := d.q.HasActiveTimeout(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("HasActiveTimeout: %w", err)
	}
	return active != 0, nil
}

// AcknowledgeWarning marks actionID acknowledged for userID's own rows only.
// It returns false for a foreign id, an already-acknowledged one or a
// non-warning id alike, so it cannot probe another user's warning ids.
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

// BanUserWithAction is BanUser plus a ledger row in one transaction, so a ban
// never lands without the entry an appeal will reference.
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

// ForceLogoutWithAction is ForceLogoutUser plus a ledger row in one
// transaction. An empty reason falls back to "all sessions terminated"; only
// the report-linked path (ActOnReport) supplies one.
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

// tableExists reports whether name is a table in sqlite_master, so a retention
// sweep can adapt to a table (appeals) that may not exist yet.
func tableExists(ctx context.Context, q interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}, name string) bool {
	var got string
	err := q.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&got)
	return err == nil
}

// RetireModerationActions is the retention sweep (moderation.action_retention_days):
// warning rows retire `days` after acknowledged_at, timeout rows after
// expires_at or lifted_at when lifted early. Ban, kick and removal rows are
// never touched.
//
// An id an appeals row references (appeals.action_id) is excluded, because
// the UNIQUE(action_id) memory that forbids re-appealing must survive. The
// tableExists check is a fallback for a database caught mid-migration or a
// test with a bare moderation_actions table.
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
