package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// AppealService is the B5-10 rate-limited appeal against a moderation
// action (BPR-073, plan decision 8). It owns submission, the appellant's
// own status view, withdrawal, and the moderation queue's assignment and
// decision — the deciding-moderator self-review rule in particular.
//
// Appeal ids returned and accepted by this type's methods are the opaque
// public id (the Codex-review deviation from the HP-5 draft recorded in
// migration 050's header): the sequential internal id is used only inside
// this package and never reaches a response, a route parameter or the
// mod_queue frame, for the identical reason reports adopted one (P2-9).
type AppealService struct {
	st    Store
	perms *PermissionService
	// moderation is reused for LiftTimeout/UnbanUser/AcknowledgeWarning (the
	// overturn effects) and for requireOutranksRole's identical hierarchy
	// rule, package-private — same package, not exported.
	moderation *ModerationService
	limiter    *auth.RateLimiter
	notifier   AppealStatusNotifier
}

// AppealStatusNotifier delivers a live appeal_status frame to the
// appellant. *ws.Hub implements it.
type AppealStatusNotifier interface {
	NotifyAppealStatus(userID int64, publicID, state string, decisionNote *string)
}

// NewAppealService creates an AppealService.
func NewAppealService(st Store, perms *PermissionService, moderation *ModerationService, limiter *auth.RateLimiter) *AppealService {
	return &AppealService{st: st, perms: perms, moderation: moderation, limiter: limiter}
}

// SetNotifier installs the live appeal_status notifier.
func (s *AppealService) SetNotifier(n AppealStatusNotifier) { s.notifier = n }

func (s *AppealService) notify(userID int64, publicID, state string, decisionNote *string) {
	if s.notifier != nil {
		s.notifier.NotifyAppealStatus(userID, publicID, state, decisionNote)
	}
}

// appealBodyMaxRunes and appealNoteMaxRunes bound the two free-text fields
// (S6 storage exhaustion, the same shape reports' maxDetailRunes/
// maxNoteRunes apply). decisionNote is shown to the appellant, so it is
// held to the same audit-detail denylist as reason on moderation_actions.
const (
	appealBodyMaxRunes = 4000
	appealNoteMaxRunes = 2000
)

// appealRateLimit and appealRateWindow are decision 8's per-user rolling
// cap: 3 submissions per 24 hours. The key is "appeal:<user id>" — a
// dedicated prefix, never shared with "report" (Server/auth/ratelimit.go's
// Key), so a reporter's quota is never consumed by an appellant or vice
// versa.
const (
	appealRateLimit  = 3
	appealRateWindow = 24 * time.Hour
)

// appealableKinds are the moderation-action kinds decision 8 allows an
// appeal against: warning, timeout and removal always. "kick" is excluded
// deliberately — a force-logout persists nothing to appeal, the target
// simply signs back in. "ban" is included, but is reachable only when the
// target CAN authenticate: AuthMiddleware rejects every currently
// effectively-banned caller on every route (api/middleware.go), including
// this one, so a "ban"-kind submission can only ever arrive from a target
// whose ban has since lapsed or been reversed — a currently-banned target
// cannot reach this endpoint at all. A ban appeal from a target who is
// STILL banned has no path in beta; docs/api.md records that it must
// arrive out of band (the operator's contact).
var appealableKinds = map[string]bool{"warning": true, "timeout": true, "removal": true, "ban": true}

// ErrAlreadyAppealed is a 409: an appeal against this action already
// exists, in ANY state (decision 8 — a decided appeal cannot be
// re-appealed, and the UNIQUE(action_id) constraint is the memory that
// enforces it).
var ErrAlreadyAppealed = fmt.Errorf("%w: an appeal against this action already exists", ErrConflict)

// errAppealActionNotFound is Submit's one refusal for both an unknown
// action id and one whose target is not the caller (P2-5's rule, applied
// here): a distinguishable message would itself be an existence oracle.
var errAppealActionNotFound = fmt.Errorf("%w: action not found", ErrNotFound)

// Submit files an appeal against actionID. Rules, in order (decision 8):
// the caller must be the action's target (else 404, no oracle); the
// action's kind must be appealable; the rate limit (429); no existing
// appeal against this action in any state (409 ALREADY_APPEALED). Returns
// the new appeal's public id.
func (s *AppealService) Submit(ctx context.Context, appellantID, actionID int64, body string) (string, error) {
	if actionID <= 0 {
		return "", fmt.Errorf("%w: action_id must be positive", ErrBadRequest)
	}
	if len([]rune(body)) > appealBodyMaxRunes {
		return "", fmt.Errorf("%w: body is too long", ErrBadRequest)
	}
	if hasControlChar(body) {
		return "", fmt.Errorf("%w: body contains control characters", ErrBadRequest)
	}

	action, err := s.st.GetModerationAction(ctx, actionID)
	if err != nil || action.TargetID == 0 || action.TargetID != appellantID {
		return "", errAppealActionNotFound
	}
	if !appealableKinds[action.Kind] {
		return "", fmt.Errorf("%w: this action cannot be appealed", ErrBadRequest)
	}

	if s.limiter != nil && !s.limiter.Allow(auth.Key("appeal", appellantID), appealRateLimit, appealRateWindow) {
		return "", ErrRateLimited
	}

	if existing, err := s.st.FindAppealForAction(ctx, actionID); err != nil {
		return "", fmt.Errorf("%w: %w", ErrInternal, err)
	} else if existing > 0 {
		return "", ErrAlreadyAppealed
	}

	publicID, err := newPublicID()
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if _, err := s.st.InsertAppeal(ctx, publicID, actionID, appellantID, body); err != nil {
		if errors.Is(err, db.ErrConflict) {
			// The UNIQUE(action_id) race-proof half of decision 8: a second
			// submission landed between FindAppealForAction's pre-check and
			// this insert.
			return "", ErrAlreadyAppealed
		}
		return "", fmt.Errorf("%w: %w", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the appeal committed.
	// The detail is the action kind word only, never the appeal body.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, appellantID, "appeal_submit", "moderation_action", actionID, action.Kind)

	slog.Info("appeal submitted", "appellant_id", appellantID, "action_id", actionID, "kind", action.Kind)
	return publicID, nil
}

// AppealMineRow is one row of the appellant's own view (GET
// /api/v1/appeals/mine): the appeal plus the appealed action's kind,
// reason and created_at — never the assignee, never who decided it.
type AppealMineRow struct {
	PublicID        string
	ActionKind      string
	ActionReason    string
	ActionCreatedAt string
	State           string
	DecisionNote    *string
	CreatedAt       string
	DecidedAt       *string
}

// Mine returns the caller's own appeals, resolving each row's action kind/
// reason/created_at for display.
func (s *AppealService) Mine(ctx context.Context, appellantID int64) ([]AppealMineRow, error) {
	rows, err := s.st.ListAppealsMine(ctx, appellantID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	out := make([]AppealMineRow, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		row := AppealMineRow{
			PublicID: r.PublicID, State: r.State, CreatedAt: r.CreatedAt, DecidedAt: r.DecidedAt,
		}
		if r.State == "upheld" || r.State == "overturned" {
			note := r.DecisionNote
			row.DecisionNote = &note
		}
		if action, err := s.st.GetModerationAction(ctx, r.ActionID); err == nil {
			row.ActionKind = action.Kind
			row.ActionReason = action.Reason
			row.ActionCreatedAt = action.CreatedAt
		}
		out = append(out, row)
	}
	return out, nil
}

// resolveOwn resolves publicID to the caller's own appeal row, or
// ErrNotFound — indistinguishable whether the id is unknown or belongs to
// someone else, the same no-oracle rule Submit's own refusal follows.
func (s *AppealService) resolveOwn(ctx context.Context, appellantID int64, publicID string) (*db.Appeal, error) {
	a, err := s.st.GetAppealByPublicID(ctx, publicID)
	if err != nil || a.AppellantID != appellantID {
		return nil, fmt.Errorf("%w: appeal not found", ErrNotFound)
	}
	return a, nil
}

// Withdraw withdraws the caller's own appeal — the appellant only, open or
// assigned states only. Nothing leaves a decided or already-withdrawn
// state.
func (s *AppealService) Withdraw(ctx context.Context, appellantID int64, publicID string) error {
	a, err := s.resolveOwn(ctx, appellantID, publicID)
	if err != nil {
		return err
	}
	ok, err := s.st.WithdrawAppeal(ctx, a.ID, appellantID)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return fmt.Errorf("%w: appeal is already decided", ErrConflict)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, appellantID, "appeal_withdraw", "appeal", a.ID, "")
	s.notify(a.AppellantID, a.PublicID, "withdrawn", nil)
	return nil
}

// ResolveAppealID translates a public id — the only identifier a route
// parameter ever carries — to the internal id used for broadcasting a
// queue change after a write (mirrors ReportService.ResolveReportID). 404s
// on an unknown public id. Not permission-gated: like PublicIDFor,
// resolving an id the caller's own write just touched discloses nothing
// new.
func (s *AppealService) ResolveAppealID(ctx context.Context, publicID string) (int64, error) {
	a, err := s.st.GetAppealByPublicID(ctx, publicID)
	if err != nil {
		return 0, fmt.Errorf("%w: appeal not found", ErrNotFound)
	}
	return a.ID, nil
}

// RequireModerate is requireModerate exported for a handler that must
// authorize BEFORE resolving anything else about the request (mirrors
// ReportService.RequireModerate) — running the id resolution first turns
// "unknown id" and "real id, no permission" into two different status
// codes, an existence oracle through the handler's own order of
// operations.
func (s *AppealService) RequireModerate(ctx context.Context, actorID int64) error {
	_, err := s.requireModerate(ctx, actorID)
	return err
}

// requireModerate loads actorID's role and checks the canonical predicate
// (permissions.CanModerate), returning the role for a follow-up hierarchy
// check. Runs before any appeal lookup, so an actor without the bit sees
// Forbidden regardless of whether the appeal id exists.
func (s *AppealService) requireModerate(ctx context.Context, actorID int64) (*db.Role, error) {
	role, err := s.perms.GetRoleForUser(ctx, actorID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to load role", ErrForbidden)
	}
	if err := permissions.CanModerate(permissions.Subject{RolePerms: role.Permissions}); err != nil {
		return nil, fmt.Errorf("%w: missing MODERATE_MEMBERS permission", ErrForbidden)
	}
	return role, nil
}

// Queue lists appeals for the moderator view: state is "open", "assigned",
// "decided" (both terminal decision states together), or "" for the
// default open+assigned view.
func (s *AppealService) Queue(ctx context.Context, actorID int64, state string) ([]db.AppealQueueRow, error) {
	if _, err := s.requireModerate(ctx, actorID); err != nil {
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
	return rows, nil
}

// AppealDetail is GET .../appeals/{id}'s payload: the appeal, the appealed
// action, and the action's linked report id (internal — the handler
// resolves it to a public id through ReportService.PublicIDFor), when one
// exists.
type AppealDetail struct {
	Appeal db.Appeal
	Action db.ModerationAction
}

// Get returns one appeal with its appealed action. 404 for an unknown id;
// no confidentiality rule beyond the bit — unlike a report, an appeal's
// existence is not something its appellant or the acting moderator must be
// kept unaware of.
func (s *AppealService) Get(ctx context.Context, actorID int64, publicID string) (*AppealDetail, error) {
	if _, err := s.requireModerate(ctx, actorID); err != nil {
		return nil, err
	}
	appeal, err := s.st.GetAppealByPublicID(ctx, publicID)
	if err != nil {
		return nil, fmt.Errorf("%w: appeal not found", ErrNotFound)
	}
	action, err := s.st.GetModerationAction(ctx, appeal.ActionID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return &AppealDetail{Appeal: *appeal, Action: *action}, nil
}

// guardAppellantSelfReview refuses a moderator acting on their own filed
// appeal — the mirror of report.go's guardSelfReview, and a DIFFERENT rule
// from checkSelfReview's acting-moderator check: an appellant who happens to
// also hold MODERATE_MEMBERS must never assign or decide the very appeal
// they filed, with NO sole-moderator escape (unlike checkSelfReview, there
// is no honest "forced to judge your own case" argument for the appellant —
// on a one-moderator install their appeal simply waits for a second
// moderator to exist, which is a governance gap, not a bug this service
// papers over).
func (s *AppealService) guardAppellantSelfReview(actorID int64, appeal *db.Appeal) error {
	if appeal.AppellantID != 0 && appeal.AppellantID == actorID {
		return ErrSelfReview
	}
	return nil
}

// Assign assigns appeal publicID to actorID. 409 if it is already assigned
// to someone else, unless force is set and the caller outranks the current
// assignee (the same rule ban/kick/timeout and the report queue use).
func (s *AppealService) Assign(ctx context.Context, actorID int64, publicID string, force bool) error {
	actorRole, err := s.requireModerate(ctx, actorID)
	if err != nil {
		return err
	}
	appeal, err := s.st.GetAppealByPublicID(ctx, publicID)
	if err != nil {
		return fmt.Errorf("%w: appeal not found", ErrNotFound)
	}
	if err := s.guardAppellantSelfReview(actorID, appeal); err != nil {
		return err
	}
	observed := appeal.AssigneeID
	if observed != 0 && observed != actorID {
		if !force {
			return fmt.Errorf("%w: already assigned", ErrConflict)
		}
		if err := s.assignAppealForced(ctx, appeal.ID, actorID, observed, actorRole.Position); err != nil {
			return err
		}
	} else if err := s.assignAppealPlain(ctx, appeal.ID, actorID, observed); err != nil {
		return err
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "appeal_assign", "appeal", appeal.ID, "")
	s.notify(appeal.AppellantID, appeal.PublicID, "assigned", nil)
	return nil
}

// assignAppealForced is Assign's force-reassign branch: actorRolePosition
// must outrank the observed assignee's fresh position.
func (s *AppealService) assignAppealForced(ctx context.Context, appealID, actorID, observed int64, actorRolePosition int) error {
	ok, err := s.st.AssignAppealForced(ctx, appealID, actorID, observed, int64(actorRolePosition))
	if err != nil {
		if errors.Is(err, db.ErrForbidden) {
			return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
		}
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return fmt.Errorf("%w: appeal is no longer open", ErrConflict)
	}
	return nil
}

// assignAppealPlain is Assign's ordinary branch: no current assignee, or the
// caller re-assigning to themselves.
func (s *AppealService) assignAppealPlain(ctx context.Context, appealID, actorID, observed int64) error {
	ok, err := s.st.AssignAppeal(ctx, appealID, actorID, observed)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return fmt.Errorf("%w: appeal is no longer open", ErrConflict)
	}
	return nil
}

// validAppealOutcomes is Decide's outcome enum.
var validAppealOutcomes = map[string]bool{"upheld": true, "overturned": true}

// checkSelfReview is decision 8's deciding-moderator rule: the moderator
// who took the action may not decide its own appeal WHERE ANOTHER eligible
// moderator exists — eligible meaning a different user holding CanModerate.
// When the acting moderator is the only eligible one, they may decide, and
// the caller must record that in the audit detail ("sole moderator").
// actionActorID == 0 (the action's actor already erased) never triggers
// self-review — there is no "self" left to protect against.
func (s *AppealService) checkSelfReview(ctx context.Context, actorID, actionActorID int64) (soleModerator bool, err error) {
	if actionActorID == 0 || actionActorID != actorID {
		return false, nil
	}
	eligible, err := s.st.CountEligibleModerators(ctx, actorID, permissions.ModerateMembers, permissions.Administrator)
	if err != nil {
		return false, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if eligible > 0 {
		return false, ErrSelfReview
	}
	return true, nil
}

// Decide records outcome ("upheld" or "overturned") against appeal
// publicID, refusing the acting moderator's own action's appeal where
// another eligible moderator exists (checkSelfReview). Upholding changes
// nothing further; overturning applies the kind-specific effect
// (applyOverturn). Both audit appeal_decide with the outcome word.
func (s *AppealService) Decide(ctx context.Context, actorID int64, publicID, outcome, note string) error {
	if _, err := s.requireModerate(ctx, actorID); err != nil {
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
	if err := s.guardAppellantSelfReview(actorID, appeal); err != nil {
		return err
	}
	action, err := s.st.GetModerationAction(ctx, appeal.ActionID)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	soleModerator, err := s.checkSelfReview(ctx, actorID, action.ActorID)
	if err != nil {
		return err
	}

	ok, err := s.st.DecideAppeal(ctx, appeal.ID, outcome, actorID, note)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return fmt.Errorf("%w: appeal already decided or withdrawn", ErrConflict)
	}

	if outcome == "overturned" {
		s.applyOverturn(ctx, actorID, action)
	}

	detail := outcome
	if soleModerator {
		detail = outcome + " (sole moderator)"
	}
	// Audit rows must survive a request canceled after the decision committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "appeal_decide", "appeal", appeal.ID, detail)
	s.notify(appeal.AppellantID, appeal.PublicID, outcome, &note)

	slog.Info("appeal decided", "actor_id", actorID, "appeal_id", appeal.ID, "outcome", outcome, "sole_moderator", soleModerator)
	return nil
}

// applyOverturn applies the kind-specific effect of overturning action
// (decided by decidedBy): timeout is lifted through B5-9's LiftTimeout
// (which also handles its voice half and the live mod_action frame); ban
// is undone through UnbanUser; warning is acknowledged, so the notice
// disappears from the target's next connect. Removal has nothing to
// restore — the content is gone. A failure here (e.g. nothing left to
// lift, or the deciding moderator lacks the kind-specific permission the
// underlying method itself gates on) is logged and swallowed: the appeal
// decision itself has already committed, and the decision is the primary
// contract this method's caller owes.
func (s *AppealService) applyOverturn(ctx context.Context, decidedBy int64, action *db.ModerationAction) {
	ctx = context.WithoutCancel(ctx)
	if s.moderation == nil {
		return
	}
	switch action.Kind {
	case "timeout":
		if err := s.moderation.LiftTimeout(ctx, decidedBy, action.TargetID); err != nil && !errors.Is(err, ErrNotFound) {
			slog.Warn("appeal overturn: LiftTimeout failed", "action_id", action.ID, "err", err)
		}
	case "ban":
		if err := s.moderation.UnbanUser(ctx, decidedBy, action.TargetID); err != nil {
			slog.Warn("appeal overturn: UnbanUser failed", "action_id", action.ID, "err", err)
		}
	case "warning":
		if err := s.moderation.AcknowledgeWarning(ctx, action.TargetID, action.ID); err != nil && !errors.Is(err, ErrNotFound) {
			slog.Warn("appeal overturn: AcknowledgeWarning failed", "action_id", action.ID, "err", err)
		}
	case "removal":
		// Nothing to restore — the content is gone.
	}
}
