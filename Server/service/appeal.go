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
	"github.com/J3vb/OwnCord/Server/syncutil"
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
	// moderation is used for requireOutranksRole's hierarchy rule and, since
	// round 4/5, FinalizeTimeoutLift — the overturn effects themselves
	// (LiftTimeoutByActionID, UnbanUser's ledger half, warning acknowledged)
	// run at the DB layer, inside DecideAppealTx's own transaction (F1
	// review), never through a second ModerationService call.
	moderation *ModerationService
	limiter    *auth.RateLimiter
	notifier   AppealStatusNotifier
	queue      AppealQueueBroadcaster
	locks      *appealLocker
}

// appealLocker is F4's per-appeal serialization: a transition's guarded
// write and its live notifies (appeal_status, mod_queue) must behave as one
// atomic unit from that appeal's own point of view, or a delayed transition
// can notify AFTER a later one already has — a stale Assign's "assigned"
// frame trailing behind a Decide's "overturned" one that the appellant
// already received. Submit, Assign, Decide and Withdraw all hold the
// appeal's own lock from just before touching the database through their
// own notify call, so no two transitions on the SAME appeal can ever have
// their notifies race each other out of commit order.
//
// Entries are reference-counted and evicted once nobody holds or is
// waiting on them (round 4 review, the same shape ws/voice_mod_lock.go's
// own round 5 took for the identical reason): every caller acquires the
// lock only AFTER the appeal is confirmed to exist and the caller is
// authorized to touch it (Submit: after its own insert commits; Withdraw:
// after resolveOwn confirms ownership; Assign/Decide: after the public id
// resolves to a real row), so an invented public id — reachable by any
// authenticated member calling withdraw in a loop, without ever touching
// decision 8's submission quota — never allocates an entry at all, and a
// real one does not linger once its writer is done with it.
type appealLocker struct {
	mu    syncutil.Mutex
	locks map[string]*appealLockEntry
}

// appealLockEntry is one appeal's lock plus how many callers currently
// hold it or are waiting to. refs is guarded by appealLocker.mu, not the
// entry's own lock — it must be adjusted at the same time as the map
// lookup so a concurrent lock() and the unlocking eviction check can never
// race each other into deleting an entry someone is about to wait on.
type appealLockEntry struct {
	mu   syncutil.Mutex
	refs int
}

func newAppealLocker() *appealLocker {
	return &appealLocker{locks: make(map[string]*appealLockEntry)}
}

// lock acquires publicID's own lock, blocking until held, and returns the
// func that releases it — `defer s.locks.lock(publicID)()`.
func (l *appealLocker) lock(publicID string) func() {
	l.mu.Lock()
	e, ok := l.locks[publicID]
	if !ok {
		e = &appealLockEntry{}
		l.locks[publicID] = e
	}
	e.refs++
	l.mu.Unlock()

	e.mu.Lock()
	return func() {
		e.mu.Unlock()
		l.mu.Lock()
		e.refs--
		if e.refs == 0 {
			delete(l.locks, publicID)
		}
		l.mu.Unlock()
	}
}

// AppealStatusNotifier delivers a live appeal_status frame to the
// appellant. *ws.Hub implements it.
type AppealStatusNotifier interface {
	NotifyAppealStatus(userID int64, publicID, state string, decisionNote *string)
}

// AppealQueueBroadcaster delivers a live mod_queue frame for an appeal
// state change. *ws.Hub implements it (the same method the API handler used
// to call after Assign/Decide/Withdraw returned). F4 review: moved to run
// from INSIDE the service, under the SAME per-appeal lock the appeal_status
// notify holds, so the two can never race each other out of commit order —
// the handler calling it separately, after the lock had already been
// released, is exactly what let a delayed transition's frame arrive after a
// later one's.
type AppealQueueBroadcaster interface {
	BroadcastAppealQueue(ctx context.Context, appealID int64, state string)
}

// NewAppealService creates an AppealService.
func NewAppealService(st Store, perms *PermissionService, moderation *ModerationService, limiter *auth.RateLimiter) *AppealService {
	return &AppealService{st: st, perms: perms, moderation: moderation, limiter: limiter, locks: newAppealLocker()}
}

// SetNotifier installs the live appeal_status notifier.
func (s *AppealService) SetNotifier(n AppealStatusNotifier) { s.notifier = n }

// SetQueueBroadcaster installs the live mod_queue broadcaster.
func (s *AppealService) SetQueueBroadcaster(b AppealQueueBroadcaster) { s.queue = b }

func (s *AppealService) notify(userID int64, publicID, state string, decisionNote *string) {
	if s.notifier != nil {
		s.notifier.NotifyAppealStatus(userID, publicID, state, decisionNote)
	}
}

// notifyQueue broadcasts a mod_queue frame. round 4 review: detaches the
// caller's context (context.WithoutCancel) the same way the old
// handler-level broadcast did before F4 moved it here — the write already
// committed, so a client disconnecting right after must not cancel the
// moderator queue's own broadcast.
func (s *AppealService) notifyQueue(ctx context.Context, appealID int64, state string) {
	if s.queue != nil {
		s.queue.BroadcastAppealQueue(context.WithoutCancel(ctx), appealID, state)
	}
}

// appealPostWriteHookForTest, when non-nil, runs after a transition's
// guarded write has committed but BEFORE its notifies — while this appeal's
// lock is still held (F4's revert-proof seam, export_test.go). Test-only,
// nil in production.
var appealPostWriteHookForTest func(publicID string)

// appealBodyMaxRunes and appealNoteMaxRunes bound the two free-text fields
// (S6 storage exhaustion, the same shape reports' maxDetailRunes/
// maxNoteRunes apply). decisionNote is shown to the appellant, so it is
// held to the same audit-detail denylist as reason on moderation_actions.
const (
	appealBodyMaxRunes = 4000
	appealNoteMaxRunes = 2000
)

// appealRateLimit and AppealRateWindow are decision 8's per-user rolling
// cap: 3 submissions per 24 hours. The key is "appeal:<user id>" — a
// dedicated prefix, never shared with "report" (Server/auth/ratelimit.go's
// Key), so a reporter's quota is never consumed by an appellant or vice
// versa. AppealRateWindow is exported (item 6, round 3 review) so
// auth's own rate-limiter tests assert against the real production value
// instead of a local literal that could silently drift from it.
const (
	appealRateLimit  = 3
	AppealRateWindow = 24 * time.Hour
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

	if s.limiter != nil && !s.limiter.Allow(auth.Key("appeal", appellantID), appealRateLimit, AppealRateWindow) {
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
	appealID, err := s.st.InsertAppeal(ctx, publicID, actionID, appellantID, body)
	if err != nil {
		switch {
		case errors.Is(err, db.ErrConflict):
			// The UNIQUE(action_id) race-proof half of decision 8: a second
			// submission landed between FindAppealForAction's pre-check and
			// this insert.
			return "", ErrAlreadyAppealed
		case errors.Is(err, db.ErrNotFound):
			// N4 review: the action was erased (its target's account erasure
			// cascades) between the GetModerationAction lookup above and this
			// insert. Same refusal as an action that never existed — no
			// existence oracle either way.
			return "", errAppealActionNotFound
		default:
			return "", fmt.Errorf("%w: %w", ErrInternal, err)
		}
	}

	// round 4 review: the "open" mod_queue broadcast used to run in the API
	// handler, AFTER Submit returned — so it could arrive after a withdraw
	// or assign frame for the SAME appeal, submitted moments later. The
	// insert has already committed, and publicID now names a real row, so
	// it is safe to acquire this appeal's own lock here (never before a row
	// exists to lock) and hold it across the notify, exactly like Withdraw/
	// Assign/Decide do.
	unlock := s.locks.lock(publicID)
	defer unlock()
	if appealPostWriteHookForTest != nil {
		appealPostWriteHookForTest(publicID)
	}

	// Audit rows must survive a request canceled after the appeal committed.
	// The detail is the action kind word only, never the appeal body.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, appellantID, "appeal_submit", "moderation_action", actionID, action.Kind)

	slog.Info("appeal submitted", "appellant_id", appellantID, "action_id", actionID, "kind", action.Kind)
	s.notifyQueue(ctx, appealID, "open")
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
// state. F4 review: the write and both live notifies (appeal_status,
// mod_queue) run under this appeal's own lock, so a withdrawal racing an
// in-flight Assign or Decide can never have its notify land out of order
// relative to theirs. round 4 review: the lock is acquired AFTER resolveOwn
// confirms the appeal exists and belongs to the caller — locking on the raw
// publicID first let any authenticated member pin unbounded memory by
// calling withdraw with invented ids in a loop, never touching decision 8's
// submission quota (which only Submit enforces).
func (s *AppealService) Withdraw(ctx context.Context, appellantID int64, publicID string) error {
	a, err := s.resolveOwn(ctx, appellantID, publicID)
	if err != nil {
		return err
	}
	unlock := s.locks.lock(publicID)
	defer unlock()
	ok, err := s.st.WithdrawAppeal(ctx, a.ID, appellantID)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return fmt.Errorf("%w: appeal is already decided", ErrConflict)
	}
	if appealPostWriteHookForTest != nil {
		appealPostWriteHookForTest(publicID)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, appellantID, "appeal_withdraw", "appeal", a.ID, "")
	s.notify(a.AppellantID, a.PublicID, "withdrawn", nil)
	s.notifyQueue(ctx, a.ID, "withdrawn")
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
	return s.requireModerate(ctx, actorID)
}

// requireModerate loads actorID's role and checks the canonical predicate
// (permissions.CanModerate). Runs before any appeal lookup, so an actor
// without the bit sees Forbidden regardless of whether the appeal id
// exists. No longer returns the role itself (unparam, golangci-lint
// review, mirroring the identical fix on ReportService.requireModerate):
// Assign's force-reassign path reads the acting principal's position fresh
// inside its own write transaction (forceReassignGuarded) rather than
// trusting a role read here.
func (s *AppealService) requireModerate(ctx context.Context, actorID int64) error {
	role, err := s.perms.GetRoleForUser(ctx, actorID)
	if err != nil || role == nil {
		return fmt.Errorf("%w: failed to load role", ErrForbidden)
	}
	if err := permissions.CanModerate(permissions.Subject{RolePerms: role.Permissions}); err != nil {
		return fmt.Errorf("%w: missing MODERATE_MEMBERS permission", ErrForbidden)
	}
	return nil
}

// Queue lists appeals for the moderator view: state is "open", "assigned",
// "decided" (both terminal decision states together), or "" for the
// default open+assigned view. F5 review: an appeal whose appellant is the
// CALLER is omitted even when it would otherwise match — the same
// confidentiality rule reports' Queue applies to reporter/subject, applied
// here to the appellant: a moderator must not learn who is assigned to, or
// how the queue is filling up around, their OWN appeal through the surface
// built for reviewing OTHER people's.
func (s *AppealService) Queue(ctx context.Context, actorID int64, state string) ([]db.AppealQueueRow, error) {
	if err := s.requireModerate(ctx, actorID); err != nil {
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

// AppealDetail is GET .../appeals/{id}'s payload: the appeal, the appealed
// action, and the action's linked report id (internal — the handler
// resolves it to a public id through ReportService.PublicIDFor), when one
// exists.
type AppealDetail struct {
	Appeal db.Appeal
	Action db.ModerationAction
}

// Get returns one appeal with its appealed action. 404 for an unknown id.
// F5 review: a moderator-appellant is refused their OWN appeal here with
// 403 SELF_REVIEW — unlike a report's subject (who must never learn the
// report exists at all, hence NotFound), an appellant already knows their
// own appeal exists (it is in their own GET /api/v1/appeals/mine view), so
// there is no existence oracle to protect against, only the same
// conflict-of-interest guardAppellantSelfReview already refuses on the
// write side, applied here to the read that would otherwise show them who
// is assigned, who decided, and the acting moderator's identity.
func (s *AppealService) Get(ctx context.Context, actorID int64, publicID string) (*AppealDetail, error) {
	if err := s.requireModerate(ctx, actorID); err != nil {
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

// guardAppellantSelfReview refuses a moderator acting on their own filed
// appeal — the mirror of report.go's guardSelfReview, and a DIFFERENT rule
// from the deciding-moderator's own eligibility test (the in-transaction
// EligibleModeratorExists check DecideAppealTx/AssignAppealTx/
// AssignAppealForced all run): an appellant who happens to also hold
// MODERATE_MEMBERS must never assign or decide the very appeal they filed,
// with NO sole-moderator escape (unlike the acting-moderator's own check,
// there is no honest "forced to judge your own case" argument for the
// appellant — on a one-moderator install their appeal simply waits for a
// second moderator to exist, which is a governance gap, not a bug this
// service papers over).
func (s *AppealService) guardAppellantSelfReview(actorID int64, appeal *db.Appeal) error {
	if appeal.AppellantID != 0 && appeal.AppellantID == actorID {
		return ErrSelfReview
	}
	return nil
}

// Assign assigns appeal publicID to actorID. 409 if it is already assigned
// to someone else, unless force is set and the caller outranks the current
// assignee (the same rule ban/kick/timeout and the report queue use).
// Claim 6 review: symmetric with Decide's self-review rule — the moderator
// who took the appealed action may not assign it to themself either, where
// another eligible reviewer exists. round 4 review: this eligibility test
// now runs INSIDE both assignment transactions (plain and forced,
// AssignAppealTx/AssignAppealForced), the same way Decide's already does —
// it used to run once, non-transactionally, before either transaction
// opened, so a second eligible moderator appearing in the gap between that
// check and the write went uncaught.
func (s *AppealService) Assign(ctx context.Context, actorID int64, publicID string, force bool) error {
	if err := s.requireModerate(ctx, actorID); err != nil {
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
		if err := s.assignAppealForced(ctx, appeal.ID, actorID, observed, needsSelfReviewCheck, appeal.AppellantID); err != nil {
			return err
		}
	} else if err := s.assignAppealPlain(ctx, appeal.ID, actorID, observed, needsSelfReviewCheck, appeal.AppellantID); err != nil {
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

// assignAppealForced is Assign's force-reassign branch: actorID must
// outrank the observed assignee's fresh position, read inside the write's
// own transaction (see forceReassignGuarded). checkSelfReview (round 4
// review) runs decision 8's deciding-moderator eligibility test inside
// that SAME transaction — it used to run once, before either assignment
// branch, non-transactionally.
func (s *AppealService) assignAppealForced(ctx context.Context, appealID, actorID, observed int64, checkSelfReview bool, appellantID int64) error {
	ok, err := s.st.AssignAppealForced(ctx, appealID, actorID, observed, actorID, checkSelfReview, appellantID,
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

// assignAppealPlain is Assign's ordinary branch: no current assignee, or the
// caller re-assigning to themselves. P2 review: wrapped in its own
// transaction (AssignAppealTx) with a fresh authority re-check, the same
// property Decide's own transaction already has. checkSelfReview (round 4
// review): decision 8's deciding-moderator eligibility test also runs
// inside this same transaction.
func (s *AppealService) assignAppealPlain(ctx context.Context, appealID, actorID, observed int64, checkSelfReview bool, appellantID int64) error {
	ok, err := s.st.AssignAppealTx(ctx, appealID, actorID, observed, actorID, checkSelfReview, appellantID,
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

// validAppealOutcomes is Decide's outcome enum.
var validAppealOutcomes = map[string]bool{"upheld": true, "overturned": true}

// ErrReversalFailed is a 409: overturning an appeal committed to a
// reversal that a genuine error prevented from applying (F1 review) — the
// whole decision was rolled back with it, so the appellant was never told
// "overturned" while the sanction it named stayed in effect.
var ErrReversalFailed = fmt.Errorf("%w: could not apply the decision's effect", ErrConflict)

// Decide records outcome ("upheld" or "overturned") against appeal
// publicID. The self-review eligibility count, the guarded write (on the
// OBSERVED state/assignee, Claim 5), and — for an overturn — the
// kind-specific reversal all run in ONE transaction (db.DecideAppealTx,
// F1/F2/F3/N1 review): a moderator banned or erased between the count and
// the write, or a reversal that genuinely fails, cannot land a decision the
// data no longer supports. Upholding changes nothing further. Both audit
// appeal_decide with the outcome word.
func (s *AppealService) Decide(ctx context.Context, actorID int64, publicID, outcome, note string) error {
	if err := s.requireModerate(ctx, actorID); err != nil {
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

	needsSelfReviewCheck := action.ActorID != 0 && action.ActorID == actorID
	result, soleModerator, reversalApplied, err := s.st.DecideAppealTx(ctx, appeal.ID, appeal.State, appeal.AssigneeID, outcome, actorID, note,
		needsSelfReviewCheck, appeal.AppellantID, permissions.ModerateMembers, permissions.Administrator,
		db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}, s.checkModeratorAuthority)
	if err != nil {
		slog.Error("appeal decide: transaction error", "appeal_id", appeal.ID, "action_id", action.ID, "err", err)
	}
	switch result {
	case db.AppealWriteOK:
		// fall through to the audit/notify below.
	case db.AppealWriteSelfReview:
		return ErrSelfReview
	case db.AppealWriteReversalFailed:
		return ErrReversalFailed
	case db.AppealWriteForbidden:
		// P2 review: the decider's own bit was revoked, or a ban landed,
		// between requireModerate above and this write's own fresh read.
		return fmt.Errorf("%w: missing MODERATE_MEMBERS permission", ErrForbidden)
	default: // db.AppealWriteConflict, including the plain Go error case above.
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

// applyOverturnReversalEffects runs Decide's two post-commit, best-effort
// consequences of an overturn (D8 policy — both survive a request canceled
// after the decision committed, via context.WithoutCancel), split out of
// Decide itself to keep it under the cyclop budget:
//
//   - item 4's reversal audit row, actor 0 (a mechanical consequence of the
//     decision, not a second moderation action by a human — the same
//     convention LiftTimeoutByActionID's lifted_by=0 already uses), detail
//     naming the appeal that caused it. Written only when reversalApplied
//     (N1: a superseded/already-lifted action reverses to a no-op, which is
//     not itself an event worth auditing). "timeout" is excluded here — its
//     audit row (also "user_untimeout") is FinalizeTimeoutLift's own below,
//     so this generic write never runs twice for the same event.
//   - B5-10 round 4/5's voice reconcile, now that B5-9's own post-commit
//     method (ModerationService.FinalizeTimeoutLift) exists. Called
//     unconditionally for every overturned timeout — not gated on
//     reversalApplied — because FinalizeTimeoutLift's own doc comment
//     anticipates exactly this caller and does its own staleness check
//     (HasActiveTimeout): a newer timeout that has since superseded this one
//     still gets its voice half repaired (clearing only what THIS action id
//     owns, a no-op if it owns nothing) but is not announced or audited
//     again, since the newer timeout's own issue already published the
//     target's current state. actorID 0: the reversal is a system
//     consequence, not a second moderation action by the human decider, who
//     is already on the appeal_decide row Decide wrote.
func (s *AppealService) applyOverturnReversalEffects(ctx context.Context, appeal *db.Appeal, action *db.ModerationAction, outcome string, reversalApplied bool) {
	if reversalApplied {
		if auditAction, ok := db.ReversalAuditActionFor(action.Kind); ok && action.Kind != "timeout" {
			db.WriteAudit(context.WithoutCancel(ctx), s.st, 0, auditAction, "user", action.TargetID, "overturned appeal "+appeal.PublicID)
		}
	}
	if outcome == "overturned" && action.Kind == "timeout" {
		s.moderation.FinalizeTimeoutLift(ctx, action.TargetID, []int64{action.ID}, 0)
	}
}

// checkModeratorAuthority is DecideAppealTx's and AssignAppealTx's fresh
// (P2 review): rolePerms/banned/banExpires are read live, inside the SAME
// transaction as the guarded write, and passed here rather than trusted
// from requireModerate's earlier (now possibly stale) check. permissions.
// CanModerate is the canonical predicate; auth.IsEffectivelyBanned is reused
// via a throwaway *db.User so the ban-lapse parsing stays in exactly one
// place. A revoked bit or a ban that landed before this transaction began
// refuses (db.AppealWriteForbidden), never a decision the data no longer
// supports.
func (s *AppealService) checkModeratorAuthority(rolePerms int64, banned bool, banExpires *string) error {
	if auth.IsEffectivelyBanned(&db.User{Banned: banned, BanExpires: banExpires}) {
		return ErrForbidden
	}
	return permissions.CanModerate(permissions.Subject{RolePerms: rolePerms})
}
