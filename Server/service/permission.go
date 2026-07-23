package service

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/telemetry"
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

	mu    sync.RWMutex
	cache map[int64]*cachedPerms // keyed by userID
	// gen is bumped by every Invalidate* call. getOrPopulate snapshots it before
	// its DB read and refuses to cache if it changed, so an invalidation that
	// races a populate can't be lost (F6).
	gen uint64
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
func (s *PermissionService) HasChannelPerm(userID, channelID, perm int64) bool {
	// Phase B Step 8 — span the perm check so traces show how many permission
	// lookups a single REST/WS request triggers. The cache hit path is fast,
	// but knowing how often it misses is the whole point of having metrics.
	_, span := telemetry.GlobalTracer("service/permission").Start(context.Background(),
		"PermissionService.HasChannelPerm",
		telemetry.Int64("user_id", userID),
		telemetry.Int64("channel_id", channelID),
	)
	defer span.End()
	cp := s.getOrPopulate(userID)
	if cp == nil {
		return false
	}
	return s.checker.HasChannelPermBatch(cp.rolePerms, cp.overrides, channelID, perm)
}

// RequireChannelAccess checks whether the user can access the channel with
// the given permission. For DM channels it verifies participant membership.
// For regular channels it uses cached role-based permission checks.
func (s *PermissionService) RequireChannelAccess(userID int64, channelType string, channelID, perm int64) error {
	if channelType == "dm" {
		ok, err := s.st.IsDMParticipant(userID, channelID)
		if err != nil {
			return err
		}
		if !ok {
			return permissions.ErrNotDMParticipant
		}
		return nil
	}
	if !s.HasChannelPerm(userID, channelID, perm) {
		return permissions.ErrPermissionDenied
	}
	return nil
}

// GetRoleForUser returns the user's role, using the cache when available.
func (s *PermissionService) GetRoleForUser(userID int64) (*db.Role, error) {
	cp := s.getOrPopulate(userID)
	if cp == nil {
		// Cache miss, fall back to direct DB query.
		return s.st.GetRoleForUser(userID)
	}
	return s.st.GetRoleByID(cp.roleID)
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

// getOrPopulate returns cached perms for the user, populating the cache
// on miss or staleness. Returns nil if the user's role can't be loaded.
func (s *PermissionService) getOrPopulate(userID int64) *cachedPerms {
	s.mu.RLock()
	cp, ok := s.cache[userID]
	if ok && time.Since(cp.populatedAt) < permCacheTTL {
		s.mu.RUnlock()
		return cp
	}
	startGen := s.gen
	s.mu.RUnlock()

	// Populate.
	role, err := s.st.GetRoleForUser(userID)
	if err != nil || role == nil {
		return nil
	}
	// Admins bypass every channel check, so skip the fetch entirely (mirrors
	// ChannelService.ListVisibleChannels and ws.buildReady).
	var overrides map[int64]permissions.ChannelOverride
	if !permissions.HasAdmin(role.Permissions) {
		raw, oErr := s.st.GetAllChannelPermissionsForRole(role.ID)
		if oErr != nil {
			// Fail closed: an empty map would silently drop every deny bit,
			// and caching it would keep doing so for permCacheTTL.
			slog.Error("PermissionService.getOrPopulate override fetch failed, denying", "err", oErr, "user_id", userID, "role_id", role.ID)
			return nil
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
	return cp
}
