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

// appealStore is what AppealService reads and writes. *db.DB satisfies it.
type appealStore interface {
	db.Auditor
	// GetModerationAction backs appeal submission and decision, which need the
	// action's kind, target and actor.
	GetModerationAction(ctx context.Context, id int64) (*db.ModerationAction, error)
	// FindAppealForAction is the dedupe FAST PATH; InsertAppeal's UNIQUE(action_id)
	// violation enforces "one appeal per action, ever" under concurrency.
	FindAppealForAction(ctx context.Context, actionID int64) (int64, error)
	InsertAppeal(ctx context.Context, publicID string, actionID, appellantID int64, body string) (int64, error)
	GetAppealByPublicID(ctx context.Context, publicID string) (*db.Appeal, error)
	ListAppealsMine(ctx context.Context, appellantID int64) ([]db.AppealSummary, error)
	ListAppealsQueue(ctx context.Context, state string) ([]db.AppealQueueRow, error)
	// AssignAppealTx is Assign's plain path in its own transaction with a fresh
	// authority re-check and, when checkSelfReview is true, the deciding-moderator
	// eligibility test (see db.AssignAppealTx).
	AssignAppealTx(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64, checkSelfReview bool, appellantID, permBit, adminBit int64, checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (bool, error)
	AssignAppealForced(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64, checkSelfReviewNeeded bool, appellantID, permBit, adminBit int64, checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (bool, error)
	// DecideAppealTx runs the fresh authority re-check, stale/terminal row rejection,
	// self-review test, the guarded decide UPDATE (on the OBSERVED state/assignee)
	// and, for an overturn, the reversal in one transaction (see db.DecideAppealTx).
	// reversalApplied tells the caller whether to write the reversal's audit row,
	// best-effort, AFTER the commit.
	DecideAppealTx(ctx context.Context, appealID int64, observedState string, observedAssigneeID int64, outcome string, decidedBy int64, note string, checkSelfReview bool, appellantID, permBit, adminBit int64, action db.AppealedAction, checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (result db.AppealWriteOutcome, soleModeratorUsed, reversalApplied bool, err error)
	WithdrawAppeal(ctx context.Context, id, appellantID int64) (bool, error)
}

// AppealService is the rate-limited appeal against a moderation action: submission,
// the appellant's status view, withdrawal, and the queue's assignment and decision
// (notably the deciding-moderator self-review rule). Appeal ids on its methods are
// the opaque public id; the sequential internal id never reaches a response, route
// parameter or mod_queue frame, for the same reason reports adopted one.
type AppealService struct {
	st    appealStore
	perms *PermissionService
	// moderation serves requireOverturnAuthority (outrank check and, for a ban,
	// BAN_MEMBERS) and FinalizeTimeoutLift. The overturn effects themselves run at
	// the DB layer inside DecideAppealTx's transaction, never through a second
	// ModerationService call.
	moderation *ModerationService
	limiter    *auth.RateLimiter
	notifier   AppealStatusNotifier
	queue      AppealQueueBroadcaster
	// unban broadcasts the member_join a lifted ban needs, as the admin unban path
	// does: member_ban hard-deletes the row on every client, so flipping
	// users.banned back without a frame leaves clients missing the user until a full
	// resync. Optional, like the other two.
	unban AppealUnbanBroadcaster
	locks *appealLocker
}

// appealLocker serializes transitions per appeal: a transition's guarded write
// and its live notifies (appeal_status, mod_queue) must act as one unit, or a
// delayed transition notifies AFTER a later one (a stale Assign's "assigned"
// frame trailing a Decide's "overturned"). Submit, Assign, Decide and Withdraw
// hold the appeal's lock from just before the database through their notify.
//
// Entries are reference-counted and evicted once unused (as ws/user_locks.go
// does). Every caller locks only AFTER the appeal is confirmed to exist and the
// caller is authorized (Submit: after its insert), so an invented public id,
// reachable by any member looping withdraw without touching the quota, never
// allocates an entry.
type appealLocker struct {
	mu    syncutil.Mutex
	locks map[string]*appealLockEntry
}

// appealLockEntry is one appeal's lock plus its holder/waiter count. refs is
// guarded by appealLocker.mu, not the entry's own lock, so it changes together
// with the map lookup and eviction can never delete an entry someone is about to
// wait on.
type appealLockEntry struct {
	mu   syncutil.Mutex
	refs int
}

func newAppealLocker() *appealLocker {
	return &appealLocker{locks: make(map[string]*appealLockEntry)}
}

// lock acquires publicID's lock and returns its release: `defer s.locks.lock(id)()`.
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

// AppealStatusNotifier delivers a live appeal_status frame to the appellant.
// *ws.Hub implements it.
type AppealStatusNotifier interface {
	NotifyAppealStatus(userID int64, publicID, state string, decisionNote *string)
}

// AppealQueueBroadcaster delivers a live mod_queue frame for an appeal state
// change (*ws.Hub). It runs from INSIDE the service under the same per-appeal lock
// as the appeal_status notify, so the two cannot race out of commit order, which
// a handler calling it after the lock was released allowed.
type AppealQueueBroadcaster interface {
	BroadcastAppealQueue(ctx context.Context, appealID int64, state string)
}

// NewAppealService creates an AppealService.
func NewAppealService(st appealStore, perms *PermissionService, moderation *ModerationService, limiter *auth.RateLimiter) *AppealService {
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

// notifyQueue broadcasts a mod_queue frame on a detached context: the write
// already committed, so a client disconnecting must not cancel it.
func (s *AppealService) notifyQueue(ctx context.Context, appealID int64, state string) {
	if s.queue != nil {
		s.queue.BroadcastAppealQueue(context.WithoutCancel(ctx), appealID, state)
	}
}

// appealPostWriteHookForTest runs after a transition's guarded write commits but
// BEFORE its notifies, with the appeal's lock held (the seam in export_test.go).
// Test-only; nil in production.
var appealPostWriteHookForTest func(publicID string)

// appealBodyMaxRunes and appealNoteMaxRunes bound the free-text fields against
// storage exhaustion (as reports do). decisionNote is shown to the appellant, so
// it meets the same audit-detail denylist as moderation_actions.reason.
const (
	appealBodyMaxRunes = 4000
	appealNoteMaxRunes = 2000
)

// appealRateLimit and AppealRateWindow are the per-user cap: 3 submissions per
// 24 hours under "appeal:<user id>", a prefix never shared with "report"
// (auth.Key) so the two quotas cannot consume each other. AppealRateWindow is
// exported so auth's rate-limiter tests assert the real production value.
const (
	appealRateLimit  = 3
	AppealRateWindow = 24 * time.Hour
)

// appealableKinds are the action kinds that can be appealed. "kick" is excluded:
// a force-logout persists nothing to appeal. "ban" is included but reachable only
// by a target who can authenticate: AuthMiddleware rejects every effectively
// banned caller (api/middleware.go), so a ban appeal arrives only after the ban
// lapsed or was reversed. A still-banned target has no path in beta
// (docs/api.md: it arrives out of band).
var appealableKinds = map[string]bool{"warning": true, "timeout": true, "removal": true, "ban": true}

// ErrAlreadyAppealed is a 409: an appeal against this action already exists in
// ANY state. A decided appeal cannot be re-appealed; UNIQUE(action_id) enforces it.
var ErrAlreadyAppealed = fmt.Errorf("%w: an appeal against this action already exists", ErrConflict)

// errAppealActionNotFound is Submit's one refusal for both an unknown action and
// one not targeting the caller (as report.go's errTargetNotFound): distinguishable
// messages would be an existence oracle.
var errAppealActionNotFound = fmt.Errorf("%w: action not found", ErrNotFound)

// Submit files an appeal against actionID. Rules, in order: caller must be the
// action's target (else 404, no oracle); the kind must be appealable; the rate
// limit (429); no existing appeal in any state (409 ALREADY_APPEALED). Returns
// the appeal's public id.
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
	// A self-targeted row (a moderator's own channel purge) is not a sanction,
	// matching ListOwnModerationActions.
	if action.ActorID != 0 && action.ActorID == action.TargetID {
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
	// The "open" mod_queue broadcast must precede any assign/withdraw frame for the
	// SAME appeal, so lock BEFORE the insert commits: a moderator polling the queue
	// cannot Assign the fresh row until Submit has notified. Locking an id with no
	// row is harmless (in-memory refcounted map, evicted on unlock).
	unlock := s.locks.lock(publicID)
	defer unlock()
	appealID, err := s.st.InsertAppeal(ctx, publicID, actionID, appellantID, body)
	if err != nil {
		switch {
		case errors.Is(err, db.ErrConflict):
			// The UNIQUE(action_id) race-proof half: a second submission landed between the
			// FindAppealForAction pre-check and this insert.
			return "", ErrAlreadyAppealed
		case errors.Is(err, db.ErrNotFound):
			// The action was erased (its target's account erasure cascades) after the lookup
			// above. Same refusal as an unknown action: no existence oracle.
			return "", errAppealActionNotFound
		default:
			return "", fmt.Errorf("%w: %w", ErrInternal, err)
		}
	}

	if appealPostWriteHookForTest != nil {
		appealPostWriteHookForTest(publicID)
	}

	// Audit rows must survive a request canceled after the commit. The detail is the
	// kind word only, never the appeal body.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, appellantID, "appeal_submit", "moderation_action", actionID, action.Kind)

	slog.Info("appeal submitted", "appellant_id", appellantID, "action_id", actionID, "kind", action.Kind)
	s.notifyQueue(ctx, appealID, "open")
	return publicID, nil
}

// AppealMineRow is one row of the appellant's own view (GET /api/v1/appeals/mine):
// the appeal plus the action's kind, reason and created_at; never the assignee or
// who decided it.
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

// Mine returns the caller's own appeals with each row's action details for display.
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

// resolveOwn resolves publicID to the caller's own appeal, or ErrNotFound for
// both an unknown id and someone else's (no oracle, as in Submit).
func (s *AppealService) resolveOwn(ctx context.Context, appellantID int64, publicID string) (*db.Appeal, error) {
	a, err := s.st.GetAppealByPublicID(ctx, publicID)
	if err != nil || a.AppellantID != appellantID {
		return nil, fmt.Errorf("%w: appeal not found", ErrNotFound)
	}
	return a, nil
}

// Withdraw withdraws the caller's own appeal (appellant only, open or assigned
// states only). The write and both live notifies run under the appeal's lock so
// a racing Assign or Decide cannot notify out of order. The lock is taken AFTER
// resolveOwn: locking the raw publicID first let any member pin unbounded memory
// with invented ids, since only Submit enforces the quota.
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

// applyOverturnReversalEffects runs Decide's post-commit, best-effort overturn
// consequences on a detached context (the decision already committed):
//
//   - the reversal audit row, actor 0 (a mechanical consequence, not a second
//     human action; the convention of LiftTimeoutByActionID's lifted_by=0),
//     naming the appeal. Written only when reversalApplied, since a
//     superseded/already-lifted action reverses to a no-op not worth auditing.
//     "timeout" is excluded: FinalizeTimeoutLift writes its own user_untimeout
//     row, so this generic write never runs twice for one event.
//   - the overturned timeout's voice reconcile via FinalizeTimeoutLift, called
//     unconditionally (not gated on reversalApplied) because that method does its
//     own staleness check: a newer timeout still gets its voice half repaired
//     (only what THIS action id owns) but is not announced or audited again.
//     actorID 0 since the human decider is already on the appeal_decide row.
func (s *AppealService) applyOverturnReversalEffects(ctx context.Context, appeal *db.Appeal, action *db.ModerationAction, outcome string, reversalApplied bool) {
	if reversalApplied {
		if auditAction, ok := db.ReversalAuditActionFor(action.Kind); ok && action.Kind != "timeout" {
			db.WriteAudit(context.WithoutCancel(ctx), s.st, 0, auditAction, "user", action.TargetID, "overturned appeal "+appeal.PublicID)
		}
		if action.Kind == "ban" {
			// The reversal actually lifted a live ban (reversalApplied is true only when
			// the guarded UPDATE changed a row). Clients hard-deleted the row on the ban's
			// member_ban, so re-add it as the admin unban path does, or they keep the user
			// missing until a full ready.
			s.broadcastUnban(action.TargetID)
		}
	}
	if outcome == "overturned" && action.Kind == "timeout" {
		s.moderation.FinalizeTimeoutLift(ctx, action.TargetID, []int64{action.ID}, 0)
	}
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
