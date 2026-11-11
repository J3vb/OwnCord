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

// cachedPerms is a user's role and channel-grant snapshot, immutable once built (singleflight shares one
// pointer), so nothing may write to it or its maps.
type cachedPerms struct {
	rolePerms int64          // OR of the held role masks
	roles     db.MemberRoles // copy of the held roles, so GetRoleForUser needs no store read
	// grants carries the per-channel overrides and per-role breakdown (zero for an Administrator).
	grants      permissions.MemberGrants
	populatedAt time.Time
}

const permCacheTTL = 30 * time.Second

// permLoadTimeout bounds a shared cache-miss load, which runs detached so one canceled request cannot fail
// the waiters.
const permLoadTimeout = 10 * time.Second

type permissionStore interface {
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetMemberGrants(ctx context.Context, userID int64) (permissions.MemberGrants, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
	ListActiveTimeoutExpiries(ctx context.Context) ([]db.ActiveTimeoutExpiry, error)
}

// PermissionService wraps the stateless permissions.Checker with per-user caching, invalidated on role or
// channel override changes.
type PermissionService struct {
	st      permissionStore
	checker *permissions.Checker

	mu    syncutil.RWMutex
	cache map[int64]*cachedPerms // keyed by userID
	// gen is bumped by every Invalidate*; getOrPopulate refuses to cache if it moved during its DB read.
	gen uint64
	// onInvalidate is told of every invalidation AFTER the cache was dropped and mu released; install before the
	// service is shared.
	onInvalidate func(userID int64, all bool)
	// loads coalesces concurrent cache-miss loads per (user, generation).
	loads singleflight.Group

	// hits/misses are atomics: the hit path holds only an RLock.
	hits   atomic.Uint64
	misses atomic.Uint64

	// timeouts mirrors every active timeout as user_id -> expires_at so Subject answers TimedOut without a store
	// read. Replaced whole, never mutated; nil means not loaded (Subject loads it or fails closed). Expiry is
	// judged at read time.
	timeouts atomic.Pointer[map[int64]time.Time]
	// timeoutsReload serializes reloads so an older reload can never overwrite a newer one.
	timeoutsReload syncutil.Mutex

	// parents maps a channel id to its overrideKey; written once per channel, never changed.
	parents sync.Map
}

// NewPermissionService creates a PermissionService backed by the given DB.
func NewPermissionService(st permissionStore, checker *permissions.Checker) *PermissionService {
	return &PermissionService{
		st:      st,
		checker: checker,
		cache:   make(map[int64]*cachedPerms),
	}
}

// HasChannelPerm reports whether the user has the permission bits on the channel. Any lookup failure
// collapses to false; use HasChannelPermChecked to tell them apart.
func (s *PermissionService) HasChannelPerm(ctx context.Context, userID, channelID, perm int64) bool {
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

// HasChannelPermChecked separates "the lookup failed" (err != nil, verdict meaningless) from "the user lacks
// the bit" (false, nil): ws's post-Subscribe revalidation needs that, since a transient DB error is not a
// denial.
func (s *PermissionService) HasChannelPermChecked(ctx context.Context, userID, channelID, perm int64) (bool, error) {
	cp, err := s.getOrPopulate(ctx, userID)
	if err != nil {
		return false, err
	}
	if cp == nil {
		return false, nil
	}
	key, err := s.overrideKey(ctx, channelID)
	if err != nil {
		return false, err
	}
	return s.checker.HasChannelPermBatch(cp.grants, key, perm), nil
}

// Subject resolves the user's role bits and both override layers for channelID (a thread's being its
// parent's) from the per-user cache. A missing role row yields the zero Subject (every predicate refuses it)
// with nil error; a store failure is returned so callers choose between failing closed and reporting it.
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
	// TimedOut comes from the timeout mirror, never the 30s role cache: a stale answer would keep a lifted
	// timeout refusing or let a new one land. Administrator is exempt, as in permissions.Checker.Subject.
	if !permissions.HasAdmin(cp.rolePerms) {
		timedOut, toErr := s.timedOut(ctx, userID)
		if toErr != nil {
			return permissions.Subject{}, toErr
		}
		sub.TimedOut = timedOut
	}
	return sub, nil
}

// RefreshTimeouts reloads the active-timeout mirror after every timeout issue or lift, and at boot. On
// failure the mirror is dropped, so Subject reloads it or fails closed.
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
		if cur, ok := m[r.UserID]; !ok || r.ExpiresAt.After(cur) {
			m[r.UserID] = r.ExpiresAt
		}
	}
	s.timeouts.Store(&m)
	return nil
}

// TimeoutSnapshot returns a copy of the unexpired mirror entries without reloading; the bool is false when
// the mirror is not loaded ("unknown", not "nobody").
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

// ActiveTimeouts reloads the mirror and returns its unexpired entries, failing closed on a store error. For a
// fresh connect's ready, which must not ship a list older than the last timeout write.
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

var errTimeoutMirrorUnloaded = errors.New("timeout mirror not loaded")

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

// GetRoleForUser returns every role the user holds, from the cache when available (Perms the OR of held
// masks, Top the rank, IDs the held roles); (nil, nil) when none.
func (s *PermissionService) GetRoleForUser(ctx context.Context, userID int64) (*db.MemberRoles, error) {
	cp, err := s.getOrPopulate(ctx, userID)
	if err != nil || cp == nil {
		return s.st.GetMemberRoles(ctx, userID)
	}
	// Return a copy so a caller cannot alias or mutate the cached rows.
	return cloneMemberRoles(&cp.roles), nil
}

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

// Generation is the invalidation counter; a caller deriving something from many Subject reads keeps the
// result only if it is unchanged across them.
func (s *PermissionService) Generation() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.gen
}

// InvalidateUser removes cached permissions for a user; call it when their role changes.
func (s *PermissionService) InvalidateUser(userID int64) {
	s.mu.Lock()
	delete(s.cache, userID)
	s.gen++
	s.mu.Unlock()
	s.notifyInvalidated(userID, false)
}

// InvalidateChannel drops the cache for ALL users, since an override change can affect any user with that
// role.
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

// SetInvalidationObserver installs fn to be told of every invalidation after the cache was dropped; call
// before the service is shared. nil removes it.
func (s *PermissionService) SetInvalidationObserver(fn func(userID int64, all bool)) {
	s.onInvalidate = fn
}

func (s *PermissionService) notifyInvalidated(userID int64, all bool) {
	if s.onInvalidate != nil {
		s.onInvalidate(userID, all)
	}
}

// Checker returns the underlying stateless permissions.Checker (e.g.
func (s *PermissionService) Checker() *permissions.Checker {
	return s.checker
}

// CacheStats returns the lifetime hit/miss counters; a miss is any lookup that repopulated from the store, so
// a burst after a role or override change is invalidation cost.
func (s *PermissionService) CacheStats() (hits, misses uint64) {
	return s.hits.Load(), s.misses.Load()
}

// getOrPopulate returns cached perms, populating on miss or staleness. (nil, nil) means no role row; (nil,
// err) a store failure, so a transient error is not collapsed into a denial.
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

	// The key carries the generation snapshot, so a load begun before an invalidation is never shared with a
	// later caller.
	key := strconv.FormatInt(userID, 10) + ":" + strconv.FormatUint(startGen, 10)
	ch := s.loads.DoChan(key, func() (v any, err error) {
		// singleflight re-panics a load panic on a goroutine nothing can recover, so turn it into a load error for
		// every waiter.
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

// loadPerms reads the user's role and overrides and caches the snapshot unless an invalidation raced it;
// detached and bounded by permLoadTimeout since every waiter shares it.
func (s *PermissionService) loadPerms(parent context.Context, userID int64, startGen uint64) (*cachedPerms, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), permLoadTimeout)
	defer cancel()

	// Admins bypass every channel check, so they skip the grants fetch. Otherwise the grants carry the role ids
	// and mask they were composed from, and a role change between the reads is detected by comparing ids and
	// re-reading.
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
			// Fail closed: an empty map would silently drop every deny bit and caching it would do so for
			// permCacheTTL.
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
	// Cache only if no invalidation raced the DB read; otherwise return the snapshot for this request without
	// poisoning the cache.
	if s.gen == startGen {
		s.cache[userID] = cp
	}
	s.mu.Unlock()
	return cp, nil
}
