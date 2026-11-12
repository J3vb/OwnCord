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

// Queue lists appeals for the moderator view: state "open", "assigned", "decided" or ""
// for open+assigned. The caller's own appeal is omitted so a moderator cannot learn who is
// assigned to it or how the queue fills around it.
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

// AppealDetail is the payload of GET .../appeals/{id}: the appeal and the appealed action.
type AppealDetail struct {
	Appeal db.Appeal
	Action db.ModerationAction
}

// Get returns one appeal with its appealed action; 404 for an unknown id. A moderator
// appellant gets 403 SELF_REVIEW on their OWN appeal: no existence oracle there, and the
// read would show who is assigned and who decided.
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

// guardAppellantSelfReview refuses a moderator acting on their own appeal. Unlike the
// eligibility check inside the Assign/Decide transactions it has NO sole-moderator
// escape: on a one-moderator install the appeal waits for a second moderator.
func (s *AppealService) guardAppellantSelfReview(actorID int64, appeal *db.Appeal) error {
	if appeal.AppellantID != 0 && appeal.AppellantID == actorID {
		return ErrSelfReview
	}
	return nil
}

// Assign assigns appeal publicID to actorID; 409 if assigned to someone else unless force
// is set and the caller outranks the assignee. The self-review rule runs INSIDE both
// assignment transactions so a late second moderator cannot go uncaught.
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

type assignAppealFn func(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64,
	checkSelfReview bool, appellantID, permBit, adminBit int64,
	checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (bool, error)

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

// ErrReversalFailed is a 409: the overturn's reversal failed, so the whole decision
// rolled back rather than telling the appellant "overturned" while the sanction stands.
var ErrReversalFailed = fmt.Errorf("%w: could not apply the decision's effect", ErrConflict)

// Decide records outcome ("upheld" or "overturned"). An overturn first passes
// requireOverturnAuthority. Self-review count, guarded write and reversal run in ONE
// transaction (db.DecideAppealTx), so a moderator banned or erased meanwhile, or a failing
// reversal, cannot land an unsupported decision. Audits appeal_decide.
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

// checkModeratorAuthority is DecideAppealTx's and AssignAppealTx's fresh check: perms and
// ban state are read inside the guarded write's transaction, not trusted from
// requireModerate. A revoked bit or ban that landed first refuses (db.AppealWriteForbidden).
func (s *AppealService) checkModeratorAuthority(rolePerms int64, banned bool, banExpires *string) error {
	if auth.IsEffectivelyBanned(&db.User{Banned: banned, BanExpires: banExpires}) {
		return ErrForbidden
	}
	return permissions.CanModerate(permissions.Subject{RolePerms: rolePerms})
}
