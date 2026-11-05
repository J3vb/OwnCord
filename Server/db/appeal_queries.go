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
