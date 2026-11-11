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

type appealStore interface {
	db.Auditor
	GetModerationAction(ctx context.Context, id int64) (*db.ModerationAction, error)
	// FindAppealForAction is the dedupe fast path; InsertAppeal's UNIQUE(action_id) enforces
	// one appeal per action under concurrency.
	FindAppealForAction(ctx context.Context, actionID int64) (int64, error)
	InsertAppeal(ctx context.Context, publicID string, actionID, appellantID int64, body string) (int64, error)
	GetAppealByPublicID(ctx context.Context, publicID string) (*db.Appeal, error)
	ListAppealsMine(ctx context.Context, appellantID int64) ([]db.AppealSummary, error)
	ListAppealsQueue(ctx context.Context, state string) ([]db.AppealQueueRow, error)
	// AssignAppealTx is Assign's plain path in one transaction with a fresh authority
	// re-check and, when checkSelfReview, the deciding-moderator eligibility test.
	AssignAppealTx(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64, checkSelfReview bool, appellantID, permBit, adminBit int64, checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (bool, error)
	AssignAppealForced(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64, checkSelfReviewNeeded bool, appellantID, permBit, adminBit int64, checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (bool, error)
	// DecideAppealTx re-checks authority, rejects stale/terminal rows and self-review, and
	// applies the guarded UPDATE (on the OBSERVED state/assignee) plus any overturn reversal in
	// one transaction. reversalApplied says whether to audit the reversal after commit.
	DecideAppealTx(ctx context.Context, appealID int64, observedState string, observedAssigneeID int64, outcome string, decidedBy int64, note string, checkSelfReview bool, appellantID, permBit, adminBit int64, action db.AppealedAction, checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (result db.AppealWriteOutcome, soleModeratorUsed, reversalApplied bool, err error)
	WithdrawAppeal(ctx context.Context, id, appellantID int64) (bool, error)
}

// AppealService is the rate-limited appeal against a moderation action. Methods take the
// opaque public appeal id; the internal id never reaches a response, route or frame.
type AppealService struct {
	st    appealStore
	perms *PermissionService
	// moderation serves requireOverturnAuthority and FinalizeTimeoutLift; overturn effects run inside
	// DecideAppealTx's transaction, never through a second ModerationService call.
	moderation *ModerationService
	limiter    *auth.RateLimiter
	notifier   AppealStatusNotifier
	queue      AppealQueueBroadcaster
	// unban broadcasts the member_join a lifted ban needs (member_ban hard-deletes the row on
	// every client). Optional.
	unban AppealUnbanBroadcaster
	locks *appealLocker
}

// appealLocker serializes transitions per appeal: the guarded write and its live notifies
// must act as one unit, or a delayed transition notifies after a later one. Entries are
// reference-counted and evicted once unused. Callers lock only after the appeal exists
// and the caller is authorized (Submit: after its insert), so an invented public id never
// allocates an entry.
type appealLocker struct {
	mu    syncutil.Mutex
	locks map[string]*appealLockEntry
}

// appealLockEntry is one appeal's lock plus its holder/waiter count. refs is guarded by
// appealLocker.mu so eviction can never delete an entry someone is about to wait on.
type appealLockEntry struct {
	mu   syncutil.Mutex
	refs int
}

func newAppealLocker() *appealLocker {
	return &appealLocker{locks: make(map[string]*appealLockEntry)}
}

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

// AppealStatusNotifier delivers a live appeal_status frame to the appellant (*ws.Hub).
type AppealStatusNotifier interface {
	NotifyAppealStatus(userID int64, publicID, state string, decisionNote *string)
}

// AppealQueueBroadcaster delivers a live mod_queue frame (*ws.Hub) from inside the service
// under the per-appeal lock, so it cannot race the appeal_status notify out of commit order.
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

// notifyQueue broadcasts mod_queue on a detached ctx: the write committed, so a disconnect must not cancel.
func (s *AppealService) notifyQueue(ctx context.Context, appealID int64, state string) {
	if s.queue != nil {
		s.queue.BroadcastAppealQueue(context.WithoutCancel(ctx), appealID, state)
	}
}

// appealPostWriteHookForTest runs after a transition's write commits, before its notifies,
// with the appeal's lock held. Test-only; nil in production.
var appealPostWriteHookForTest func(publicID string)

// appealBodyMaxRunes and appealNoteMaxRunes bound free text against storage exhaustion.
// decisionNote is shown to the appellant, so it meets the audit-detail denylist.
const (
	appealBodyMaxRunes = 4000
	appealNoteMaxRunes = 2000
)

// appealRateLimit/AppealRateWindow: 3 submissions per 24 hours under "appeal:<user id>",
// never shared with "report" so the quotas cannot consume each other. Exported for auth's tests.
const (
	appealRateLimit  = 3
	AppealRateWindow = 24 * time.Hour
)

// appealableKinds are the appealable action kinds. "kick" persists nothing. "ban" is
// reachable only by a target who can authenticate, so after the ban lapsed or was reversed.
var appealableKinds = map[string]bool{"warning": true, "timeout": true, "removal": true, "ban": true}

// ErrAlreadyAppealed is a 409: an appeal for this action exists in any state, and a
// decided appeal cannot be re-appealed (UNIQUE(action_id)).
var ErrAlreadyAppealed = fmt.Errorf("%w: an appeal against this action already exists", ErrConflict)

// errAppealActionNotFound is Submit's single refusal for an unknown action and one not
// targeting the caller; distinguishable messages would be an existence oracle.
var errAppealActionNotFound = fmt.Errorf("%w: action not found", ErrNotFound)

// Submit files an appeal against actionID: the caller must be the action's target (else
// 404, no oracle), the kind appealable, then the rate limit (429), then no existing appeal
// in any state (409). Returns the appeal's public id.
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
	// A self-targeted row (a moderator's own channel purge) is not a sanction.
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
	// Lock BEFORE the insert commits so the "open" mod_queue broadcast precedes any
	// assign/withdraw frame: a moderator cannot Assign the fresh row until Submit has notified.
	unlock := s.locks.lock(publicID)
	defer unlock()
	appealID, err := s.st.InsertAppeal(ctx, publicID, actionID, appellantID, body)
	if err != nil {
		switch {
		case errors.Is(err, db.ErrConflict):
			// UNIQUE(action_id) race: a second submission landed between FindAppealForAction and this insert.
			return "", ErrAlreadyAppealed
		case errors.Is(err, db.ErrNotFound):
			// The action was erased by its target's account erasure after the lookup; same refusal
			// as unknown (no oracle).
			return "", errAppealActionNotFound
		default:
			return "", fmt.Errorf("%w: %w", ErrInternal, err)
		}
	}

	if appealPostWriteHookForTest != nil {
		appealPostWriteHookForTest(publicID)
	}

	// Audit rows must survive a request canceled after commit. Detail is the kind word only,
	// never the appeal body.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, appellantID, "appeal_submit", "moderation_action", actionID, action.Kind)

	slog.Info("appeal submitted", "appellant_id", appellantID, "action_id", actionID, "kind", action.Kind)
	s.notifyQueue(ctx, appealID, "open")
	return publicID, nil
}

// AppealMineRow is one row of the appellant's own view: the appeal plus the action's
// kind, reason and created_at; never the assignee or decider.
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

// resolveOwn resolves publicID to the caller's own appeal, or ErrNotFound for an unknown
// id and someone else's alike (no oracle).
func (s *AppealService) resolveOwn(ctx context.Context, appellantID int64, publicID string) (*db.Appeal, error) {
	a, err := s.st.GetAppealByPublicID(ctx, publicID)
	if err != nil || a.AppellantID != appellantID {
		return nil, fmt.Errorf("%w: appeal not found", ErrNotFound)
	}
	return a, nil
}

// Withdraw withdraws the caller's own open or assigned appeal under the appeal's lock,
// taken after resolveOwn: locking a raw id first would let any member pin unbounded
// memory, since only Submit enforces the quota.
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
