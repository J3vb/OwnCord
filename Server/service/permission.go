package service

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// cachedPerms holds a snapshot of a user's role and channel overrides.
type cachedPerms struct {
	roleID      int64
	rolePerms   int64
	overrides   map[int64]permissions.ChannelOverride
	populatedAt time.Time
}

// permCacheTTL is how long cached permissions remain valid before refresh.
const permCacheTTL = 30 * time.Second

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

	// hits/misses are atomics, not mu-guarded ints: the hit path holds mu only
	// as an RLock, so a plain increment there would race.
	hits   atomic.Uint64
	misses atomic.Uint64
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
	return s.checker.HasChannelPermBatch(cp.rolePerms, cp.overrides, channelID, perm)
}

// HasChannelPermChecked is HasChannelPerm's error-preserving counterpart: it
// distinguishes "the store lookup failed" (err != nil, verdict meaningless)
// from "the store answered and the user lacks the bit" (false, nil error).
// OC-0266: a caller like ws's applySetChannelID post-Subscribe revalidation
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
	return s.checker.HasChannelPermBatch(cp.rolePerms, cp.overrides, channelID, perm), nil
}

// Subject resolves the user's role bits and both override layers for
// channelID from the per-user cache, as a permissions.Subject for the
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
	sub := permissions.Subject{RolePerms: cp.rolePerms, Override: cp.overrides[channelID]}
	// TimedOut is a live, uncached lookup on every call (B5-9): a 30s-stale
	// answer here would let a just-lifted timeout keep refusing, or a
	// just-issued one keep landing. Administrator is exempt, mirroring
	// permissions.Checker.Subject's own short-circuit.
	if !permissions.HasAdmin(cp.rolePerms) {
		timedOut, toErr := s.st.HasActiveTimeout(ctx, userID)
		if toErr != nil {
			return permissions.Subject{}, toErr
		}
		sub.TimedOut = timedOut
	}
	return sub, nil
}

// RequireChannelAccess checks whether the user can access the channel with
// the given permission. For DM channels it verifies participant membership.
// For regular channels it uses cached role-based permission checks.
func (s *PermissionService) RequireChannelAccess(ctx context.Context, userID int64, channelType string, channelID, perm int64) error {
	if channelType == "dm" {
		ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
		if err != nil {
			return err
		}
		if !ok {
			return permissions.ErrNotDMParticipant
		}
		return nil
	}
	if !s.HasChannelPerm(ctx, userID, channelID, perm) {
		return permissions.ErrPermissionDenied
	}
	return nil
}

// GetRoleForUser returns the user's role, using the cache when available.
func (s *PermissionService) GetRoleForUser(ctx context.Context, userID int64) (*db.Role, error) {
	cp, err := s.getOrPopulate(ctx, userID)
	if err != nil || cp == nil {
		// Cache miss (or a lookup failure the cache couldn't populate through),
		// fall back to direct DB query.
		return s.st.GetRoleForUser(ctx, userID)
	}
	return s.st.GetRoleByID(ctx, cp.roleID)
}

// InvalidateUser removes cached permissions for a specific user.
// Call this when a user's role changes.
func (s *PermissionService) InvalidateUser(userID int64) {
	s.mu.Lock()
	delete(s.cache, userID)
	s.gen++
	s.mu.Unlock()
}

// InvalidateChannel removes cached permissions for ALL users, since a
// channel override change can affect any user with that role.
// Call this when channel_overrides are modified.
func (s *PermissionService) InvalidateChannel(_ int64) {
	s.mu.Lock()
	s.cache = make(map[int64]*cachedPerms)
	s.gen++
	s.mu.Unlock()
}

// InvalidateAll clears the entire permission cache.
func (s *PermissionService) InvalidateAll() {
	s.mu.Lock()
	s.cache = make(map[int64]*cachedPerms)
	s.gen++
	s.mu.Unlock()
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

	// Populate.
	role, err := s.st.GetRoleForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if role == nil {
		return nil, nil
	}
	// Admins bypass every channel check, so skip the fetch entirely (mirrors
	// ChannelService.ListVisibleChannels and ws.buildReady). The fetch pulls
	// BOTH override layers (role + per-user) in two batch queries, so the
	// cached snapshot can answer the full Discord resolution order without an
	// extra query per channel.
	var overrides map[int64]permissions.ChannelOverride
	if !permissions.HasAdmin(role.Permissions) {
		raw, oErr := s.st.GetChannelOverridesFor(ctx, role.ID, userID)
		if oErr != nil {
			// Fail closed (for HasChannelPerm/GetRoleForUser): an empty map
			// would silently drop every deny bit, and caching it would keep
			// doing so for permCacheTTL. HasChannelPermChecked callers get the
			// error itself and decide for themselves whether that's a denial.
			slog.Error("PermissionService.getOrPopulate override fetch failed, denying", "err", oErr, "user_id", userID, "role_id", role.ID)
			return nil, oErr
		}
		overrides = permOverrides(raw)
	}

	cp = &cachedPerms{
		roleID:      role.ID,
		rolePerms:   role.Permissions,
		overrides:   overrides,
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
