package ws

// oc_0299_refresh_snapshot_role_test.go — regression test for OC-0299.
//
// refreshUserSnapshot (serve.go) re-reads a handshaking client's user row and,
// when the role changed since the auth-time snapshot, looks up the new role's
// name to cache on c.roleName. c.roleName is authoritative on the wire —
// auth_ok's "role" field, member_join, and every chat_message carry it — so a
// role-lookup failure here must fail the whole handshake closed, exactly like
// the sibling lookup in upgradeAndAuth (serve.go, "role lookup failed during
// handshake") and the one in handleFreshConnect ("role lookup failed,
// disconnecting").
//
// The old code instead defaulted c.roleName to "member" and returned nil,
// silently pinning the session to a fabricated role for its whole lifetime.
//
// This test forces the "role lookup did not resolve" branch by pointing
// role_id at a role row that does not exist (bypassing the FK constraint via
// a connection-scoped pragma toggle, since the in-memory test DB is a single
// connection) — the same GetRoleByID(id) -> (nil, nil) outcome a transient
// lookup failure produces in the buggy code's `roleErr == nil && role != nil`
// check.
import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// missingRoleID names no row in the roles table.
const missingRoleID = int64(999999)

func TestRefreshUserSnapshot_FailsClosedWhenNewRoleLookupFails(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	uid, err := database.CreateUser(ctx, "refresh-role-fail-user", "hash", 4) // 4 = Member, seeded by migration
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	c := newClient(hub, nil, user, "", 0, ctx)
	c.roleName = "member"

	// Point role_id at a nonexistent role, bypassing the FK constraint that
	// would otherwise reject this — the point is to exercise
	// GetRoleByID(missingRoleID) returning (nil, nil), the same shape a
	// transient lookup failure produces in refreshUserSnapshot.
	if _, err := database.ExecContext(ctx, "PRAGMA foreign_keys=OFF"); err != nil {
		t.Fatalf("disable foreign_keys: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE users SET role_id = ? WHERE id = ?`, missingRoleID, uid); err != nil {
		t.Fatalf("reassign role to missing role: %v", err)
	}
	if _, err := database.ExecContext(ctx, "PRAGMA foreign_keys=ON"); err != nil {
		t.Fatalf("re-enable foreign_keys: %v", err)
	}

	if role, roleErr := database.GetRoleByID(ctx, missingRoleID); roleErr != nil || role != nil {
		t.Fatalf("precondition: GetRoleByID(missingRoleID) = (%v, %v), want (nil, nil)", role, roleErr)
	}

	err = hub.refreshUserSnapshot(ctx, database, c)
	if err == nil {
		t.Fatalf("refreshUserSnapshot returned nil error with an unresolvable new role — "+
			"it must fail closed like upgradeAndAuth's and handleFreshConnect's role lookups, "+
			"not silently pin the session to roleName=%q", c.roleName)
	}
	if c.roleName != "member" {
		// Not the real bug assertion (an error return is), but documents that
		// the fabricated default must not have been left in place either.
		t.Logf("c.roleName after failed refresh = %q", c.roleName)
	}
}
