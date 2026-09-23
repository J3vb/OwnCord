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

// moderationActionRow mirrors dbgen.ModerationAction's field set, letting
// moderationActionFromRow convert it (and, historically, a second
// query-specific row type) without duplicating the field-by-field copy.
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
	if moderationActionPreRankCheckHook != nil {
		moderationActionPreRankCheckHook()
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
	if moderationActionPreInsertHook != nil {
		moderationActionPreInsertHook()
	}
	return insertModerationActionRow(ctx, tx, kind, targetID, actorID, reportID, reason, expiresAt)
}

// moderationActionPreRankCheckHook, when non-nil, runs inside
// recordModerationAction's transaction, BEFORE either rolePosition call —
// the window between BeginTx (already open by the time this function runs;
// BanUserWithAction's own effect write, BanUser, has already landed too)
// and the rank snapshot itself. Test-only (nil in production): the
// contention test's second interleaving (Codex review follow-up) uses this
// to force a concurrent role change to contend for the writer connection
// one step earlier than moderationActionPreInsertHook does, so the "cannot
// preempt an in-flight decision" property is proved at both ends of the
// rank check, not just after it.
var moderationActionPreRankCheckHook func()

// moderationActionPreInsertHook, when non-nil, runs after the rank check has
// read both positions and before the insert — while tx, and so the writer's
// one connection, is still held open. Test-only (nil in production),
// mirroring ws's voiceModDeafenPreMuteRaceHook: it is the barrier a
// db-package contention test (P2-12, Codex review) uses to force a REAL
// second writer — a role change on the same target, from another goroutine —
// to actually contend for that one connection while this transaction is
// open, rather than merely simulating the race by calling this function
// twice in sequence. Set via SetModerationActionPreInsertHookForTest.
var moderationActionPreInsertHook func()

// moderationActionPreBeginTxHook, when non-nil, runs at the very top of
// BanUserWithAction, before BeginTx is even called — no transaction open,
// no connection held yet. Test-only (nil in production): P2-12 PARTIAL's
// (Codex review round 3) gap in the original contention test used a barrier
// placed AFTER BeginTx, which stays green even if a future refactor moved
// the rank-position read to run on a bare (non-tx) connection before
// BeginTx — a regression that reopens exactly the window a live connection
// re-acquisition could land a promotion in. This hook lets a test force a
// concurrent promotion to complete in full BEFORE this call ever opens its
// transaction, proving the eventual rank check (which must run live, INSIDE
// the tx, to see it) still refuses correctly.
var moderationActionPreBeginTxHook func()

// recordLedgerRow is "removal"'s ledger write: no rank guard (see
// recordModerationAction's doc comment for why one would be wrong here) —
// a DELIBERATE, reviewed exception (Codex review DECISION, not a gap):
// removal is governed by channel MANAGE_MESSAGES alone, as it always was
// before this ledger existed, unlike warning/timeout/kick/ban, which all
// additionally require the actor to outrank the target. BPR-072 assigns
// removal to the MANAGE_MESSAGES bit on exactly that basis. This applies
// through every entry point removal has, including the report-linked one
// (ModerationService.ActOnReport, kind="removal") — there is no second,
// stricter removal path anywhere that a rank check would apply to instead.
// It carries, still, the absence-proof actor guard every kind carries, plus the
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
// effect is the row, read back by HasActiveTimeout through the predicates —
// and, in the same transaction, supersedes (lifts) any other still-active
// timeout row for targetID (P2-9, Codex review): without this a repeated
// timeout left overlapping active rows and LiftTimeout only ever reached the
// newest one, orphaning the rest.
//
// Ownership of an outstanding SFU mute lives on the voice session, not this
// ledger (voice_states.server_muted_by, round 4, Codex review — see
// migration 049's comment for the full rationale). Superseding a row that
// owns a mute must transfer it to the NEW row, or that mute is stranded
// once LiftTimeout stops acting on the superseded one — but the transfer
// itself does NOT happen here (round 5, Codex review P2): it runs inside
// MuteForTimeoutSession's own transaction, under the ws-layer per-target
// lock the voice half already holds, so it can never land between that
// lock's DB write and its paired SFU call (the exact gap a transfer here,
// outside the lock, would race). TimeoutUser only returns the superseded
// ids for the caller (service.applyTimeoutVoiceHalf) to pass through.
func (d *DB) TimeoutUser(ctx context.Context, targetID, actorID int64, reportID *int64, reason string, expiresAt time.Time) (id int64, supersededIDs []int64, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, nil, fmt.Errorf("TimeoutUser begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	expires := expiresAt.UTC().Format(sqliteDatetimeFormat)
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

// transferVoiceMuteOwnership repoints voice_states.server_muted_by from any
// of fromIDs onto toID, inside tx. Hand-rolled (a dynamic IN list, mirroring
// the bulk-delete pattern in message_queries.go) rather than sqlc: the
// number of superseded rows is unbounded in principle (P2-9's defensive
// lift-all applies here too), so no fixed-arity generated query fits.
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

// LiftTimeout ends targetID's active timeout(s) early. It re-checks the
// actor strictly outranks the target LIVE, inside this transaction (P2-8,
// Codex review — this previously had no rank re-check at all, so a demoted
// moderator could still cancel a superior's sanction), then lifts EVERY
// still-active timeout row for targetID (P2-9: TimeoutUser's supersede keeps
// this to normally one row, but a defensive lift-all costs nothing). Returns
// the ids just lifted, so the caller can clear whichever voice_states row (if
// any) is currently owned by one of them (db.ClearServerMuteOwnedBy,
// round 4) — session-bound for free, since ownership no longer lives on
// this ledger.
func (d *DB) LiftTimeout(ctx context.Context, targetID, actorID int64) (liftedIDs []int64, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("LiftTimeout begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	actorPos, ok := rolePosition(ctx, tx, actorID)
	if !ok {
		return nil, fmt.Errorf("LiftTimeout: %w", ErrOutranked)
	}
	targetPos, ok := rolePosition(ctx, tx, targetID)
	if !ok {
		// A missing target is treated as an unbeatable rank — see
		// recordModerationAction's identical posture.
		targetPos = math.MaxInt
	}
	if actorPos <= targetPos {
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

// LiftTimeoutActionsByID marks each of ids lifted (lifted_at IS NULL AND
// kind = 'timeout', i.e. still active — an already-lifted or non-timeout id
// is silently skipped, not an error), inside tx: callable inside a CALLER's
// own transaction, not just LiftTimeout's (round 4, B5-10 addendum) — an
// appeal overturn lifts a timeout by its specific action id inside the
// appeal-decision transaction, and LiftTimeout above resolves ITS ids via
// ListActiveTimeouts first, then calls this same primitive with them. This
// function does ONLY the ledger write: no rank check, no voice half, no
// audit row — the caller owns authorization and post-commit effects
// (service.ModerationService.FinalizeTimeoutLift is the shared post-commit
// half both callers use). Returns exactly the ids that were genuinely still
// active and are now lifted.
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

// BanUserWithAction is BanUser plus a ledger row, in one transaction
// (B5-9): a failure recording the row rolls the ban back too, so a ban
// never lands without the ledger entry an appeal will need to reference.
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
// back too. reason is the ledger row's text; empty falls back to the fixed
// phrase "all sessions terminated" — every direct caller today (P2-10,
// Codex review: only the report-linked path, ActOnReport, has a caller-
// submitted reason to store).
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
// B5-10 wires the join this comment used to say was missing: an id an
// appeals row references (appeals.action_id) is excluded from the sweep —
// decision 8's UNIQUE(action_id) memory that forbids re-appealing an action
// must not be swept out from under a decided appeal. In ordinary operation
// migration 050 has always run by the time this executes, so the
// tableExists check below is a defensive fallback (a database caught
// mid-migration, or a test that seeds a bare moderation_actions table
// without the rest of the schema) rather than the expected path.
func (d *DB) RetireModerationActions(ctx context.Context, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour).Format(sqliteDatetimeFormat)
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
