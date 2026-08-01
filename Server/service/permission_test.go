package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// errOverrideStore wraps a real *db.DB but always fails the channel-override
// fetch, so the fail-closed contract (A-2026-07-16) is testable. Embedding
// *db.DB satisfies the service Store interface; only the one overridden method
// diverges, every other call still hits the real database.
type errOverrideStore struct {
	*db.DB
}

func (errOverrideStore) GetAllChannelPermissionsForRole(context.Context, int64) (map[int64]db.ChannelOverride, error) {
	return nil, errors.New("boom")
}

// GetChannelOverridesFor is the merged role+user fetch every visibility site
// now uses. It must fail closed for exactly the same reason.
func (errOverrideStore) GetChannelOverridesFor(context.Context, int64, int64) (map[int64]db.ChannelOverride, error) {
	return nil, errors.New("boom")
}

// TestHasChannelPerm_OverrideFetchErrorDenies locks the fail-closed rule: when
// the override fetch errors we must NOT substitute an empty map, because that
// restores every bit a channel-level deny had stripped — and PermissionService
// would then cache that degraded snapshot for permCacheTTL.
func TestHasChannelPerm_OverrideFetchErrorDenies(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions,
		Position:    1,
	})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "readonly", Type: "text"})
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, 0, permissions.ReadMessages)

	svc := NewPermissionService(errOverrideStore{DB: database}, permissions.NewChecker(database))

	if svc.HasChannelPerm(context.Background(), 1, 10, permissions.ReadMessages) {
		t.Fatal("override fetch failure must deny, not fall back to the base role bits")
	}
}

// newTestPermService creates a PermissionService backed by a real in-memory DB
// pre-populated with a single role and user.
func newTestPermService(t *testing.T) (*PermissionService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions,
		Position:    1,
	})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	checker := permissions.NewChecker(database)
	return NewPermissionService(database, checker), database
}

func TestHasChannelPerm_Allowed(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	// Member has SendMessages | ReadMessages; no overrides exist, so base role perms apply.
	if !svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages) {
		t.Fatal("expected user to have SendMessages permission")
	}
	if !svc.HasChannelPerm(context.Background(), 1, 10, permissions.ReadMessages) {
		t.Fatal("expected user to have ReadMessages permission")
	}
}

func TestHasChannelPerm_Denied(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	// ManageMessages is NOT in the member role.
	if svc.HasChannelPerm(context.Background(), 1, 10, permissions.ManageMessages) {
		t.Fatal("expected user to NOT have ManageMessages permission")
	}
}

func TestHasChannelPerm_OverrideDeny(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "readonly", Type: "text"})
	// Deny SendMessages for this channel.
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, 0, permissions.SendMessages)
	// Invalidate so next check re-populates cache.
	svc.InvalidateAll()

	if svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages) {
		t.Fatal("expected SendMessages to be denied via channel override")
	}
	// ReadMessages should still be allowed.
	if !svc.HasChannelPerm(context.Background(), 1, 10, permissions.ReadMessages) {
		t.Fatal("expected ReadMessages to remain allowed")
	}
}

func TestHasChannelPerm_OverrideAllow(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "special", Type: "text"})
	// Allow ManageMessages (not in base role) via channel override.
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, permissions.ManageMessages, 0)
	svc.InvalidateAll()

	if !svc.HasChannelPerm(context.Background(), 1, 10, permissions.ManageMessages) {
		t.Fatal("expected ManageMessages to be allowed via channel override")
	}
}

func TestHasChannelPerm_AdminBypass(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.AdminRoleID,
		Name:        "admin",
		Permissions: permissions.Administrator,
		Position:    90,
	})
	seedUserRole(t, database, 1, permissions.AdminRoleID)
	checker := permissions.NewChecker(database)
	svc := NewPermissionService(database, checker)

	seedChannel(t, database, &db.Channel{ID: 10, Name: "locked", Type: "text"})
	// Deny everything via override; admin should still bypass.
	seedChannelOverride(t, database, permissions.AdminRoleID, 10, 0, permissions.SendMessages|permissions.ReadMessages)

	if !svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages) {
		t.Fatal("admin should bypass all permission checks")
	}
	if !svc.HasChannelPerm(context.Background(), 1, 10, permissions.ManageMessages) {
		t.Fatal("admin should bypass all permission checks")
	}
}

// TestHasChannelPerm_AdminSkipsOverrideFetch locks the admin skip in
// getOrPopulate: fail-closed must not extend to admins, who bypass every
// channel check anyway. Without the skip, an override-fetch outage would
// deny admins everything instead of nothing.
func TestHasChannelPerm_AdminSkipsOverrideFetch(t *testing.T) {
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.AdminRoleID,
		Name:        "admin",
		Permissions: permissions.Administrator,
		Position:    90,
	})
	seedUserRole(t, database, 1, permissions.AdminRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	svc := NewPermissionService(errOverrideStore{DB: database}, permissions.NewChecker(database))

	if !svc.HasChannelPerm(context.Background(), 1, 10, permissions.ManageMessages) {
		t.Fatal("admin must not be denied by an override-fetch outage; the fetch is skipped for admins")
	}
}

func TestInvalidateUser_ClearsCacheForUser(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	// Populate cache.
	svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages)

	// Now add a deny override.
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, 0, permissions.SendMessages)

	// Without invalidation, cache still says allowed.
	if !svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages) {
		t.Fatal("expected cached value to still allow SendMessages")
	}

	// After invalidation, should pick up the override.
	svc.InvalidateUser(1)
	if svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages) {
		t.Fatal("expected SendMessages to be denied after cache invalidation")
	}
}

func TestInvalidateAll_ClearsEntireCache(t *testing.T) {
	svc, database := newTestPermService(t)
	// Add a second user.
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	// Populate cache for both users.
	svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages)
	svc.HasChannelPerm(context.Background(), 2, 10, permissions.SendMessages)

	// Add deny override.
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, 0, permissions.SendMessages)

	// Both still cached as allowed.
	if !svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages) {
		t.Fatal("expected cached allow for user 1")
	}
	if !svc.HasChannelPerm(context.Background(), 2, 10, permissions.SendMessages) {
		t.Fatal("expected cached allow for user 2")
	}

	svc.InvalidateAll()

	// Both should now see the deny.
	if svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages) {
		t.Fatal("expected deny for user 1 after InvalidateAll")
	}
	if svc.HasChannelPerm(context.Background(), 2, 10, permissions.SendMessages) {
		t.Fatal("expected deny for user 2 after InvalidateAll")
	}
}

func TestPermCacheTTLExpiry(t *testing.T) {
	// This test verifies the cache TTL mechanism. We cannot easily wait 30s
	// in a unit test, so we verify the structural behavior: after manually
	// backdating the populatedAt field the cache should be stale and the
	// next check should re-populate from the store.
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	// Populate cache.
	svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages)

	// Add deny override.
	seedChannelOverride(t, database, permissions.MemberRoleID, 10, 0, permissions.SendMessages)

	// Manually expire the cache entry by backdating populatedAt.
	svc.mu.Lock()
	if cp, ok := svc.cache[int64(1)]; ok {
		cp.populatedAt = time.Now().Add(-permCacheTTL - time.Second)
	}
	svc.mu.Unlock()

	// The next call should re-populate and pick up the deny.
	if svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages) {
		t.Fatal("expected cache TTL expiry to cause re-population with deny override")
	}
}

func TestHasChannelPerm_UnknownUserReturnsFalse(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	// User 999 has no role assigned.
	if svc.HasChannelPerm(context.Background(), 999, 10, permissions.SendMessages) {
		t.Fatal("expected false for unknown user")
	}
}

// raceHookStore wraps a real *db.DB and fires a hook right after the role read
// inside getOrPopulate, letting a test deterministically inject a concurrent
// invalidation into the populate's read→store window.
type raceHookStore struct {
	*db.DB
	onGetRole func()
}

func (s *raceHookStore) GetRoleForUser(ctx context.Context, userID int64) (*db.Role, error) {
	r, err := s.DB.GetRoleForUser(ctx, userID)
	if s.onGetRole != nil {
		s.onGetRole()
	}
	return r, err
}

// TestGetOrPopulate_InvalidationDuringPopulateNotLost locks F6: an invalidation
// that races a populate (landing after the DB read but before the cache store)
// must not be silently overwritten by the stale snapshot. Otherwise a just-revoked
// permission keeps being served for up to permCacheTTL (30s). All three
// invalidation entry points bump the generation, so each is locked separately.
func TestGetOrPopulate_InvalidationDuringPopulateNotLost(t *testing.T) {
	cases := []struct {
		name       string
		invalidate func(*PermissionService)
	}{
		{"InvalidateUser", func(s *PermissionService) { s.InvalidateUser(1) }},
		{"InvalidateChannel", func(s *PermissionService) { s.InvalidateChannel(10) }},
		{"InvalidateAll", func(s *PermissionService) { s.InvalidateAll() }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			database := newTestDB(t)
			seedRole(t, database, &db.Role{
				ID:          permissions.MemberRoleID,
				Name:        "member",
				Permissions: permissions.SendMessages | permissions.ReadMessages,
				Position:    1,
			})
			seedUserRole(t, database, 1, permissions.MemberRoleID)
			seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

			store := &raceHookStore{DB: database}
			svc := NewPermissionService(store, permissions.NewChecker(database))

			fired := false
			store.onGetRole = func() {
				if fired {
					return
				}
				fired = true
				// Admin demotes the role (removes SendMessages) and invalidates,
				// racing this populate between its role read and its cache store.
				if _, err := database.ExecContext(context.Background(), `UPDATE roles SET permissions = ? WHERE id = ?`,
					permissions.ReadMessages, permissions.MemberRoleID); err != nil {
					t.Errorf("demote role: %v", err)
				}
				tc.invalidate(svc)
			}

			// This populate reads the pre-demotion perms; the racing invalidation
			// must stop that stale snapshot from being cached.
			svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages)

			// A fresh check must re-read the DB and see the revoked permission.
			if svc.HasChannelPerm(context.Background(), 1, 10, permissions.SendMessages) {
				t.Fatal("revoked SendMessages served from a stale snapshot; a populate that races an invalidation must not be cached")
			}
		})
	}
}
