package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// Appeal is a row of the appeals table. DecidedByToken is filled by erasure
// (bare id plus token): a zero id plus a non-empty token means the deciding
// moderator erased their account. PublicID is the only identifier exposed
// outside the server, because sequential ids would let a moderator infer a
// hidden appeal from a gap.
type Appeal struct {
	ID             int64
	PublicID       string
	ActionID       int64
	AppellantID    int64
	Body           string
	State          string
	AssigneeID     int64
	DecidedBy      int64
	DecidedByToken string
	DecisionNote   string
	CreatedAt      string
	DecidedAt      *string
}

// AppealSummary is one row of the appellant's own view, which never shows the
// assignee or who decided.
type AppealSummary struct {
	ID           int64
	PublicID     string
	ActionID     int64
	Body         string
	State        string
	DecisionNote string
	CreatedAt    string
	DecidedAt    *string
}

// AppealQueueRow is one row of the moderation appeal queue.
type AppealQueueRow struct {
	ID           int64
	PublicID     string
	ActionID     int64
	AppellantID  int64
	Body         string
	State        string
	AssigneeID   int64
	DecidedBy    int64
	DecisionNote string
	CreatedAt    string
	DecidedAt    *string
}

func appealFromRow(r dbgen.Appeal) Appeal {
	return Appeal{
		ID: r.ID, PublicID: r.PublicID, ActionID: r.ActionID, AppellantID: r.AppellantID,
		Body: r.Body, State: r.State, AssigneeID: r.AssigneeID, DecidedBy: r.DecidedBy,
		DecidedByToken: strOrEmpty(r.DecidedByToken), DecisionNote: r.DecisionNote,
		CreatedAt: r.CreatedAt, DecidedAt: r.DecidedAt,
	}
}

// FindAppealForAction returns the appeal id for an action, or 0, nil when none
// exists. It is only a fast-path check; InsertAppeal's UNIQUE(action_id)
// mapping is what enforces one appeal per action.
func (d *DB) FindAppealForAction(ctx context.Context, actionID int64) (int64, error) {
	id, err := d.q.FindAppealForAction(ctx, actionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("FindAppealForAction: %w", err)
	}
	return id, nil
}

// appealInsertPreHookForTest runs just before InsertAppeal's INSERT so a test
// can hold two goroutines in flight at the same point. Test-only.
var appealInsertPreHookForTest func()

// InsertAppeal files a new appeal; the caller generates publicID. A
// UNIQUE(action_id) violation returns ErrConflict. The INSERT's WHERE EXISTS
// guard turns an action erased since the caller's lookup into sql.ErrNoRows,
// mapped to ErrNotFound.
func (d *DB) InsertAppeal(ctx context.Context, publicID string, actionID, appellantID int64, body string) (int64, error) {
	if appealInsertPreHookForTest != nil {
		appealInsertPreHookForTest()
	}
	id, err := d.q.InsertAppeal(ctx, dbgen.InsertAppealParams{
		PublicID: publicID, ActionID: actionID, AppellantID: appellantID, Body: body,
	})
	if err != nil {
		if IsUniqueConstraintError(err) {
			return 0, fmt.Errorf("InsertAppeal: %w", ErrConflict)
		}
		if errors.Is(err, sql.ErrNoRows) {
			return 0, fmt.Errorf("InsertAppeal: action no longer exists: %w", ErrNotFound)
		}
		return 0, fmt.Errorf("InsertAppeal: %w", err)
	}
	return id, nil
}

// GetAppeal returns one appeal by its internal id, or ErrNotFound.
func (d *DB) GetAppeal(ctx context.Context, id int64) (*Appeal, error) {
	r, err := d.q.GetAppealByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("GetAppeal: %w", err)
	}
	a := appealFromRow(r)
	return &a, nil
}

// GetAppealByPublicID resolves the opaque public id every route parameter
// and API response carries to the appeal row, or ErrNotFound.
func (d *DB) GetAppealByPublicID(ctx context.Context, publicID string) (*Appeal, error) {
	r, err := d.q.GetAppealByPublicID(ctx, publicID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("GetAppealByPublicID: %w", err)
	}
	a := appealFromRow(r)
	return &a, nil
}

// ListAppealsMine returns the appellant's own appeals.
func (d *DB) ListAppealsMine(ctx context.Context, appellantID int64) ([]AppealSummary, error) {
	rows, err := d.q.ListAppealsMine(ctx, appellantID)
	if err != nil {
		return nil, fmt.Errorf("ListAppealsMine: %w", err)
	}
	out := make([]AppealSummary, 0, len(rows))
	for _, r := range rows {
		out = append(out, AppealSummary{
			ID: r.ID, PublicID: r.PublicID, ActionID: r.ActionID, Body: r.Body,
			State: r.State, DecisionNote: r.DecisionNote, CreatedAt: r.CreatedAt, DecidedAt: r.DecidedAt,
		})
	}
	return out, nil
}

// ListAppealsQueue returns the moderation queue for one state filter: "open",
// "assigned", "decided" (both terminal states), or "" for open plus assigned.
func (d *DB) ListAppealsQueue(ctx context.Context, state string) ([]AppealQueueRow, error) {
	build := func(rows []AppealQueueRow, err error) ([]AppealQueueRow, error) {
		if err != nil {
			return nil, fmt.Errorf("ListAppealsQueue: %w", err)
		}
		return rows, nil
	}
	switch state {
	case "decided":
		rows, err := d.q.ListAppealsDecided(ctx)
		out := make([]AppealQueueRow, 0, len(rows))
		for i := range rows {
			r := &rows[i]
			out = append(out, AppealQueueRow{
				ID: r.ID, PublicID: r.PublicID, ActionID: r.ActionID, AppellantID: r.AppellantID,
				Body: r.Body, State: r.State, AssigneeID: r.AssigneeID, DecidedBy: r.DecidedBy,
				DecisionNote: r.DecisionNote, CreatedAt: r.CreatedAt, DecidedAt: r.DecidedAt,
			})
		}
		return build(out, err)
	case "open", "assigned":
		rows, err := d.q.ListAppealsByState(ctx, state)
		out := make([]AppealQueueRow, 0, len(rows))
		for i := range rows {
			r := &rows[i]
			out = append(out, AppealQueueRow{
				ID: r.ID, PublicID: r.PublicID, ActionID: r.ActionID, AppellantID: r.AppellantID,
				Body: r.Body, State: r.State, AssigneeID: r.AssigneeID, DecidedBy: r.DecidedBy,
				DecisionNote: r.DecisionNote, CreatedAt: r.CreatedAt, DecidedAt: r.DecidedAt,
			})
		}
		return build(out, err)
	default:
		rows, err := d.q.ListAppealsOpenOrAssigned(ctx)
		out := make([]AppealQueueRow, 0, len(rows))
		for i := range rows {
			r := &rows[i]
			out = append(out, AppealQueueRow{
				ID: r.ID, PublicID: r.PublicID, ActionID: r.ActionID, AppellantID: r.AppellantID,
				Body: r.Body, State: r.State, AssigneeID: r.AssigneeID, DecidedBy: r.DecidedBy,
				DecisionNote: r.DecisionNote, CreatedAt: r.CreatedAt, DecidedAt: r.DecidedAt,
			})
		}
		return build(out, err)
	}
}

// AssignAppeal assigns assigneeID to appeal id, guarded on state,
// observedAssigneeID (optimistic concurrency, like AssignReport) and
// EXISTS(users). It returns false on a conflict and does no authority
// re-check; AssignAppealTx is the service entry point.
func (d *DB) AssignAppeal(ctx context.Context, id, assigneeID, observedAssigneeID int64) (bool, error) {
	n, err := d.q.AssignAppeal(ctx, dbgen.AssignAppealParams{AssigneeID: assigneeID, ID: id, ObservedAssigneeID: observedAssigneeID})
	if err != nil {
		return false, fmt.Errorf("AssignAppeal: %w", err)
	}
	return n == 1, nil
}

// DecideAppeal is the guarded decide UPDATE alone, with no precheck and no
// transaction; DecideAppealTx wraps it. It is exported so a test can prove the
// UPDATE's own guard refuses a stale write, independent of
// AppealObservedRowExists.
func (d *DB) DecideAppeal(ctx context.Context, id int64, observedState string, observedAssigneeID int64, newState string, decidedBy int64, note string) (bool, error) {
	n, err := d.q.DecideAppeal(ctx, dbgen.DecideAppealParams{
		NewState: newState, DecidedBy: decidedBy, DecisionNote: note, ID: id,
		ObservedState: observedState, ObservedAssigneeID: observedAssigneeID,
	})
	if err != nil {
		return false, fmt.Errorf("DecideAppeal: %w", err)
	}
	return n == 1, nil
}

// appealAssignInTxHook runs inside AssignAppealTx's transaction right after
// BeginTx, before the fresh reads it guards, and receives that transaction's
// Queries so a test can mutate state on the same tx. Test-only.
var appealAssignInTxHook func(ctx context.Context, q *dbgen.Queries) error

// appealSelfReviewCheck builds the closure AssignAppealTx and
// forceReassignGuarded call inside their transaction to evaluate the
// self-review eligibility test fresh. checkSelfReview false means always skip.
func appealSelfReviewCheck(ctx context.Context, actorID, appellantID, permBit, adminBit int64) func(q *dbgen.Queries) (bool, error) {
	return func(q *dbgen.Queries) (bool, error) {
		eligible, err := q.EligibleModeratorExists(ctx, dbgen.EligibleModeratorExistsParams{
			ExcludeActorID: actorID, ExcludeAppellantID: appellantID, PermBit: permBit, AdminBit: adminBit,
		})
		if err != nil {
			return false, err
		}
		return eligible > 0, nil
	}
}

// AssignAppealTx is the plain (non-forced) assign path in its own transaction.
// The acting moderator's authority (CanModerate bit, effective ban) is re-read
// inside the same transaction as the write and refuses with ErrForbidden when
// it no longer holds. With checkSelfReview the eligibility test also runs
// fresh in that transaction.
func (d *DB) AssignAppealTx(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64,
	checkSelfReview bool, appellantID, permBit, adminBit int64,
	checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (bool, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("AssignAppealTx begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := dbgen.New(tx)

	if appealAssignInTxHook != nil {
		if err := appealAssignInTxHook(ctx, q); err != nil {
			return false, fmt.Errorf("AssignAppealTx test hook: %w", err)
		}
	}

	if checkAuthority != nil {
		rolePerms, banned, banExpires, ok := deciderAuthority(ctx, tx, actorID)
		if !ok || checkAuthority(rolePerms, banned, banExpires) != nil {
			return false, fmt.Errorf("AssignAppealTx: %w", ErrForbidden)
		}
	}
	if checkSelfReview {
		refuse, err := appealSelfReviewCheck(ctx, actorID, appellantID, permBit, adminBit)(q)
		if err != nil {
			return false, fmt.Errorf("AssignAppealTx self-review: %w", err)
		}
		if refuse {
			return false, ErrSelfReview
		}
	}

	n, err := q.AssignAppeal(ctx, dbgen.AssignAppealParams{AssigneeID: assigneeID, ID: id, ObservedAssigneeID: observedAssigneeID})
	if err != nil {
		return false, fmt.Errorf("AssignAppealTx: %w", err)
	}
	if n != 1 {
		return false, nil
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("AssignAppealTx commit: %w", err)
	}
	return true, nil
}

// AssignAppealForced is the force-reassign path; see forceReassignGuarded in
// report_queries.go. checkAuthority and the self-review test run in the same
// transaction as the target's rank read; checkSelfReviewNeeded=false skips the
// latter.
func (d *DB) AssignAppealForced(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64,
	checkSelfReviewNeeded bool, appellantID, permBit, adminBit int64,
	checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (bool, error) {
	var selfReview func(q *dbgen.Queries) (bool, error)
	if checkSelfReviewNeeded {
		selfReview = appealSelfReviewCheck(ctx, actorID, appellantID, permBit, adminBit)
	}
	return forceReassignGuarded(ctx, d.writer, actorID, observedAssigneeID, checkAuthority, selfReview, func(q *dbgen.Queries) (int64, error) {
		return q.AssignAppeal(ctx, dbgen.AssignAppealParams{AssigneeID: assigneeID, ID: id, ObservedAssigneeID: observedAssigneeID})
	})
}

// WithdrawAppeal withdraws appeal id (appellant only, open or assigned). It
// returns false on a conflict.
func (d *DB) WithdrawAppeal(ctx context.Context, id, appellantID int64) (bool, error) {
	n, err := d.q.WithdrawAppeal(ctx, dbgen.WithdrawAppealParams{ID: id, AppellantID: appellantID})
	if err != nil {
		return false, fmt.Errorf("WithdrawAppeal: %w", err)
	}
	return n == 1, nil
}

// CountEligibleModerators counts every other user (excluding excludeActorID,
// excludeAppellantID, id 0 and anyone effectively banned) whose role holds
// permBit or adminBit. The acting moderator may decide their own appeal only
// when it is zero. The bits are passed in so db does not import permissions.
func (d *DB) CountEligibleModerators(ctx context.Context, excludeActorID, excludeAppellantID, permBit, adminBit int64) (int64, error) {
	n, err := d.q.CountUsersWithPermission(ctx, dbgen.CountUsersWithPermissionParams{
		ExcludeActorID: excludeActorID, ExcludeAppellantID: excludeAppellantID, PermBit: permBit, AdminBit: adminBit,
	})
	if err != nil {
		return 0, fmt.Errorf("CountEligibleModerators: %w", err)
	}
	return n, nil
}

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

// GetModerationAction returns one moderation_actions row by id, or
// ErrNotFound.
func (d *DB) GetModerationAction(ctx context.Context, id int64) (*ModerationAction, error) {
	r, err := d.q.GetModerationActionByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("GetModerationAction: %w", err)
	}
	a := moderationActionFromRow(moderationActionRow(r))
	return &a, nil
}
