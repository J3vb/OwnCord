package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

func execModerationSQL(t *testing.T, database *db.DB, query string, args ...any) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(), query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

// ReadModerationCoverage must answer the same question as permissions.CanModerate, built the
// way the report queue builds its subject: the OR of every held role's mask. For each user in
// turn (everyone else banned) the SQL count equals the predicate's verdict.
func TestModerationCoverage_MatchesCanModerate(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)

	execModerationSQL(t, database,
		`INSERT INTO roles (id, name, color, permissions, position, is_default) VALUES (10, 'Root', NULL, ?, 50, 0), (11, 'Plain', NULL, ?, 30, 0), (12, 'Mod', NULL, ?, 20, 0)`,
		permissions.Administrator, permissions.SendMessages, permissions.ModerateMembers)

	owner := seedUser(t, database, "owner")
	setRole(t, database, owner, permissions.OwnerRoleID)
	admin := seedUser(t, database, "admin")
	setRole(t, database, admin, permissions.AdminRoleID)
	mod := seedUser(t, database, "mod")
	setRole(t, database, mod, permissions.ModeratorRoleID)
	member := seedUser(t, database, "member")
	root := seedUser(t, database, "root")
	setRole(t, database, root, 10)
	plain := seedUser(t, database, "plain")
	setRole(t, database, plain, 11)
	multi := seedUser(t, database, "multi") // Plain plus Mod: only the OR of masks grants it.
	setRole(t, database, multi, 11)
	mustGrant(t, database, multi, 12)

	users := []int64{owner, admin, mod, member, root, plain, multi}

	check := func(label string) {
		t.Helper()
		for _, id := range users {
			roles, err := database.GetMemberRoles(ctx, id)
			if err != nil || roles == nil {
				t.Fatalf("%s: GetMemberRoles(%d) = %v, %v", label, id, roles, err)
			}
			want := 0
			if permissions.CanModerate(permissions.Subject{RolePerms: roles.Perms}) == nil {
				want = 1
			}
			execModerationSQL(t, database, `UPDATE users SET banned = 1 WHERE id <> ?`, id)
			cov, err := database.ReadModerationCoverage(ctx)
			execModerationSQL(t, database, `UPDATE users SET banned = 0`)
			if err != nil {
				t.Fatalf("%s: ReadModerationCoverage: %v", label, err)
			}
			if cov.Moderators != want {
				t.Errorf("%s: user %d: SQL counts %d, CanModerate says %d (perms %#x)", label, id, cov.Moderators, want, roles.Perms)
			}
		}
	}

	check("defaults")

	// An operator strips Moderate Members from the seeded Admin and Moderator roles.
	execModerationSQL(t, database, `UPDATE roles SET permissions = permissions & ~? WHERE id IN (2, 3)`, permissions.ModerateMembers)
	check("seeded roles stripped")

	// The owner role loses nothing here, but a hand-edited Owner without either bit would not count.
	execModerationSQL(t, database, `UPDATE roles SET permissions = permissions & ~? WHERE id = 1`,
		permissions.ModerateMembers|permissions.Administrator)
	check("owner stripped")
}

func mustGrant(t *testing.T, database *db.DB, userID, roleID int64) {
	t.Helper()
	if err := database.AddUserRole(context.Background(), userID, roleID); err != nil {
		t.Fatalf("AddUserRole(%d, %d): %v", userID, roleID, err)
	}
}
