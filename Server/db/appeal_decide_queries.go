package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// AppealWriteOutcome is the guarded-write result of DecideAppealTx, so the
// service can map each reason to its own HTTP status.
type AppealWriteOutcome int

const (
	// AppealWriteOK: the write (and, for an overturn, its reversal) landed.
	AppealWriteOK AppealWriteOutcome = iota
	// AppealWriteConflict: the observed state/assignee was stale, or the
	// deciding/assigning moderator no longer resolves to a user at all.
	AppealWriteConflict
	// AppealWriteSelfReview: another eligible reviewer exists.
	AppealWriteSelfReview
	// AppealWriteReversalFailed: the UPDATE would have succeeded but the overturn
	// hit a real reversal error, so the whole transaction rolled back; the
	// appellant is never told "overturned" while the sanction stands.
	AppealWriteReversalFailed
	// AppealWriteForbidden: the decider's authority (CanModerate bit or an
	// effective ban) no longer held when re-checked inside the transaction.
	AppealWriteForbidden
)

// appealReversalHookForTest forces applyAppealReversalTx to fail so a test can
// prove nothing commits. Test-only; set via SetAppealReversalHookForTest.
var appealReversalHookForTest func() error

// ReversalAuditActionFor names the audit action a kind's reversal writes,
// using the same words as the moderation service. ok=false for "removal"
// (nothing to audit). The service writes this row best-effort after
// DecideAppealTx commits.
func ReversalAuditActionFor(kind string) (action string, ok bool) {
	switch kind {
	case "timeout":
		return "user_untimeout", true
	case "ban":
		return "user_unban", true
	case "warning":
		return "user_warning_acknowledged", true
	default: // "removal"
		return "", false
	}
}

// applyAppealReversalTx runs the overturn's kind-specific reversal on the same
// transaction as the decision's UPDATE, so a failure rolls the decision back.
// It is a store-level consequence, not a second moderation action. The
// actor's authority is checked by AppealService.Decide beforehand, and the
// outrank half is re-checked live in DecideAppealTx. Zero rows affected is not
// an error (the action may already be superseded or lifted); affected reports
// whether anything changed, so the caller audits only a real reversal.
func applyAppealReversalTx(ctx context.Context, tx *sql.Tx, q *dbgen.Queries, kind string, actionID, targetID int64) (affected bool, err error) {
	if appealReversalHookForTest != nil {
		if err := appealReversalHookForTest(); err != nil {
			return false, err
		}
	}
	switch kind {
	case "timeout":
		n, err := q.LiftTimeoutByActionID(ctx, actionID)
		if err != nil {
			return false, fmt.Errorf("lift timeout: %w", err)
		}
		return n > 0, nil
	case "ban":
		// Hand-rolled: sqlc's SQLite analyzer silently drops the second bind when a
		// distinct parameter is reused inside a NOT EXISTS subquery (confirmed on
		// v1.30). Unban only when no strictly newer 'ban' action exists for the
		// target, so ban, unban, re-ban, overturn-first-ban leaves the user banned.
		// The tie-break is the autoincrement id, not created_at, whose one-second
		// resolution can tie two ban rows and make a ">" comparison always false.
		res, err := tx.ExecContext(ctx, `
			UPDATE users
			   SET banned = 0, ban_reason = NULL, ban_expires = NULL
			 WHERE id = ?
			   AND banned = 1
			   AND NOT EXISTS (
			       SELECT 1 FROM moderation_actions
			        WHERE target_id = ? AND kind = 'ban' AND id > ?
			   )`, targetID, targetID, actionID)
		if err != nil {
			return false, fmt.Errorf("lift ban: %w", err)
		}
		n, err := res.RowsAffected()
		return n > 0, err
	case "warning":
		n, err := q.AcknowledgeWarning(ctx, dbgen.AcknowledgeWarningParams{ID: actionID, TargetID: targetID})
		if err != nil {
			return false, fmt.Errorf("acknowledge warning: %w", err)
		}
		return n > 0, nil
	case "removal":
		// Nothing to restore — the content is gone.
		return false, nil
	}
	return false, nil
}

// AppealedAction is the part of the appealed moderation_actions row that
// DecideAppealTx's reversal needs, resolved once by the caller.
type AppealedAction struct {
	ID       int64
	Kind     string
	TargetID int64
}

// appealDecideInTxHook is the DecideAppealTx counterpart of
// appealAssignInTxHook. Test-only.
var appealDecideInTxHook func(ctx context.Context, q *dbgen.Queries) error

// DecideAppealTx decides appealID in one transaction: a fresh authority
// re-check (checkAuthority), the self-review eligibility test (when
// checkSelfReview) run only after confirming the row is still the one the
// caller observed, the guarded UPDATE on the observed state and assignee, and,
// for an overturn, the reversal. soleModerator reports whether the self-review
// escape applied; reversalApplied reports whether the reversal changed
// anything. The reversal's audit row is written by the caller after commit,
// because audit writes are best-effort and a rolled-back transaction must not
// leave one behind.
func (d *DB) DecideAppealTx(
	ctx context.Context,
	appealID int64,
	observedState string,
	observedAssigneeID int64,
	outcome string,
	decidedBy int64,
	note string,
	checkSelfReview bool,
	appellantID, permBit, adminBit int64,
	action AppealedAction,
	checkAuthority func(rolePerms int64, banned bool, banExpires *string) error,
) (result AppealWriteOutcome, soleModeratorUsed, reversalApplied bool, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return AppealWriteConflict, false, false, fmt.Errorf("DecideAppealTx begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := dbgen.New(tx)

	if appealDecideInTxHook != nil {
		if err := appealDecideInTxHook(ctx, q); err != nil {
			return AppealWriteConflict, false, false, fmt.Errorf("DecideAppealTx test hook: %w", err)
		}
	}

	// Authority is re-read fresh, never trusted from before the transaction.
	if checkAuthority != nil {
		rolePerms, banned, banExpires, ok := deciderAuthority(ctx, tx, decidedBy)
		if !ok {
			return AppealWriteConflict, false, false, nil
		}
		if checkAuthority(rolePerms, banned, banExpires) != nil {
			return AppealWriteForbidden, false, false, nil
		}
	}

	// An overturn re-checks live that the decider strictly outranks the target,
	// so a decider demoted since the service's cached check cannot still commit
	// the reversal. "removal" is excluded (overturning it is record-only).
	if outcome == "overturned" && action.Kind != "removal" {
		if !strictlyOutranks(ctx, tx, decidedBy, action.TargetID) {
			return AppealWriteForbidden, false, false, nil
		}
	}

	// Reject a stale or terminal appeal before the eligibility test, so a decide
	// that will fail its guarded write anyway skips the EXISTS cost.
	rowStillObserved, err := q.AppealObservedRowExists(ctx, dbgen.AppealObservedRowExistsParams{
		ID: appealID, ObservedState: observedState, ObservedAssigneeID: observedAssigneeID,
	})
	if err != nil {
		return AppealWriteConflict, false, false, fmt.Errorf("DecideAppealTx observed-row check: %w", err)
	}
	if rowStillObserved == 0 {
		return AppealWriteConflict, false, false, nil
	}

	if checkSelfReview {
		eligible, err := q.EligibleModeratorExists(ctx, dbgen.EligibleModeratorExistsParams{
			ExcludeActorID: decidedBy, ExcludeAppellantID: appellantID, PermBit: permBit, AdminBit: adminBit,
		})
		if err != nil {
			return AppealWriteConflict, false, false, fmt.Errorf("DecideAppealTx eligibility: %w", err)
		}
		if eligible > 0 {
			return AppealWriteSelfReview, false, false, nil
		}
		soleModeratorUsed = true
	}

	n, err := q.DecideAppeal(ctx, dbgen.DecideAppealParams{
		NewState: outcome, DecidedBy: decidedBy, DecisionNote: note, ID: appealID,
		ObservedState: observedState, ObservedAssigneeID: observedAssigneeID,
	})
	if err != nil {
		return AppealWriteConflict, false, false, fmt.Errorf("DecideAppealTx: %w", err)
	}
	if n != 1 {
		return AppealWriteConflict, false, false, nil
	}

	// The reversal runs inside this transaction before the commit, so a failure
	// rolls the decision UPDATE back too.
	if outcome == "overturned" {
		reversalApplied, err = applyAppealReversalTx(ctx, tx, q, action.Kind, action.ID, action.TargetID)
		if err != nil {
			return AppealWriteReversalFailed, false, false, fmt.Errorf("DecideAppealTx reversal: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return AppealWriteConflict, false, false, fmt.Errorf("DecideAppealTx commit: %w", err)
	}
	return AppealWriteOK, soleModeratorUsed, reversalApplied, nil
}
