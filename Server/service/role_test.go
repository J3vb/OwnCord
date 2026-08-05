package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// newRoleCRUDService builds a RoleService over the hierarchy these tests use,
// layered on the four migration-seeded defaults (Owner 100, Admin 80,
// Moderator 60, Member 40 / is_default):
//
//	user 1 → Owner    (ADMINISTRATOR, position 100)
//	user 2 → Admin    (everything but ADMINISTRATOR, position 80)
//	user 3 → Moderator(MANAGE_ROLES + a few bits, position 60)
//	user 4 → Member   (default role, position 40)
//	user 5 → Member
//
// The Moderator role is redefined so it holds MANAGE_ROLES but NOT
// MANAGE_SERVER — that gap is what the "cannot grant a bit you lack" tests
// exercise.
func newRoleCRUDService(t *testing.T) (*RoleService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: permissions.OwnerRoleID, Name: "Owner",
		Permissions: permissions.Administrator, Position: permissions.OwnerRolePosition})
	seedRole(t, database, &db.Role{ID: permissions.AdminRoleID, Name: "Admin",
		Permissions: permissions.AllPerms &^ permissions.Administrator, Position: 80})
	seedRole(t, database, &db.Role{ID: permissions.ModeratorRoleID, Name: "Moderator",
		Permissions: permissions.ManageRoles | permissions.ReadMessages | permissions.SendMessages |
			permissions.KickMembers, Position: 60})
	for userID, roleID := range map[int64]int64{
		1: permissions.OwnerRoleID,
		2: permissions.AdminRoleID,
		3: permissions.ModeratorRoleID,
		4: permissions.MemberRoleID,
		5: permissions.MemberRoleID,
	} {
		seedUser(t, database, &db.User{ID: userID})
		seedUserRole(t, database, userID, roleID)
	}
	checker := permissions.NewChecker(database)
	return NewRoleService(database, NewPermissionService(database, checker)), database
}

// ─── Create ──────────────────────────────────────────────────────────────────

func TestCreateRole_HappyPath(t *testing.T) {
	svc, database := newRoleCRUDService(t)

	role, err := svc.CreateRole(context.Background(), 1, RoleInput{
		Name:        new("  Helper  "),
		Color:       new("#5865f2"),
		Permissions: new(permissions.SendMessages | permissions.ReadMessages),
		Position:    new(50),
	})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if role.Name != "Helper" {
		t.Errorf("name = %q, want trimmed %q", role.Name, "Helper")
	}
	if role.Color == nil || *role.Color != "#5865F2" {
		t.Errorf("color = %v, want normalized #5865F2", role.Color)
	}
	if role.Position != 50 {
		t.Errorf("position = %d, want 50", role.Position)
	}
	if role.IsDefault {
		t.Error("a created role must never be the default")
	}

	stored, err := database.GetRoleByID(context.Background(), role.ID)
	if err != nil || stored == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}
	if stored.Permissions != permissions.SendMessages|permissions.ReadMessages {
		t.Errorf("stored permissions = %#x", stored.Permissions)
	}

	assertAudit(t, database, "role_create")
}

func TestCreateRole_DefaultsToJustBelowActor(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	// The Admin actor sits at 80, so an unpositioned role lands at 79.
	role, err := svc.CreateRole(context.Background(), 2, RoleInput{Name: new("Deputy")})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if role.Position != 79 {
		t.Errorf("position = %d, want 79 (one below the actor)", role.Position)
	}
	if role.Permissions != 0 {
		t.Errorf("permissions = %#x, want 0 when the body omits them", role.Permissions)
	}
}

// Two roles created back-to-back without an explicit position must not collide:
// tied positions read as equal rank in every hierarchy check, so the second
// default placement steps past the first.
func TestCreateRole_DefaultPlacementAvoidsCollision(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	first, err := svc.CreateRole(context.Background(), 2, RoleInput{Name: new("Deputy")})
	if err != nil {
		t.Fatalf("CreateRole first: %v", err)
	}
	second, err := svc.CreateRole(context.Background(), 2, RoleInput{Name: new("Deputy2")})
	if err != nil {
		t.Fatalf("CreateRole second: %v", err)
	}
	if first.Position == second.Position {
		t.Fatalf("two default-placed roles collided at position %d", first.Position)
	}
	if second.Position != first.Position-1 {
		t.Errorf("second position = %d, want %d (the next free slot below the first)", second.Position, first.Position-1)
	}
}

// An explicit position already held by another role is refused rather than
// silently duplicated.
func TestCreateRole_RejectsExplicitPositionCollision(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	first, err := svc.CreateRole(context.Background(), 2, RoleInput{Name: new("Deputy")})
	if err != nil {
		t.Fatalf("CreateRole first: %v", err)
	}
	_, err = svc.CreateRole(context.Background(), 2, RoleInput{Name: new("Clash"), Position: &first.Position})
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("explicit-collision err = %v, want ErrBadRequest", err)
	}
}

func TestCreateRole_NameUniquenessIsCaseInsensitive(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	if _, err := svc.CreateRole(context.Background(), 1, RoleInput{Name: new("mEmBeR")}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("colliding name: want ErrBadRequest, got %v", err)
	}
	if _, err := svc.CreateRole(context.Background(), 1, RoleInput{Name: new("   ")}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("blank name: want ErrBadRequest, got %v", err)
	}
	long := strings.Repeat("x", maxRoleNameLen+1)
	if _, err := svc.CreateRole(context.Background(), 1, RoleInput{Name: &long}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("over-long name: want ErrBadRequest, got %v", err)
	}
}

func TestCreateRole_RejectsBadColor(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	for _, color := range []string{"red", "5865F2", "#12345", "rgb(1,2,3)"} {
		if _, err := svc.CreateRole(context.Background(), 1, RoleInput{
			Name: new("c-" + color), Color: new(color),
		}); !errors.Is(err, ErrBadRequest) {
			t.Errorf("color %q: want ErrBadRequest, got %v", color, err)
		}
	}
	// An empty color is "no color", not an error.
	role, err := svc.CreateRole(context.Background(), 1, RoleInput{Name: new("Plain"), Color: new("")})
	if err != nil {
		t.Fatalf("empty color: %v", err)
	}
	if role.Color != nil {
		t.Errorf("color = %v, want nil", role.Color)
	}
}

func TestCreateRole_RequiresManageRoles(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	// User 4 holds the default Member role — no MANAGE_ROLES.
	if _, err := svc.CreateRole(context.Background(), 4, RoleInput{Name: new("Sneaky")}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member create: want ErrForbidden, got %v", err)
	}
	// An unresolvable actor is Forbidden too, never a silent success.
	if _, err := svc.CreateRole(context.Background(), 999, RoleInput{Name: new("Ghost")}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("unknown actor: want ErrForbidden, got %v", err)
	}
}

func TestCreateRole_CannotPlaceAtOrAboveOwnRank(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	// Moderator sits at 60.
	for _, pos := range []int{60, 80, 100} {
		if _, err := svc.CreateRole(context.Background(), 3, RoleInput{
			Name: new("Above"), Position: new(pos),
		}); !errors.Is(err, ErrForbidden) {
			t.Errorf("position %d: want ErrForbidden, got %v", pos, err)
		}
	}
	if _, err := svc.CreateRole(context.Background(), 3, RoleInput{
		Name: new("Negative"), Position: new(-1),
	}); !errors.Is(err, ErrBadRequest) {
		t.Errorf("negative position: want ErrBadRequest, got %v", err)
	}
}

func TestCreateRole_CannotGrantUnheldBit(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	// The Moderator role has MANAGE_ROLES but not MANAGE_SERVER.
	if _, err := svc.CreateRole(context.Background(), 3, RoleInput{
		Name: new("Escalation"), Permissions: new(permissions.ManageServer),
	}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("granting an unheld bit: want ErrForbidden, got %v", err)
	}
	// ADMINISTRATOR bypasses: the owner may grant anything.
	if _, err := svc.CreateRole(context.Background(), 1, RoleInput{
		Name: new("Powerful"), Permissions: new(permissions.ManageServer | permissions.BanMembers),
	}); err != nil {
		t.Fatalf("owner grant: %v", err)
	}
	// Bits this build does not define are dropped, not persisted.
	role, err := svc.CreateRole(context.Background(), 1, RoleInput{
		Name: new("Masked"), Permissions: new(^int64(0)),
	})
	if err != nil {
		t.Fatalf("CreateRole with unknown bits: %v", err)
	}
	if role.Permissions != permissions.AllPerms {
		t.Errorf("permissions = %#x, want the mask narrowed to AllPerms (%#x)", role.Permissions, permissions.AllPerms)
	}
}

// ─── Update ──────────────────────────────────────────────────────────────────

// An explicit position already held by ANOTHER role is refused on update just
// as on create: tied positions read as equal rank in every >=/<= hierarchy
// comparison, silently breaking one role's authority over the other's members.
func TestUpdateRole_RejectsExplicitPositionCollision(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	// Owner moves Moderator (60) onto Member's slot (40).
	_, _, err := svc.UpdateRole(context.Background(), 1, permissions.ModeratorRoleID,
		RoleInput{Position: new(40)})
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("collision err = %v, want ErrBadRequest", err)
	}
}

// Re-stating a role's own current position is not a collision.
func TestUpdateRole_AllowsKeepingOwnPosition(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	if _, _, err := svc.UpdateRole(context.Background(), 1, permissions.ModeratorRoleID,
		RoleInput{Position: new(60)}); err != nil {
		t.Fatalf("same-position update: %v", err)
	}
}

func TestUpdateRole_PartialBodyLeavesOtherFields(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	created, err := svc.CreateRole(context.Background(), 1, RoleInput{
		Name:        new("Support"),
		Color:       new("#ABC"),
		Permissions: new(permissions.ReadMessages),
		Position:    new(30),
	})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}

	updated, permsChanged, err := svc.UpdateRole(context.Background(), 1, created.ID, RoleInput{
		Name: new("Support Team"),
	})
	if err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	if permsChanged {
		t.Error("permsChanged must be false when the body omits permissions")
	}
	if updated.Name != "Support Team" {
		t.Errorf("name = %q", updated.Name)
	}
	if updated.Color == nil || *updated.Color != "#ABC" {
		t.Errorf("color = %v, want unchanged #ABC", updated.Color)
	}
	if updated.Permissions != permissions.ReadMessages || updated.Position != 30 {
		t.Errorf("permissions/position changed unexpectedly: %#x / %d", updated.Permissions, updated.Position)
	}
}

func TestUpdateRole_ReportsPermissionChange(t *testing.T) {
	svc, database := newRoleCRUDService(t)

	created, err := svc.CreateRole(context.Background(), 1, RoleInput{Name: new("Bots")})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	_, permsChanged, err := svc.UpdateRole(context.Background(), 1, created.ID, RoleInput{
		Permissions: new(permissions.ReadMessages),
	})
	if err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	if !permsChanged {
		t.Error("permsChanged should be true when the mask moves")
	}
	// Re-applying the same mask is not a change.
	_, permsChanged, err = svc.UpdateRole(context.Background(), 1, created.ID, RoleInput{
		Permissions: new(permissions.ReadMessages),
	})
	if err != nil {
		t.Fatalf("UpdateRole idempotent: %v", err)
	}
	if permsChanged {
		t.Error("permsChanged should be false when the mask is unchanged")
	}
	assertAudit(t, database, "role_update")
}

func TestUpdateRole_HierarchyAndGrantRules(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	// A moderator (60) may not edit the Admin role (80) …
	if _, _, err := svc.UpdateRole(context.Background(), 3, permissions.AdminRoleID, RoleInput{
		Name: new("Pwned"),
	}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("edit higher role: want ErrForbidden, got %v", err)
	}
	// … nor their own role, which is at equal rank.
	if _, _, err := svc.UpdateRole(context.Background(), 3, permissions.ModeratorRoleID, RoleInput{
		Permissions: new(permissions.Administrator),
	}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("edit own role: want ErrForbidden, got %v", err)
	}
	// … and may not add a bit they lack to a role they can edit.
	if _, _, err := svc.UpdateRole(context.Background(), 3, permissions.MemberRoleID, RoleInput{
		Permissions: new(permissions.ManageServer),
	}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("grant unheld bit: want ErrForbidden, got %v", err)
	}
	// Removing a bit they lack IS allowed — de-escalation is always safe.
	member, err := svc.CreateRole(context.Background(), 1, RoleInput{
		Name: new("Overpowered"), Position: new(20),
		Permissions: new(permissions.ManageServer | permissions.ReadMessages),
	})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if _, _, err := svc.UpdateRole(context.Background(), 3, member.ID, RoleInput{
		Permissions: new(permissions.ReadMessages),
	}); err != nil {
		t.Fatalf("de-escalating edit: %v", err)
	}
}

func TestUpdateRole_NotFoundAndNameCollision(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	if _, _, err := svc.UpdateRole(context.Background(), 1, 9999, RoleInput{Name: new("Nope")}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing role: want ErrNotFound, got %v", err)
	}
	// Renaming onto another role's name (case-insensitively) is refused …
	if _, _, err := svc.UpdateRole(context.Background(), 1, permissions.MemberRoleID, RoleInput{
		Name: new("moderator"),
	}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("name collision: want ErrBadRequest, got %v", err)
	}
	// … but re-submitting a role's own name is not a collision.
	if _, _, err := svc.UpdateRole(context.Background(), 1, permissions.MemberRoleID, RoleInput{
		Name: new("member"),
	}); err != nil {
		t.Fatalf("self-rename: %v", err)
	}
}

// ─── Delete ──────────────────────────────────────────────────────────────────

func TestDeleteRole_ReassignsMembersAndDropsOverrides(t *testing.T) {
	svc, database := newRoleCRUDService(t)
	ctx := context.Background()

	role, err := svc.CreateRole(ctx, 1, RoleInput{Name: new("Contractor"), Position: new(30)})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general"})
	if err := database.UpsertChannelOverride(ctx, 10, role.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	// Two members hold the role; a third stays put so the UPDATE is proven
	// to be scoped rather than global.
	seedUserRole(t, database, 4, role.ID)
	seedUserRole(t, database, 5, role.ID)

	deleted, fallback, moved, err := svc.DeleteRole(ctx, 1, role.ID)
	if err != nil {
		t.Fatalf("DeleteRole: %v", err)
	}
	if deleted.ID != role.ID {
		t.Errorf("deleted role id = %d, want %d", deleted.ID, role.ID)
	}
	if fallback.ID != permissions.MemberRoleID || !fallback.IsDefault {
		t.Errorf("fallback = %+v, want the default role", fallback)
	}
	if len(moved) != 2 {
		t.Fatalf("moved = %v, want 2 members", moved)
	}

	for _, uid := range []int64{4, 5} {
		u, err := database.GetUserByID(ctx, uid)
		if err != nil || u == nil {
			t.Fatalf("GetUserByID(%d): %v", uid, err)
		}
		if u.RoleID != permissions.MemberRoleID {
			t.Errorf("user %d role = %d, want the default %d", uid, u.RoleID, permissions.MemberRoleID)
		}
	}
	if gone, err := database.GetRoleByID(ctx, role.ID); err != nil || gone != nil {
		t.Errorf("role still present after delete: %v, %v", gone, err)
	}
	overrides, err := database.GetChannelOverrides(ctx, 10)
	if err != nil {
		t.Fatalf("GetChannelOverrides: %v", err)
	}
	if _, ok := overrides[role.ID]; ok {
		t.Error("channel_overrides row for the deleted role survived")
	}
	// User 3 (Moderator) is untouched — the reassignment is scoped to the role.
	if u, _ := database.GetUserByID(ctx, 3); u.RoleID != permissions.ModeratorRoleID {
		t.Errorf("unrelated user role changed to %d", u.RoleID)
	}
	assertAudit(t, database, "role_delete")
}

func TestDeleteRole_OwnerAndDefaultAreUndeletable(t *testing.T) {
	svc, database := newRoleCRUDService(t)
	ctx := context.Background()

	// Nothing outranks the Owner role, so even the owner is refused.
	if _, _, _, err := svc.DeleteRole(ctx, 1, permissions.OwnerRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete owner role: want ErrForbidden, got %v", err)
	}
	// The default role is below the owner, so it clears the hierarchy check and
	// is stopped by the is_default rule specifically.
	_, _, _, err := svc.DeleteRole(ctx, 1, permissions.MemberRoleID)
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("delete default role: want ErrBadRequest, got %v", err)
	}
	if role, _ := database.GetRoleByID(ctx, permissions.MemberRoleID); role == nil {
		t.Fatal("the default role was deleted")
	}

	// A moderator may not delete a role at or above their own rank.
	if _, _, _, err := svc.DeleteRole(ctx, 3, permissions.AdminRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete higher role: want ErrForbidden, got %v", err)
	}
	if _, _, _, err := svc.DeleteRole(ctx, 3, permissions.ModeratorRoleID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete own role: want ErrForbidden, got %v", err)
	}
	if _, _, _, err := svc.DeleteRole(ctx, 1, 9999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete missing role: want ErrNotFound, got %v", err)
	}
}

func TestDeleteRole_InvalidatesReassignedMembers(t *testing.T) {
	svc, database := newRoleCRUDService(t)
	ctx := context.Background()

	role, err := svc.CreateRole(ctx, 1, RoleInput{
		Name: new("Temp"), Position: new(30),
		Permissions: new(permissions.ReadMessages | permissions.ManageMessages),
	})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	seedUserRole(t, database, 4, role.ID)

	// Warm the cache with the doomed role's mask.
	cached, err := svc.perms.GetRoleForUser(ctx, 4)
	if err != nil || cached == nil {
		t.Fatalf("GetRoleForUser: %v", err)
	}
	if cached.ID != role.ID {
		t.Fatalf("cached role = %d, want %d", cached.ID, role.ID)
	}

	if _, _, _, err := svc.DeleteRole(ctx, 1, role.ID); err != nil {
		t.Fatalf("DeleteRole: %v", err)
	}

	// Without the invalidation this still answers with the deleted role.
	after, err := svc.perms.GetRoleForUser(ctx, 4)
	if err != nil || after == nil {
		t.Fatalf("GetRoleForUser after delete: %v", err)
	}
	if after.ID != permissions.MemberRoleID {
		t.Errorf("cached role after delete = %d, want the default %d", after.ID, permissions.MemberRoleID)
	}
}

// ─── Reorder ─────────────────────────────────────────────────────────────────

func TestReorderRoles_NormalizesPositions(t *testing.T) {
	svc, database := newRoleCRUDService(t)
	ctx := context.Background()

	extra, err := svc.CreateRole(ctx, 1, RoleInput{Name: new("Helper"), Position: new(50)})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}

	// The owner may reorder everything below position 100: Admin, Moderator,
	// Helper and Member — highest first.
	updated, err := svc.ReorderRoles(ctx, 1, []int64{
		permissions.AdminRoleID, extra.ID, permissions.ModeratorRoleID, permissions.MemberRoleID,
	})
	if err != nil {
		t.Fatalf("ReorderRoles: %v", err)
	}

	want := map[int64]int{
		permissions.OwnerRoleID:     100, // untouched, still above everything
		permissions.AdminRoleID:     4,
		extra.ID:                    3,
		permissions.ModeratorRoleID: 2,
		permissions.MemberRoleID:    1,
	}
	for _, r := range updated {
		if got := want[r.ID]; r.Position != got {
			t.Errorf("role %d position = %d, want %d", r.ID, r.Position, got)
		}
	}
	// The returned list is the persisted one.
	stored, err := database.ListRoles(ctx)
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	for _, r := range stored {
		if got := want[r.ID]; r.Position != got {
			t.Errorf("stored role %d position = %d, want %d", r.ID, r.Position, got)
		}
	}
	// Highest position first, as the ready payload expects.
	if stored[0].ID != permissions.OwnerRoleID || stored[len(stored)-1].ID != permissions.MemberRoleID {
		t.Errorf("order = %d…%d, want owner first and member last", stored[0].ID, stored[len(stored)-1].ID)
	}
	assertAudit(t, database, "role_reorder")
}

func TestReorderRoles_RejectsPartialAndForeignLists(t *testing.T) {
	svc, _ := newRoleCRUDService(t)
	ctx := context.Background()

	// Three roles sit below the owner; a two-element list is refused rather
	// than leaving the omitted role at a position that now collides.
	if _, err := svc.ReorderRoles(ctx, 1, []int64{permissions.AdminRoleID, permissions.MemberRoleID}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("partial list: want ErrBadRequest, got %v", err)
	}
	// Duplicates would silently drop a role.
	if _, err := svc.ReorderRoles(ctx, 1, []int64{
		permissions.AdminRoleID, permissions.AdminRoleID, permissions.MemberRoleID,
	}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("duplicate ids: want ErrBadRequest, got %v", err)
	}
	// A moderator may reorder only what is below them: naming the Admin role
	// is Forbidden, and the count check runs first for a short list.
	if _, err := svc.ReorderRoles(ctx, 3, []int64{permissions.AdminRoleID}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("foreign role: want ErrForbidden, got %v", err)
	}
	// Same for an id that does not exist at all.
	if _, err := svc.ReorderRoles(ctx, 3, []int64{9999}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("unknown role: want ErrForbidden, got %v", err)
	}
	// A member cannot reorder anything.
	if _, err := svc.ReorderRoles(ctx, 4, nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member reorder: want ErrForbidden, got %v", err)
	}
}

// ─── List ────────────────────────────────────────────────────────────────────

func TestListRoles_CarriesMemberCounts(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	list, err := svc.ListRoles(context.Background(), 1)
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	counts := map[int64]int{}
	for _, r := range list {
		counts[r.ID] = r.MemberCount
	}
	if counts[permissions.MemberRoleID] != 2 {
		t.Errorf("member count = %d, want 2", counts[permissions.MemberRoleID])
	}
	if counts[permissions.OwnerRoleID] != 1 {
		t.Errorf("owner count = %d, want 1", counts[permissions.OwnerRoleID])
	}
	if _, err := svc.ListRoles(context.Background(), 4); !errors.Is(err, ErrForbidden) {
		t.Errorf("member list: want ErrForbidden, got %v", err)
	}
}

func TestAffectedUserIDs(t *testing.T) {
	svc, _ := newRoleCRUDService(t)

	ids := svc.AffectedUserIDs(context.Background(), permissions.MemberRoleID)
	if len(ids) != 2 {
		t.Errorf("AffectedUserIDs = %v, want 2 members", ids)
	}
	if got := svc.AffectedUserIDs(context.Background(), 9999); len(got) != 0 {
		t.Errorf("AffectedUserIDs(missing) = %v, want empty", got)
	}
}

// assertAudit fails unless an audit row with the given action exists.
func assertAudit(t *testing.T, database *db.DB, action string) {
	t.Helper()
	entries, err := database.GetAuditLog(context.Background(), 50, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	for _, e := range entries {
		if e.Action == action {
			return
		}
	}
	t.Errorf("no %q audit entry written", action)
}
