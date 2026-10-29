package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/telemetry"
	"golang.org/x/sync/singleflight"
)

// cachedPerms holds a snapshot of a user's roles and channel grants. It is
// immutable once built: singleflight hands the same pointer to every waiter
// of a load, so nothing may write to it (or its maps and slices) afterwards.
type cachedPerms struct {
	rolePerms int64          // OR of the held role masks
	roles     db.MemberRoles // copy of the held roles, so GetRoleForUser needs no store read
	// grants carries the per-channel overrides and, for the channels where
	// the member holds two or more roles and one has an override, the
	// per-role breakdown (grants.Perms == rolePerms; zero for an Administrator,
	// who needs neither).
	grants      permissions.MemberGrants
	populatedAt time.Time
}

// permCacheTTL is how long cached permissions remain valid before refresh.
const permCacheTTL = 30 * time.Second

// permLoadTimeout bounds a shared cache-miss load. The load runs detached
// from any single caller's cancellation (so one cancelled request cannot fail
// the other waiters), which makes it need its own deadline.
const permLoadTimeout = 10 * time.Second

// PermissionService wraps the stateless permissions.Checker with per-user
// caching. It eliminates per-message DB round-trips for permission checks
// at scale. The cache is populated lazily on first access and invalidated
// on role or channel override changes.
type PermissionService struct {
	st      Store
	checker *permissions.Checker

	mu    syncutil.RWMutex
	cache map[int64]*cachedPerms // keyed by userID
	// gen is bumped by every Invalidate* call. getOrPopulate snapshots it before
	// its DB read and refuses to cache if it changed, so an invalidation that
	// races a populate can't be lost (F6).
	gen uint64
	// onInvalidate, when set, is told about every invalidation AFTER the cache
	// has been dropped and mu released (all=true for a full flush). It exists
	// so a harness can observe which evictions a service issued; install it
	// before the service is shared (SetInvalidationObserver).
	onInvalidate func(userID int64, all bool)
	// loads coalesces concurrent cache-miss loads per (user, generation), so a
	// burst of requests after an invalidation costs one pair of store reads.
	loads singleflight.Group

	// hits/misses are atomics, not mu-guarded ints: the hit path holds mu only
	// as an RLock, so a plain increment there would race.
	hits   atomic.Uint64
	misses atomic.Uint64

	// timeouts mirrors every active timeout as user_id -> expires_at
	// (P5-O02), so Subject answers TimedOut without a store read. The map is
	// replaced whole, never mutated; nil means not loaded (never loaded, or
	// the last reload failed), and Subject then loads it itself or fails
	// closed. Expiry is judged against the clock at read time, so an entry
	// needs no removal to stop denying.
	timeouts atomic.Pointer[map[int64]time.Time]
	// timeoutsReload serializes reloads, so the last one to finish is also
	// the last to have read the store: a reload that started before a
	// timeout write committed can never overwrite the one that started after.
	timeoutsReload syncutil.Mutex

	// parents maps a channel id to its override authority (overrideKey):
	// int64 to int64, written once per channel and never changed.
	parents sync.Map
}

// NewPermissionService creates a PermissionService backed by the given DB.
func NewPermissionService(st Store, checker *permissions.Checker) *PermissionService {
	return &PermissionService{
		st:      st,
		checker: checker,
		cache:   make(map[int64]*cachedPerms),
	}
}

// HasChannelPerm reports whether the user has the required permission bits
// on the given channel. Uses cached role/override data when available.
// Cancellation of ctx reaches the underlying store reads. Any lookup failure
// (a transient DB hiccup as much as a genuine "no role") collapses to false —
// callers that need to tell those apart use HasChannelPermChecked instead.
func (s *PermissionService) HasChannelPerm(ctx context.Context, userID, channelID, perm int64) bool {
	// Phase B Step 8 — span the perm check so traces show how many permission
	// lookups a single REST/WS request triggers. The cache hit path is fast,
	// but knowing how often it misses is the whole point of having metrics.
	ctx, span := telemetry.GlobalTracer("service/permission").Start(ctx,
		"PermissionService.HasChannelPerm",
		telemetry.Int64("user_id", userID),
		telemetry.Int64("channel_id", channelID),
	)
	defer span.End()
	cp, err := s.getOrPopulate(ctx, userID)
	if err != nil || cp == nil {
		return false
	}
	key, err := s.overrideKey(ctx, channelID)
	if err != nil {
		return false
	}
	return s.checker.HasChannelPermBatch(cp.grants, key, perm)
}

// HasChannelPermChecked is HasChannelPerm's error-preserving counterpart: it
// distinguishes "the store lookup failed" (err != nil, verdict meaningless)
// from "the store answered and the user lacks the bit" (false, nil error).
// A caller like ws's applySetChannelID post-Subscribe revalidation
// must not treat a transient DB hiccup on the role/override read as a
// positive denial — that already-fail-closed collapse belongs to
// HasChannelPerm and the rest of this service's callers, not to a caller that
// documents "a transient lookup error is NOT a denial".
func (s *PermissionService) HasChannelPermChecked(ctx context.Context, userID, channelID, perm int64) (bool, error) {
	cp, err := s.getOrPopulate(ctx, userID)
	if err != nil {
		return false, err
	}
	if cp == nil {
		// No role row: a genuine "no permissions" outcome, not a lookup
		// failure — HasChannelPerm has always treated it as a plain false.
		return false, nil
	}
	key, err := s.overrideKey(ctx, channelID)
	if err != nil {
		return false, err
	}
	return s.checker.HasChannelPermBatch(cp.grants, key, perm), nil
}

// Subject resolves the user's role bits and both override layers for
// channelID (a thread's being its parent's, overrideKey) from the per-user
// cache, as a permissions.Subject for the
// value-taking predicates (CanSendMessage and friends). Channel flags and DM
// state are the caller's to fill in. A missing role row yields the zero
// Subject (no bits — every predicate refuses it) with a nil error; a store
// failure is returned so callers choose between failing closed and
// reporting it.
func (s *PermissionService) Subject(ctx context.Context, userID, channelID int64) (permissions.Subject, error) {
	cp, err := s.getOrPopulate(ctx, userID)
	if err != nil {
		return permissions.Subject{}, err
	}
	if cp == nil {
		return permissions.Subject{}, nil
	}
	key, err := s.overrideKey(ctx, channelID)
	if err != nil {
		return permissions.Subject{}, err
	}
	sub := cp.grants.Subject(key)
	// TimedOut comes from the timeout mirror, never the 30s role cache:
	// a stale answer would let a just-lifted timeout keep refusing,
	// or a just-issued one keep landing. The mirror is reloaded synchronously
	// by every timeout write (ModerationService) before that write returns.
	// Administrator is exempt, mirroring permissions.Checker.Subject's own
	// short-circuit.
	if !permissions.HasAdmin(cp.rolePerms) {
		timedOut, toErr := s.timedOut(ctx, userID)
		if toErr != nil {
			return permissions.Subject{}, toErr
		}
		sub.TimedOut = timedOut
	}
	return sub, nil
}

// RefreshTimeouts reloads the active-timeout mirror from the store. Every
// write that issues or lifts a timeout calls it after its commit; boot calls
// it once up front. On failure the mirror is dropped, so Subject reloads it
// or returns the error (fail closed) rather than answer from a set that may
// be missing the timeout just written.
func (s *PermissionService) RefreshTimeouts(ctx context.Context) error {
	s.timeoutsReload.Lock()
	defer s.timeoutsReload.Unlock()
	return s.reloadTimeoutsLocked(ctx)
}

func (s *PermissionService) reloadTimeoutsLocked(ctx context.Context) error {
	rows, err := s.st.ListActiveTimeoutExpiries(ctx)
	if err != nil {
		s.timeouts.Store(nil)
		return err
	}
	m := make(map[int64]time.Time, len(rows))
	for _, r := range rows {
		// Normally one active row per user (TimeoutUser supersedes the
		// rest); keep the latest expiry if a race ever leaves two.
		if cur, ok := m[r.UserID]; !ok || r.ExpiresAt.After(cur) {
			m[r.UserID] = r.ExpiresAt
		}
	}
	s.timeouts.Store(&m)
	return nil
}

// TimeoutSnapshot returns a copy of the unexpired entries of the in-memory
// timeout mirror (user_id -> expires_at), without reloading it. The bool is
// false when the mirror is not loaded (never loaded, or dropped by a failed
// reload), so a caller can tell "nobody is timed out" from "unknown". The
// copy is the caller's to read without any lock; expired entries are
// filtered out, so a lapsed timeout is never reported as active.
func (s *PermissionService) TimeoutSnapshot() (map[int64]time.Time, bool) {
	m := s.timeouts.Load()
	if m == nil {
		return nil, false
	}
	now := time.Now()
	out := make(map[int64]time.Time, len(*m))
	for uid, until := range *m {
		if now.Before(until) {
			out[uid] = until
		}
	}
	return out, true
}

// ActiveTimeouts reloads the timeout mirror from the store and returns its
// unexpired entries. It fails closed: a store error is returned (and the
// mirror is left dropped, as RefreshTimeouts does) rather than answered
// from a set that may be missing a timeout. For a fresh connect's ready,
// which must not ship a list older than the last timeout write.
func (s *PermissionService) ActiveTimeouts(ctx context.Context) (map[int64]time.Time, error) {
	if err := s.RefreshTimeouts(ctx); err != nil {
		return nil, fmt.Errorf("active timeouts: %w", err)
	}
	m, ok := s.TimeoutSnapshot()
	if !ok {
		return nil, fmt.Errorf("active timeouts: %w", errTimeoutMirrorUnloaded)
	}
	return m, nil
}

// errTimeoutMirrorUnloaded reports that the timeout mirror was dropped
// between a successful reload and its read (a concurrent failed reload).
var errTimeoutMirrorUnloaded = errors.New("timeout mirror not loaded")

// timedOut reports whether userID has an unexpired timeout, loading the
// mirror first if it is not loaded.
func (s *PermissionService) timedOut(ctx context.Context, userID int64) (bool, error) {
	m := s.timeouts.Load()
	if m == nil {
		// The wait honours ctx: the holder may be reloading on a longer-lived
		// context than this caller's deadline.
		if err := syncutil.LockContext(ctx, &s.timeoutsReload); err != nil {
			return false, fmt.Errorf("load timeouts: %w", err)
		}
		// Another caller may have loaded it while this one waited.
		if m = s.timeouts.Load(); m == nil {
			if err := s.reloadTimeoutsLocked(ctx); err != nil {
				s.timeoutsReload.Unlock()
				return false, err
			}
			m = s.timeouts.Load()
		}
		s.timeoutsReload.Unlock()
	}
	until, ok := (*m)[userID]
	return ok && time.Now().Before(until), nil
}

// GetRoleForUser returns every role the user holds, using the cache when
// available. The result is deliberate to pick from: Perms is the OR of the
// held masks (server-level checks), Top.Position / Top.ID the rank (outranks,
// IsOwner), IDs the held roles. (nil, nil) when the user holds no role.
func (s *PermissionService) GetRoleForUser(ctx context.Context, userID int64) (*db.MemberRoles, error) {
	cp, err := s.getOrPopulate(ctx, userID)
	if err != nil || cp == nil {
		// Cache miss (or a lookup failure the cache couldn't populate through),
		// fall back to direct DB query.
		return s.st.GetMemberRoles(ctx, userID)
	}
	// Served from the snapshot: every role edit invalidates the cache. Hand
	// back a copy so a caller cannot alias (or mutate) the cached rows.
	return cloneMemberRoles(&cp.roles), nil
}

// cloneMemberRoles deep-copies a held-role set, including the top role's Color
// string and the id slice.
func cloneMemberRoles(m *db.MemberRoles) *db.MemberRoles {
	out := *m
	out.Top = *cloneRole(&m.Top)
	out.IDs = slices.Clone(m.IDs)
	out.Masks = slices.Clone(m.Masks)
	return &out
}

// cloneRole deep-copies a role row, including its Color string.
func cloneRole(r *db.Role) *db.Role {
	out := *r
	if r.Color != nil {
		c := *r.Color
		out.Color = &c
	}
	return &out
}

// InvalidateUser removes cached permissions for a specific user.
// Call this when a user's role changes.
func (s *PermissionService) InvalidateUser(userID int64) {
	s.mu.Lock()
	delete(s.cache, userID)
	s.gen++
	s.mu.Unlock()
	s.notifyInvalidated(userID, false)
}

// InvalidateChannel removes cached permissions for ALL users, since a
// channel override change can affect any user with that role.
// Call this when channel_overrides are modified.
func (s *PermissionService) InvalidateChannel(_ int64) {
	s.mu.Lock()
	s.cache = make(map[int64]*cachedPerms)
	s.gen++
	s.mu.Unlock()
	s.notifyInvalidated(0, true)
}

// InvalidateAll clears the entire permission cache.
func (s *PermissionService) InvalidateAll() {
	s.mu.Lock()
	s.cache = make(map[int64]*cachedPerms)
	s.gen++
	s.mu.Unlock()
	s.notifyInvalidated(0, true)
}

// SetInvalidationObserver installs fn to be told of every invalidation after
// the cache has been dropped. Call it before the service is shared; it is not
// safe against concurrent Invalidate* calls. nil removes the observer.
func (s *PermissionService) SetInvalidationObserver(fn func(userID int64, all bool)) {
	s.onInvalidate = fn
}

func (s *PermissionService) notifyInvalidated(userID int64, all bool) {
	if s.onInvalidate != nil {
		s.onInvalidate(userID, all)
	}
}

// Checker returns the underlying stateless permissions.Checker for cases
// where callers need direct access (e.g., batch channel filtering).
func (s *PermissionService) Checker() *permissions.Checker {
	return s.checker
}

// CacheStats returns the lifetime hit/miss counters of the permission cache.
// A miss is any lookup that had to repopulate from the store — including
// TTL-expired entries and post-invalidation lookups — so a burst of misses
// right after a role or override change is the cache-wide invalidation cost
// showing up, not a bug. Safe to call from any goroutine.
func (s *PermissionService) CacheStats() (hits, misses uint64) {
	return s.hits.Load(), s.misses.Load()
}

// getOrPopulate returns cached perms for the user, populating the cache on
// miss or staleness. Returns (nil, nil) if the user genuinely has no role row
// (not a lookup failure — there is nothing to cache and nothing to retry).
// Returns (nil, err) if a store read failed, so callers that must not
// collapse a transient DB hiccup into a denial (HasChannelPermChecked) can
// tell it apart from that legitimate "no role" case; HasChannelPerm and
// GetRoleForUser keep their existing fail-closed behavior by treating either
// case the same way.
func (s *PermissionService) getOrPopulate(ctx context.Context, userID int64) (*cachedPerms, error) {
	s.mu.RLock()
	cp, ok := s.cache[userID]
	if ok && time.Since(cp.populatedAt) < permCacheTTL {
		s.mu.RUnlock()
		s.hits.Add(1)
		return cp, nil
	}
	startGen := s.gen
	s.mu.RUnlock()
	s.misses.Add(1)

	// The key carries the generation snapshot, so a load that began before an
	// invalidation is never shared with a caller that arrived after it.
	key := strconv.FormatInt(userID, 10) + ":" + strconv.FormatUint(startGen, 10)
	ch := s.loads.DoChan(key, func() (v any, err error) {
		// singleflight re-panics a load panic on a fresh goroutine nothing can
		// recover, so turn it into a load error for every waiter instead.
		defer func() {
			if r := recover(); r != nil {
				v, err = nil, fmt.Errorf("permission load panicked: %v", r)
			}
		}()
		return s.loadPerms(ctx, userID, startGen)
	})
	select {
	case res := <-ch:
		cp, _ := res.Val.(*cachedPerms)
		return cp, res.Err
	case <-ctx.Done():
		return nil, fmt.Errorf("permission load: %w", ctx.Err())
	}
}

// loadPerms reads the user's role and overrides from the store and caches the
// snapshot (unless an invalidation raced it). It is shared by every caller
// waiting on the same key, so it runs on a context detached from the first
// caller's cancellation and bounded by permLoadTimeout instead.
func (s *PermissionService) loadPerms(parent context.Context, userID int64, startGen uint64) (*cachedPerms, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), permLoadTimeout)
	defer cancel()

	// The roles and the grants are separate store reads. Admins bypass every
	// channel check, so they skip the grants fetch entirely (mirrors
	// ChannelService.ListVisibleChannels and ws.buildReady). Otherwise the
	// grants carry the role ids and mask they were composed from, and a role
	// change landing between the two reads is detected by comparing ids and
	// re-reading, so the cached mask and layers always come from one read.
	var roles *db.MemberRoles
	var grants permissions.MemberGrants
	for attempt := 0; ; attempt++ {
		var err error
		roles, err = s.st.GetMemberRoles(ctx, userID)
		if err != nil {
			return nil, err
		}
		if roles == nil {
			return nil, nil
		}
		grants = permissions.MemberGrants{Perms: roles.Perms, RoleIDs: roles.IDs}
		if permissions.HasAdmin(roles.Perms) {
			break
		}
		g, oErr := s.st.GetMemberGrants(ctx, userID)
		if oErr != nil {
			// Fail closed (for HasChannelPerm/GetRoleForUser): an empty map
			// would silently drop every deny bit, and caching it would keep
			// doing so for permCacheTTL. HasChannelPermChecked callers get the
			// error itself and decide for themselves whether that's a denial.
			slog.Error("PermissionService.getOrPopulate override fetch failed, denying", "err", oErr, "user_id", userID, "role_ids", roles.IDs)
			return nil, oErr
		}
		if slices.Equal(g.RoleIDs, roles.IDs) {
			grants = g
			break
		}
		if attempt >= 2 {
			return nil, fmt.Errorf("loadPerms: held roles kept changing for user %d", userID)
		}
	}

	cp := &cachedPerms{
		rolePerms:   roles.Perms,
		roles:       *cloneMemberRoles(roles),
		grants:      grants,
		populatedAt: time.Now(),
	}

	s.mu.Lock()
	// F6: only cache if no invalidation raced our DB read. If gen moved, an
	// InvalidateUser/InvalidateChannel/InvalidateAll landed after we snapshotted
	// it, so this snapshot may already be stale — return it for this one request
	// but don't poison the cache with it for permCacheTTL.
	if s.gen == startGen {
		s.cache[userID] = cp
	}
	s.mu.Unlock()
	return cp, nil
}
