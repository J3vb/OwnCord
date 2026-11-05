package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
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
