package service

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// newTestModerationService seeds a real in-memory DB with a role hierarchy:
// owner (pos 100, Administrator) > mod (pos 80, BanMembers) > member (pos 40).
// Users: 1=owner, 2=mod, 3=member, 4=member, 5=mod (equal rank to 2).
func newTestModerationService(t *testing.T) (*ModerationService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: 1, Name: "owner", Permissions: permissions.Administrator, Position: 100})
	seedRole(t, database, &db.Role{ID: 2, Name: "mod", Permissions: permissions.BanMembers, Position: 80})
	seedRole(t, database, &db.Role{ID: 3, Name: "member", Permissions: permissions.SendMessages, Position: 40})
	for userID, roleID := range map[int64]int64{1: 1, 2: 2, 3: 3, 4: 3, 5: 2} {
		seedUser(t, database, &db.User{ID: userID, Username: fmt.Sprintf("u%d", userID), Status: "offline"})
		seedUserRole(t, database, userID, roleID)
	}
	checker := permissions.NewChecker(database)
	return NewModerationService(database, NewPermissionService(database, checker)), database
}

func TestBanUser_RequiresBanPermission(t *testing.T) {
	svc, _ := newTestModerationService(t)

	// A member without BAN_MEMBERS is refused.
	if err := svc.BanUser(context.Background(), 3, 4, "nope", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member ban attempt: want ErrForbidden, got %v", err)
	}
	// And gets Forbidden — not NotFound — for a nonexistent target, so the
	// ban path cannot be used to enumerate user ids.
	if err := svc.BanUser(context.Background(), 3, 999, "probe", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("unauthorized probe of missing id: want ErrForbidden, got %v", err)
	}
}

func TestBanUser_HierarchyEnforced(t *testing.T) {
	svc, database := newTestModerationService(t)

	// Equal rank: mod cannot ban mod.
	if err := svc.BanUser(context.Background(), 2, 5, "peer", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("equal-rank ban: want ErrForbidden, got %v", err)
	}
	// Higher rank target: mod cannot ban the owner.
	if err := svc.BanUser(context.Background(), 2, 1, "coup", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("ban owner: want ErrForbidden, got %v", err)
	}
	owner, _ := database.GetUserByID(context.Background(), 1)
	if owner.Banned {
		t.Fatal("owner must not be banned")
	}
}

func TestBanUser_AuthorizedSucceeds(t *testing.T) {
	svc, database := newTestModerationService(t)

	if err := svc.BanUser(context.Background(), 2, 3, "spam", nil); err != nil {
		t.Fatalf("authorized ban: %v", err)
	}
	target, _ := database.GetUserByID(context.Background(), 3)
	if !target.Banned {
		t.Fatal("target should be banned")
	}
	if target.BanReason == nil || *target.BanReason != "spam" {
		t.Fatalf("ban reason not recorded: %v", target.BanReason)
	}

	// Authorized actor gets a real NotFound for a missing target.
	if err := svc.BanUser(context.Background(), 2, 999, "gone", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("authorized ban of missing id: want ErrNotFound, got %v", err)
	}
	// Self-ban is a bad request regardless of authority.
	if err := svc.BanUser(context.Background(), 2, 2, "self", nil); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("self ban: want ErrBadRequest, got %v", err)
	}
}

// newTestRoleService seeds a four-rank hierarchy for the role-assignment and
// force-logout paths: owner (pos 100, Administrator) > admin (pos 80,
// Administrator) > mod (pos 60, MANAGE_ROLES+KICK_MEMBERS) > member (pos 40).
// Users: 1=owner, 2=admin, 3=mod, 4=member, 5=member.
func newTestRoleService(t *testing.T) (*ModerationService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: 1, Name: "owner", Permissions: permissions.Administrator, Position: 100})
	seedRole(t, database, &db.Role{ID: 2, Name: "admin", Permissions: permissions.Administrator, Position: 80})
	seedRole(t, database, &db.Role{ID: 3, Name: "mod",
		Permissions: permissions.ManageRoles | permissions.KickMembers, Position: 60})
	seedRole(t, database, &db.Role{ID: 4, Name: "member", Permissions: permissions.SendMessages, Position: 40})
	for userID, roleID := range map[int64]int64{1: 1, 2: 2, 3: 3, 4: 4, 5: 4} {
		seedUser(t, database, &db.User{ID: userID, Username: fmt.Sprintf("u%d", userID), Status: "offline"})
		seedUserRole(t, database, userID, roleID)
	}
	checker := permissions.NewChecker(database)
	return NewModerationService(database, NewPermissionService(database, checker)), database
}

func roleIDOf(t *testing.T, database *db.DB, userID int64) int64 {
	t.Helper()
	user, err := database.GetUserByID(context.Background(), userID)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID(%d): %v", userID, err)
	}
	return user.RoleID
}

func TestChangeUserRole_RequiresManageRoles(t *testing.T) {
	svc, database := newTestRoleService(t)

	// A member without MANAGE_ROLES is refused...
	if _, err := svc.ChangeUserRole(context.Background(), 4, 5, 3); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member role change: want ErrForbidden, got %v", err)
	}
	// ...and gets Forbidden, not NotFound, for a missing target.
	if _, err := svc.ChangeUserRole(context.Background(), 4, 999, 3); !errors.Is(err, ErrForbidden) {
		t.Fatalf("unauthorized probe of missing id: want ErrForbidden, got %v", err)
	}
	if got := roleIDOf(t, database, 5); got != 4 {
		t.Fatalf("target role changed to %d despite refusal", got)
	}
}

func TestChangeUserRole_CannotAssignAtOrAboveOwnRank(t *testing.T) {
	svc, database := newTestRoleService(t)

	// The hole this closes: an Administrator could promote anyone to Owner.
	if _, err := svc.ChangeUserRole(context.Background(), 2, 4, 1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("admin promoting to owner: want ErrForbidden, got %v", err)
	}
	// Equal rank is refused too — an admin cannot mint another admin.
	if _, err := svc.ChangeUserRole(context.Background(), 2, 4, 2); !errors.Is(err, ErrForbidden) {
		t.Fatalf("admin assigning own rank: want ErrForbidden, got %v", err)
	}
	if got := roleIDOf(t, database, 4); got != 4 {
		t.Fatalf("member role changed to %d despite refusal", got)
	}
	// Strictly below own rank is allowed.
	if _, err := svc.ChangeUserRole(context.Background(), 2, 4, 3); err != nil {
		t.Fatalf("admin promoting to mod: %v", err)
	}
	if got := roleIDOf(t, database, 4); got != 3 {
		t.Fatalf("role after promotion = %d, want 3", got)
	}
	// The owner outranks the admin role, so the owner may grant it.
	if _, err := svc.ChangeUserRole(context.Background(), 1, 5, 2); err != nil {
		t.Fatalf("owner promoting to admin: %v", err)
	}
}

func TestChangeUserRole_HierarchyAndValidation(t *testing.T) {
	svc, database := newTestRoleService(t)

	// A moderator holding MANAGE_ROLES still cannot touch a higher-ranked user.
	if _, err := svc.ChangeUserRole(context.Background(), 3, 2, 4); !errors.Is(err, ErrForbidden) {
		t.Fatalf("mod demoting an admin: want ErrForbidden, got %v", err)
	}
	if got := roleIDOf(t, database, 2); got != 2 {
		t.Fatalf("admin role changed to %d despite refusal", got)
	}
	// Nor the owner.
	if _, err := svc.ChangeUserRole(context.Background(), 3, 1, 4); !errors.Is(err, ErrForbidden) {
		t.Fatalf("mod demoting the owner: want ErrForbidden, got %v", err)
	}
	// Self-service promotion is a bad request regardless of authority.
	if _, err := svc.ChangeUserRole(context.Background(), 2, 2, 1); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("self role change: want ErrBadRequest, got %v", err)
	}
	// A nonexistent role is a bad request, not a 500.
	if _, err := svc.ChangeUserRole(context.Background(), 1, 4, 9999); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("unknown role id: want ErrBadRequest, got %v", err)
	}
	// Authorized actor gets a real NotFound for a missing target.
	if _, err := svc.ChangeUserRole(context.Background(), 1, 999, 4); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing target: want ErrNotFound, got %v", err)
	}
}

func TestChangeUserRole_AuditWritten(t *testing.T) {
	svc, database := newTestRoleService(t)

	if _, err := svc.ChangeUserRole(context.Background(), 1, 4, 3); err != nil {
		t.Fatalf("owner role change: %v", err)
	}
	entries, err := database.GetAuditLog(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	found := false
	for _, e := range entries {
		if e.Action == "role_change" && e.TargetID == 4 && e.ActorID == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("no role_change audit entry, got %+v", entries)
	}
}

func TestForceLogout_AuthorizationMatrix(t *testing.T) {
	svc, database := newTestRoleService(t)

	ctx := context.Background()
	if _, err := database.CreateSession(ctx, 4, "victim-hash", "web", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// No KICK_MEMBERS → Forbidden (member 5 targeting member 4).
	if err := svc.ForceLogout(ctx, 5, 4); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member force-logout: want ErrForbidden, got %v", err)
	}
	// Holding KICK_MEMBERS is not enough against a higher rank.
	if err := svc.ForceLogout(ctx, 3, 2); !errors.Is(err, ErrForbidden) {
		t.Fatalf("mod force-logout of admin: want ErrForbidden, got %v", err)
	}
	// Self is a bad request.
	if err := svc.ForceLogout(ctx, 3, 3); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("self force-logout: want ErrBadRequest, got %v", err)
	}
	sessions, _ := database.GetUserSessions(ctx, 4)
	if len(sessions) != 1 {
		t.Fatalf("sessions = %d before an authorized call, want 1", len(sessions))
	}

	// Authorized: mod outranks member and holds KICK_MEMBERS.
	if err := svc.ForceLogout(ctx, 3, 4); err != nil {
		t.Fatalf("authorized force-logout: %v", err)
	}
	sessions, _ = database.GetUserSessions(ctx, 4)
	if len(sessions) != 0 {
		t.Fatalf("sessions = %d after force logout, want 0", len(sessions))
	}
	// Authorized actor gets a real NotFound for a missing target.
	if err := svc.ForceLogout(ctx, 3, 999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing target: want ErrNotFound, got %v", err)
	}
}

func TestUnbanUser_AuthorizationMatrix(t *testing.T) {
	svc, database := newTestModerationService(t)

	if err := svc.BanUser(context.Background(), 1, 3, "setup", nil); err != nil {
		t.Fatalf("setup ban: %v", err)
	}

	// No BAN_MEMBERS → Forbidden (member 4 trying to unban member 3).
	if err := svc.UnbanUser(context.Background(), 4, 3); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member unban: want ErrForbidden, got %v", err)
	}
	// Equal rank → Forbidden.
	if err := svc.UnbanUser(context.Background(), 2, 5); !errors.Is(err, ErrForbidden) {
		t.Fatalf("equal-rank unban: want ErrForbidden, got %v", err)
	}
	// Authorized → succeeds.
	if err := svc.UnbanUser(context.Background(), 2, 3); err != nil {
		t.Fatalf("authorized unban: %v", err)
	}
	target, _ := database.GetUserByID(context.Background(), 3)
	if target.Banned {
		t.Fatal("target should be unbanned")
	}
}
