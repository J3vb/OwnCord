package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Queue lists appeals for the moderator view: state is "open", "assigned",
// "decided" (both terminal states) or "" for open+assigned. An appeal whose
// appellant is the CALLER is omitted, as reports' Queue does: a moderator must
// not learn who is assigned to, or how the queue fills around, their OWN appeal.
func (s *AppealService) Queue(ctx context.Context, actorID int64, state string) ([]db.AppealQueueRow, error) {
	if err := requireModerate(ctx, s.perms, actorID); err != nil {
		return nil, err
	}
	switch state {
	case "", "open", "assigned", "decided":
	default:
		return nil, fmt.Errorf("%w: invalid state", ErrBadRequest)
	}
	rows, err := s.st.ListAppealsQueue(ctx, state)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	out := make([]db.AppealQueueRow, 0, len(rows))
	for i := range rows {
		if r := &rows[i]; r.AppellantID == 0 || r.AppellantID != actorID {
			out = append(out, *r)
		}
	}
	return out, nil
}

// AppealDetail is the payload of GET .../appeals/{id}: the appeal and the
// appealed action.
type AppealDetail struct {
	Appeal db.Appeal
	Action db.ModerationAction
}

// Get returns one appeal with its appealed action; 404 for an unknown id. A
// moderator-appellant is refused their OWN appeal with 403 SELF_REVIEW. Unlike a
// report's subject (NotFound, who must not learn the report exists), an appellant
// already knows their appeal exists, so there is no oracle; the refusal is the
// guardAppellantSelfReview conflict-of-interest rule applied to the read that
// would show who is assigned and who decided.
func (s *AppealService) Get(ctx context.Context, actorID int64, publicID string) (*AppealDetail, error) {
	if err := requireModerate(ctx, s.perms, actorID); err != nil {
		return nil, err
	}
	appeal, err := s.st.GetAppealByPublicID(ctx, publicID)
	if err != nil {
		return nil, fmt.Errorf("%w: appeal not found", ErrNotFound)
	}
	if err := s.guardAppellantSelfReview(actorID, appeal); err != nil {
		return nil, err
	}
	action, err := s.st.GetModerationAction(ctx, appeal.ActionID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return &AppealDetail{Appeal: *appeal, Action: *action}, nil
}

// guardAppellantSelfReview refuses a moderator acting on their own filed appeal
// (the mirror of report.go's GuardSelfReviewFor). It differs from the
// deciding-moderator eligibility check inside DecideAppealTx/AssignAppealTx/
// AssignAppealForced and has NO sole-moderator escape: on a one-moderator install
// the appeal waits for a second moderator, a governance gap this service does not
// paper over.
func (s *AppealService) guardAppellantSelfReview(actorID int64, appeal *db.Appeal) error {
	if appeal.AppellantID != 0 && appeal.AppellantID == actorID {
		return ErrSelfReview
	}
	return nil
}

// Assign assigns appeal publicID to actorID. 409 if already assigned to someone
// else, unless force is set and the caller outranks the current assignee (as
// ban/kick/timeout and the report queue). Symmetric with Decide's self-review
// rule: the moderator who took the appealed action may not assign it to
// themself where another eligible reviewer exists. That test runs INSIDE both
// assignment transactions, so a second eligible moderator appearing between a
// pre-check and the write cannot go uncaught.
func (s *AppealService) Assign(ctx context.Context, actorID int64, publicID string, force bool) error {
	if err := requireModerate(ctx, s.perms, actorID); err != nil {
		return err
	}
	appeal, err := s.st.GetAppealByPublicID(ctx, publicID)
	if err != nil {
		return fmt.Errorf("%w: appeal not found", ErrNotFound)
	}
	unlock := s.locks.lock(publicID)
	defer unlock()

	if err := s.guardAppellantSelfReview(actorID, appeal); err != nil {
		return err
	}
	action, err := s.st.GetModerationAction(ctx, appeal.ActionID)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	needsSelfReviewCheck := action.ActorID != 0 && action.ActorID == actorID

	observed := appeal.AssigneeID
	if observed != 0 && observed != actorID {
		if !force {
			return fmt.Errorf("%w: already assigned", ErrConflict)
		}
		if err := s.assignAppeal(ctx, s.st.AssignAppealForced, appeal.ID, actorID, observed, needsSelfReviewCheck, appeal.AppellantID); err != nil {
			return err
		}
	} else if err := s.assignAppeal(ctx, s.st.AssignAppealTx, appeal.ID, actorID, observed, needsSelfReviewCheck, appeal.AppellantID); err != nil {
		return err
	}
	if appealPostWriteHookForTest != nil {
		appealPostWriteHookForTest(publicID)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "appeal_assign", "appeal", appeal.ID, "")
	s.notify(appeal.AppellantID, appeal.PublicID, "assigned", nil)
	s.notifyQueue(ctx, appeal.ID, "assigned")
	return nil
}

// assignAppealFn is the store write assignAppeal drives: AssignAppealForced for
// force-reassign, AssignAppealTx otherwise.
type assignAppealFn func(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64,
	checkSelfReview bool, appellantID, permBit, adminBit int64,
	checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (bool, error)

// assignAppeal is Assign's single write branch. The forced path requires actorID
// to outrank the observed assignee's fresh position, read inside the write's
// transaction (see forceReassignGuarded); the plain path (no current assignee, or
// re-assigning to oneself) re-checks authority freshly in its own transaction, as
// Decide does. checkSelfReview runs inside that same transaction.
func (s *AppealService) assignAppeal(ctx context.Context, assign assignAppealFn, appealID, actorID, observed int64, checkSelfReview bool, appellantID int64) error {
	ok, err := assign(ctx, appealID, actorID, observed, actorID, checkSelfReview, appellantID,
		permissions.ModerateMembers, permissions.Administrator, s.checkModeratorAuthority)
	if err != nil {
		if errors.Is(err, db.ErrForbidden) {
			return fmt.Errorf("%w: cannot moderate this appeal", ErrForbidden)
		}
		if errors.Is(err, db.ErrSelfReview) {
			return ErrSelfReview
		}
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return fmt.Errorf("%w: appeal is no longer open", ErrConflict)
	}
	return nil
}

var validAppealOutcomes = map[string]bool{"upheld": true, "overturned": true}

// ErrReversalFailed is a 409: the overturn's reversal hit a genuine error, so the
// whole decision rolled back and the appellant was never told "overturned" while
// the sanction stayed in effect.
var ErrReversalFailed = fmt.Errorf("%w: could not apply the decision's effect", ErrConflict)

// Decide records outcome ("upheld" or "overturned") against appeal publicID. An
// overturn first passes requireOverturnAuthority: the decider must outrank the
// sanctioned target and, for a ban, hold BAN_MEMBERS, as the direct reversal path
// enforces. The self-review count, the guarded write (on the OBSERVED
// state/assignee) and the overturn's reversal run in ONE transaction
// (db.DecideAppealTx), so a moderator banned or erased in between, or a failing
// reversal, cannot land a decision the data no longer supports. Upholding changes
// nothing further. Both audit appeal_decide with the outcome word.
func (s *AppealService) Decide(ctx context.Context, actorID int64, publicID, outcome, note string) error {
	if err := requireModerate(ctx, s.perms, actorID); err != nil {
		return err
	}
	if !validAppealOutcomes[outcome] {
		return fmt.Errorf("%w: invalid outcome", ErrBadRequest)
	}
	if len([]rune(note)) > appealNoteMaxRunes {
		return fmt.Errorf("%w: decision note is too long", ErrBadRequest)
	}
	if hasControlChar(note) {
		return fmt.Errorf("%w: decision note contains control characters", ErrBadRequest)
	}

	appeal, err := s.st.GetAppealByPublicID(ctx, publicID)
	if err != nil {
		return fmt.Errorf("%w: appeal not found", ErrNotFound)
	}
	unlock := s.locks.lock(publicID)
	defer unlock()

	if err := s.guardAppellantSelfReview(actorID, appeal); err != nil {
		return err
	}
	action, err := s.st.GetModerationAction(ctx, appeal.ActionID)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if outcome == "overturned" {
		if err := s.requireOverturnAuthority(ctx, actorID, action); err != nil {
			return err
		}
	}

	needsSelfReviewCheck := action.ActorID != 0 && action.ActorID == actorID
	result, soleModerator, reversalApplied, err := s.st.DecideAppealTx(ctx, appeal.ID, appeal.State, appeal.AssigneeID, outcome, actorID, note,
		needsSelfReviewCheck, appeal.AppellantID, permissions.ModerateMembers, permissions.Administrator,
		db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}, s.checkModeratorAuthority)
	if err != nil {
		slog.Error("appeal decide: transaction error", "appeal_id", appeal.ID, "action_id", action.ID, "err", err)
		// A failed reversal has its own conflict outcome below; any other error
		// is a database failure, not a lost race.
		if result != db.AppealWriteReversalFailed {
			return fmt.Errorf("%w: %w", ErrInternal, err)
		}
	}
	switch result {
	case db.AppealWriteOK:
	case db.AppealWriteSelfReview:
		return ErrSelfReview
	case db.AppealWriteReversalFailed:
		return ErrReversalFailed
	case db.AppealWriteForbidden:
		// The decider's own bit was revoked, or a ban landed, after requireModerate.
		return fmt.Errorf("%w: missing MODERATE_MEMBERS permission", ErrForbidden)
	default: // db.AppealWriteConflict: the observed row changed or was already decided.
		return fmt.Errorf("%w: appeal already decided or withdrawn", ErrConflict)
	}
	if appealPostWriteHookForTest != nil {
		appealPostWriteHookForTest(publicID)
	}

	detail := outcome
	if soleModerator {
		detail = outcome + " (sole moderator)"
	}
	// Audit rows must survive a request canceled after the decision committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "appeal_decide", "appeal", appeal.ID, detail)
	s.applyOverturnReversalEffects(ctx, appeal, action, outcome, reversalApplied)
	s.notify(appeal.AppellantID, appeal.PublicID, outcome, &note)
	s.notifyQueue(ctx, appeal.ID, outcome)

	slog.Info("appeal decided", "actor_id", actorID, "appeal_id", appeal.ID, "outcome", outcome, "sole_moderator", soleModerator)
	return nil
}

// checkModeratorAuthority is DecideAppealTx's and AssignAppealTx's fresh
// authority check: rolePerms/banned/banExpires are read live inside the same
// transaction as the guarded write, not trusted from requireModerate's earlier,
// possibly stale check. permissions.CanModerate is the canonical predicate;
// auth.IsEffectivelyBanned keeps ban-lapse parsing in one place. A revoked bit or
// a ban that landed first refuses (db.AppealWriteForbidden).
func (s *AppealService) checkModeratorAuthority(rolePerms int64, banned bool, banExpires *string) error {
	if auth.IsEffectivelyBanned(&db.User{Banned: banned, BanExpires: banExpires}) {
		return ErrForbidden
	}
	return permissions.CanModerate(permissions.Subject{RolePerms: rolePerms})
}
