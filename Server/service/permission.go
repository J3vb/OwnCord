package service

import (
	"context"
	"sync"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/store"
	"github.com/owncord/server/telemetry"
)

// cachedPerms holds a snapshot of a user's role and channel overrides.
type cachedPerms struct {
	roleID      int64
	rolePerms   int64
	overrides   map[int64]db.ChannelOverride
	populatedAt time.Time
}

// permCacheTTL is how long cached permissions remain valid before refresh.
const permCacheTTL = 30 * time.Second

// PermissionService wraps the stateless permissions.Checker with per-user
// caching. It eliminates per-message DB round-trips for permission checks
// at scale. The cache is populated lazily on first access and invalidated
// on role or channel override changes.
type PermissionService struct {
	st      store.Store
	checker *permissions.Checker

	mu    sync.RWMutex
	cache map[int64]*cachedPerms // keyed by userID
}

// NewPermissionService creates a PermissionService backed by the given DB.
func NewPermissionService(st store.Store, checker *permissions.Checker) *PermissionService {
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
	if permissions.HasAdmin(cp.rolePerms) {
		return true
	}
	o := cp.overrides[channelID] // zero-value (0,0) when no override exists
	effective := permissions.EffectivePerms(cp.rolePerms, o.Allow, o.Deny)
	return effective&perm == perm
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
	s.mu.Unlock()
}

// InvalidateChannel removes cached permissions for ALL users, since a
// channel override change can affect any user with that role.
// Call this when channel_overrides are modified.
func (s *PermissionService) InvalidateChannel(_ int64) {
	s.mu.Lock()
	s.cache = make(map[int64]*cachedPerms)
	s.mu.Unlock()
}

// InvalidateAll clears the entire permission cache.
func (s *PermissionService) InvalidateAll() {
	s.mu.Lock()
	s.cache = make(map[int64]*cachedPerms)
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
	s.mu.RUnlock()

	// Populate.
	role, err := s.st.GetRoleForUser(userID)
	if err != nil || role == nil {
		return nil
	}
	overrides, err := s.st.GetAllChannelPermissionsForRole(role.ID)
	if err != nil {
		// Fall back to uncached if override fetch fails.
		overrides = make(map[int64]db.ChannelOverride)
	}

	cp = &cachedPerms{
		roleID:      role.ID,
		rolePerms:   role.Permissions,
		overrides:   overrides,
		populatedAt: time.Now(),
	}

	s.mu.Lock()
	s.cache[userID] = cp
	s.mu.Unlock()
	return cp
}
