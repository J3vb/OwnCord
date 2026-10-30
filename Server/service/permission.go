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

// cachedPerms is a user's role and channel-grant snapshot, immutable once built:
// singleflight hands the same pointer to every waiter, so nothing may write to it
// or its maps and slices.
type cachedPerms struct {
	rolePerms int64          // OR of the held role masks
	roles     db.MemberRoles // copy of the held roles, so GetRoleForUser needs no store read
	// grants carries the per-channel overrides and, where the member holds two or
	// more roles and one has an override, the per-role breakdown
	// (grants.Perms == rolePerms; zero for an Administrator, who needs neither).
	grants      permissions.MemberGrants
	populatedAt time.Time
}

const permCacheTTL = 30 * time.Second

// permLoadTimeout bounds a shared cache-miss load, which runs detached from any
// one caller's cancellation (so one canceled request cannot fail the waiters).
const permLoadTimeout = 10 * time.Second

// PermissionService wraps the stateless permissions.Checker with per-user
// caching, populated lazily and invalidated on role or channel override changes.
type PermissionService struct {
	st      Store
	checker *permissions.Checker

	mu    syncutil.RWMutex
	cache map[int64]*cachedPerms // keyed by userID
	// gen is bumped by every Invalidate*. getOrPopulate snapshots it before its DB
	// read and refuses to cache if it changed, so a racing invalidation is not lost.
	gen uint64
	// onInvalidate is told of every invalidation AFTER the cache was dropped and mu
	// released (all=true for a full flush), so a harness can observe evictions;
	// install it before the service is shared (SetInvalidationObserver).
	onInvalidate func(userID int64, all bool)
	// loads coalesces concurrent cache-miss loads per (user, generation): a burst
	// after an invalidation costs one pair of store reads.
	loads singleflight.Group

	// hits/misses are atomics: the hit path holds only an RLock.
	hits   atomic.Uint64
	misses atomic.Uint64

	// timeouts mirrors every active timeout as user_id -> expires_at, so Subject
	// answers TimedOut without a store read. The map is replaced whole, never
	// mutated; nil means not loaded (never, or the last reload failed) and Subject
	// then loads it or fails closed. Expiry is judged at read time, so an entry needs
	// no removal to stop denying.
	timeouts atomic.Pointer[map[int64]time.Time]
	// timeoutsReload serializes reloads so the last to finish is the last to have
	// read the store: one started before a timeout write committed can never
	// overwrite one started after.
	timeoutsReload syncutil.Mutex

	// parents maps a channel id to its override authority (overrideKey), written once
	// per channel and never changed.
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

// HasChannelPerm reports whether the user has the permission bits on the channel,
// from cached role/override data. Any lookup failure (a transient DB error as
// much as "no role") collapses to false; callers that must tell those apart use
// HasChannelPermChecked.
func (s *PermissionService) HasChannelPerm(ctx context.Context, userID, channelID, perm int64) bool {
	// Span the check so traces show how often the cache misses.
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
// separates "the lookup failed" (err != nil, verdict meaningless) from "the user
// lacks the bit" (false, nil). ws's applySetChannelID post-Subscribe revalidation
// needs that: a transient DB error is not a denial.
func (s *PermissionService) HasChannelPermChecked(ctx context.Context, userID, channelID, perm int64) (bool, error) {
	cp, err := s.getOrPopulate(ctx, userID)
	if err != nil {
		return false, err
	}
	if cp == nil {
		// No role row: a genuine "no permissions", not a lookup failure.
		return false, nil
	}
	key, err := s.overrideKey(ctx, channelID)
	if err != nil {
		return false, err
	}
	return s.checker.HasChannelPermBatch(cp.grants, key, perm), nil
}

// Subject resolves the user's role bits and both override layers for channelID (a
// thread's being its parent's, overrideKey) from the per-user cache, for the
// value-taking predicates (CanSendMessage and friends). Channel flags and DM
// state are the caller's. A missing role row yields the zero Subject (every
// predicate refuses it) with nil error; a store failure is returned so callers
// choose between failing closed and reporting it.
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
	// TimedOut comes from the timeout mirror, never the 30s role cache: a stale
	// answer would keep a lifted timeout refusing or let a new one land. Every
	// timeout write reloads the mirror synchronously before returning.
	// Administrator is exempt, as in permissions.Checker.Subject.
	if !permissions.HasAdmin(cp.rolePerms) {
		timedOut, toErr := s.timedOut(ctx, userID)
		if toErr != nil {
			return permissions.Subject{}, toErr
		}
		sub.TimedOut = timedOut
	}
	return sub, nil
}

// RefreshTimeouts reloads the active-timeout mirror. Every timeout issue or lift
// calls it after its commit; boot calls it once. On failure the mirror is dropped,
// so Subject reloads it or fails closed rather than answer from a set that may
// miss the timeout just written.
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
		// Normally one active row per user (TimeoutUser supersedes the rest); keep the
		// latest expiry if a race leaves two.
		if cur, ok := m[r.UserID]; !ok || r.ExpiresAt.After(cur) {
			m[r.UserID] = r.ExpiresAt
		}
	}
	s.timeouts.Store(&m)
	return nil
}

// TimeoutSnapshot returns a copy of the unexpired mirror entries (user_id ->
// expires_at) without reloading. The bool is false when the mirror is not loaded,
// so a caller can tell "nobody is timed out" from "unknown". Expired entries are
// filtered out.
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

// ActiveTimeouts reloads the mirror and returns its unexpired entries. It fails
// closed: a store error is returned (mirror left dropped) rather than answered
// from a possibly stale set. For a fresh connect's ready, which must not ship a
// list older than the last timeout write.
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

// errTimeoutMirrorUnloaded: the mirror was dropped between a successful reload
// and its read (a concurrent failed reload).
var errTimeoutMirrorUnloaded = errors.New("timeout mirror not loaded")

// timedOut reports whether userID has an unexpired timeout, loading the mirror
// first if needed.
func (s *PermissionService) timedOut(ctx context.Context, userID int64) (bool, error) {
	m := s.timeouts.Load()
	if m == nil {
		// The wait honours ctx: the holder may be reloading on a longer-lived context.
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

// GetRoleForUser returns every role the user holds, from the cache when
// available: Perms is the OR of the held masks, Top.Position / Top.ID the rank,
// IDs the held roles. (nil, nil) when the user holds no role.
func (s *PermissionService) GetRoleForUser(ctx context.Context, userID int64) (*db.MemberRoles, error) {
	cp, err := s.getOrPopulate(ctx, userID)
	if err != nil || cp == nil {
		// Cache miss or a failed populate: fall back to a direct query.
		return s.st.GetMemberRoles(ctx, userID)
	}
	// Every role edit invalidates the cache. Return a copy so a caller cannot alias
	// or mutate the cached rows.
	return cloneMemberRoles(&cp.roles), nil
}

// cloneMemberRoles deep-copies a held-role set, including the top role's Color
// and the id slice.
func cloneMemberRoles(m *db.MemberRoles) *db.MemberRoles {
	out := *m
	out.Top = *cloneRole(&m.Top)
	out.IDs = slices.Clone(m.IDs)
	out.Masks = slices.Clone(m.Masks)
	return &out
}

func cloneRole(r *db.Role) *db.Role {
	out := *r
	if r.Color != nil {
		c := *r.Color
		out.Color = &c
	}
	return &out
}

// InvalidateUser removes cached permissions for a user; call it when their role
// changes.
func (s *PermissionService) InvalidateUser(userID int64) {
	s.mu.Lock()
	delete(s.cache, userID)
	s.gen++
	s.mu.Unlock()
	s.notifyInvalidated(userID, false)
}

// InvalidateChannel drops the cache for ALL users, since an override change can
// affect any user with that role; call it when channel_overrides change.
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

// SetInvalidationObserver installs fn to be told of every invalidation after the
// cache was dropped. Call it before the service is shared (not safe against
// concurrent Invalidate*); nil removes it.
func (s *PermissionService) SetInvalidationObserver(fn func(userID int64, all bool)) {
	s.onInvalidate = fn
}

func (s *PermissionService) notifyInvalidated(userID int64, all bool) {
	if s.onInvalidate != nil {
		s.onInvalidate(userID, all)
	}
}

// Checker returns the underlying stateless permissions.Checker (e.g. for batch
// channel filtering).
func (s *PermissionService) Checker() *permissions.Checker {
	return s.checker
}

// CacheStats returns the lifetime hit/miss counters. A miss is any lookup that
// repopulated from the store, TTL expiry and post-invalidation included, so a
// burst of misses after a role or override change is the invalidation cost, not
// a bug.
func (s *PermissionService) CacheStats() (hits, misses uint64) {
	return s.hits.Load(), s.misses.Load()
}

// getOrPopulate returns cached perms, populating on miss or staleness. (nil, nil)
// means the user has no role row (nothing to cache or retry); (nil, err) means a
// store read failed, so callers that must not collapse a transient error into a
// denial (HasChannelPermChecked) can tell them apart.
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

	// The key carries the generation snapshot, so a load begun before an
	// invalidation is never shared with a caller that arrived after it.
	key := strconv.FormatInt(userID, 10) + ":" + strconv.FormatUint(startGen, 10)
	ch := s.loads.DoChan(key, func() (v any, err error) {
		// singleflight re-panics a load panic on a goroutine nothing can recover, so
		// turn it into a load error for every waiter.
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

// loadPerms reads the user's role and overrides and caches the snapshot (unless
// an invalidation raced it). It is shared by every waiter on the key, so it runs
// detached from the first caller's cancellation and bounded by permLoadTimeout.
func (s *PermissionService) loadPerms(parent context.Context, userID int64, startGen uint64) (*cachedPerms, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), permLoadTimeout)
	defer cancel()

	// The roles and grants are separate store reads. Admins bypass every channel
	// check, so they skip the grants fetch (as ChannelService.ListVisibleChannels and
	// ws.buildReady do). Otherwise the grants carry the role ids and mask they were
	// composed from, and a role change between the reads is detected by comparing ids
	// and re-reading, so the cached mask and layers come from one read.
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
			// Fail closed: an empty map would silently drop every deny bit, and caching it
			// would keep doing so for permCacheTTL. HasChannelPermChecked callers get the
			// error and decide for themselves.
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
	// Cache only if no invalidation raced the DB read: if gen moved, the snapshot may
	// be stale, so return it for this request but do not poison the cache for
	// permCacheTTL.
	if s.gen == startGen {
		s.cache[userID] = cp
	}
	s.mu.Unlock()
	return cp, nil
}
