package service

import (
	"testing"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/store"
)

// newTestPermService creates a PermissionService backed by a MemStore
// pre-populated with a single role and user.
func newTestPermService() (*PermissionService, *store.MemStore) {
	ms := store.NewMemStore()
	ms.SeedRole(&db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions,
		Position:    1,
	})
	ms.SeedUserRole(1, permissions.MemberRoleID)
	checker := permissions.NewChecker(ms)
	return NewPermissionService(ms, checker), ms
}

func TestHasChannelPerm_Allowed(t *testing.T) {
	svc, ms := newTestPermService()
	ms.SeedChannel(&db.Channel{ID: 10, Name: "general", Type: "text"})

	// Member has SendMessages | ReadMessages; no overrides exist, so base role perms apply.
	if !svc.HasChannelPerm(1, 10, permissions.SendMessages) {
		t.Fatal("expected user to have SendMessages permission")
	}
	if !svc.HasChannelPerm(1, 10, permissions.ReadMessages) {
		t.Fatal("expected user to have ReadMessages permission")
	}
}

func TestHasChannelPerm_Denied(t *testing.T) {
	svc, ms := newTestPermService()
	ms.SeedChannel(&db.Channel{ID: 10, Name: "general", Type: "text"})

	// ManageMessages is NOT in the member role.
	if svc.HasChannelPerm(1, 10, permissions.ManageMessages) {
		t.Fatal("expected user to NOT have ManageMessages permission")
	}
}

func TestHasChannelPerm_OverrideDeny(t *testing.T) {
	svc, ms := newTestPermService()
	ms.SeedChannel(&db.Channel{ID: 10, Name: "readonly", Type: "text"})
	// Deny SendMessages for this channel.
	ms.SeedChannelOverride(permissions.MemberRoleID, 10, 0, permissions.SendMessages)
	// Invalidate so next check re-populates cache.
	svc.InvalidateAll()

	if svc.HasChannelPerm(1, 10, permissions.SendMessages) {
		t.Fatal("expected SendMessages to be denied via channel override")
	}
	// ReadMessages should still be allowed.
	if !svc.HasChannelPerm(1, 10, permissions.ReadMessages) {
		t.Fatal("expected ReadMessages to remain allowed")
	}
}

func TestHasChannelPerm_OverrideAllow(t *testing.T) {
	svc, ms := newTestPermService()
	ms.SeedChannel(&db.Channel{ID: 10, Name: "special", Type: "text"})
	// Allow ManageMessages (not in base role) via channel override.
	ms.SeedChannelOverride(permissions.MemberRoleID, 10, permissions.ManageMessages, 0)
	svc.InvalidateAll()

	if !svc.HasChannelPerm(1, 10, permissions.ManageMessages) {
		t.Fatal("expected ManageMessages to be allowed via channel override")
	}
}

func TestHasChannelPerm_AdminBypass(t *testing.T) {
	ms := store.NewMemStore()
	ms.SeedRole(&db.Role{
		ID:          permissions.AdminRoleID,
		Name:        "admin",
		Permissions: permissions.Administrator,
		Position:    90,
	})
	ms.SeedUserRole(1, permissions.AdminRoleID)
	checker := permissions.NewChecker(ms)
	svc := NewPermissionService(ms, checker)

	ms.SeedChannel(&db.Channel{ID: 10, Name: "locked", Type: "text"})
	// Deny everything via override; admin should still bypass.
	ms.SeedChannelOverride(permissions.AdminRoleID, 10, 0, permissions.SendMessages|permissions.ReadMessages)

	if !svc.HasChannelPerm(1, 10, permissions.SendMessages) {
		t.Fatal("admin should bypass all permission checks")
	}
	if !svc.HasChannelPerm(1, 10, permissions.ManageMessages) {
		t.Fatal("admin should bypass all permission checks")
	}
}

func TestInvalidateUser_ClearsCacheForUser(t *testing.T) {
	svc, ms := newTestPermService()
	ms.SeedChannel(&db.Channel{ID: 10, Name: "general", Type: "text"})

	// Populate cache.
	svc.HasChannelPerm(1, 10, permissions.SendMessages)

	// Now add a deny override.
	ms.SeedChannelOverride(permissions.MemberRoleID, 10, 0, permissions.SendMessages)

	// Without invalidation, cache still says allowed.
	if !svc.HasChannelPerm(1, 10, permissions.SendMessages) {
		t.Fatal("expected cached value to still allow SendMessages")
	}

	// After invalidation, should pick up the override.
	svc.InvalidateUser(1)
	if svc.HasChannelPerm(1, 10, permissions.SendMessages) {
		t.Fatal("expected SendMessages to be denied after cache invalidation")
	}
}

func TestInvalidateAll_ClearsEntireCache(t *testing.T) {
	svc, ms := newTestPermService()
	// Add a second user.
	ms.SeedUserRole(2, permissions.MemberRoleID)
	ms.SeedChannel(&db.Channel{ID: 10, Name: "general", Type: "text"})

	// Populate cache for both users.
	svc.HasChannelPerm(1, 10, permissions.SendMessages)
	svc.HasChannelPerm(2, 10, permissions.SendMessages)

	// Add deny override.
	ms.SeedChannelOverride(permissions.MemberRoleID, 10, 0, permissions.SendMessages)

	// Both still cached as allowed.
	if !svc.HasChannelPerm(1, 10, permissions.SendMessages) {
		t.Fatal("expected cached allow for user 1")
	}
	if !svc.HasChannelPerm(2, 10, permissions.SendMessages) {
		t.Fatal("expected cached allow for user 2")
	}

	svc.InvalidateAll()

	// Both should now see the deny.
	if svc.HasChannelPerm(1, 10, permissions.SendMessages) {
		t.Fatal("expected deny for user 1 after InvalidateAll")
	}
	if svc.HasChannelPerm(2, 10, permissions.SendMessages) {
		t.Fatal("expected deny for user 2 after InvalidateAll")
	}
}

func TestPermCacheTTLExpiry(t *testing.T) {
	// This test verifies the cache TTL mechanism. We cannot easily wait 30s
	// in a unit test, so we verify the structural behavior: after manually
	// backdating the populatedAt field the cache should be stale and the
	// next check should re-populate from the store.
	svc, ms := newTestPermService()
	ms.SeedChannel(&db.Channel{ID: 10, Name: "general", Type: "text"})

	// Populate cache.
	svc.HasChannelPerm(1, 10, permissions.SendMessages)

	// Add deny override.
	ms.SeedChannelOverride(permissions.MemberRoleID, 10, 0, permissions.SendMessages)

	// Manually expire the cache entry by backdating populatedAt.
	svc.mu.Lock()
	if cp, ok := svc.cache[int64(1)]; ok {
		cp.populatedAt = time.Now().Add(-permCacheTTL - time.Second)
	}
	svc.mu.Unlock()

	// The next call should re-populate and pick up the deny.
	if svc.HasChannelPerm(1, 10, permissions.SendMessages) {
		t.Fatal("expected cache TTL expiry to cause re-population with deny override")
	}
}

func TestHasChannelPerm_UnknownUserReturnsFalse(t *testing.T) {
	svc, ms := newTestPermService()
	ms.SeedChannel(&db.Channel{ID: 10, Name: "general", Type: "text"})

	// User 999 has no role assigned.
	if svc.HasChannelPerm(999, 10, permissions.SendMessages) {
		t.Fatal("expected false for unknown user")
	}
}
