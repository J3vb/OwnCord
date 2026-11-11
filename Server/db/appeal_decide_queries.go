package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// AppealWriteOutcome is DecideAppealTx's result, so the service can map each reason to
// an HTTP status.
type AppealWriteOutcome int

const (
	AppealWriteOK AppealWriteOutcome = iota
	// AppealWriteConflict: the observed state/assignee was stale, or the moderator no
	// longer resolves to a user.
	AppealWriteConflict
	AppealWriteSelfReview
	// AppealWriteReversalFailed: the overturn hit a real reversal error and the
	// whole transaction rolled back; the appellant is never told "overturned" while the
	// sanction stands.
	AppealWriteReversalFailed
	// AppealWriteForbidden: the decider's authority (CanModerate bit, effective ban) no
	// longer held when re-checked in the transaction.
	AppealWriteForbidden
)

// appealReversalHookForTest forces applyAppealReversalTx to fail so a test can prove
// nothing commits. Test-only.
var appealReversalHookForTest func() error

// ReversalAuditActionFor names the audit action a kind's reversal writes, with
// the moderation service's words; ok=false for "removal". The service writes it
// best-effort after commit.
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
// The actor's authority is checked by AppealService.Decide and the outrank half
// re-checked live in DecideAppealTx. Zero rows affected is not an error (the
// action may be superseded or lifted); affected says whether anything changed so
// only a real reversal is audited.
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
		// distinct parameter is reused inside a NOT EXISTS subquery. Unban only when no
		// strictly newer 'ban' action exists, so ban, unban, re-ban, overturn-first-ban
		// leaves the user banned. The tie-break is the autoincrement id, not
		// created_at, whose one-second resolution can tie two rows.
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
		return false, nil
	}
	return false, nil
}

// AppealedAction is the part of the appealed action the reversal needs.
type AppealedAction struct {
	ID       int64
	Kind     string
	TargetID int64
}

var appealDecideInTxHook func(ctx context.Context, q *dbgen.Queries) error

// DecideAppealTx decides appealID in one transaction: fresh authority re-check, the
// self-review test (when checkSelfReview) on the still-observed row, the guarded
// UPDATE, and for an overturn the reversal. soleModerator reports the self-review
// escape; reversalApplied whether the reversal changed anything. The caller writes the
// reversal's audit row after commit, so a rollback leaves none.
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

	if checkAuthority != nil {
		rolePerms, banned, banExpires, ok := deciderAuthority(ctx, tx, decidedBy)
		if !ok {
			return AppealWriteConflict, false, false, nil
		}
		if checkAuthority(rolePerms, banned, banExpires) != nil {
			return AppealWriteForbidden, false, false, nil
		}
	}

	// An overturn re-checks live that the decider strictly outranks the target, so
	// a decider demoted since the cached check cannot commit the reversal;
	// "removal" is excluded (record-only).
	if outcome == "overturned" && action.Kind != "removal" {
		if !strictlyOutranks(ctx, tx, decidedBy, action.TargetID) {
			return AppealWriteForbidden, false, false, nil
		}
	}

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
