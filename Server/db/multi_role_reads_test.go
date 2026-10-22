package db_test

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// mirrorRoleID reads users.role_id straight from the table.
func mirrorRoleID(t *testing.T, database *db.DB, userID int64) int64 {
	t.Helper()
	var id int64
	if err := database.QueryRowContext(context.Background(), `SELECT role_id FROM users WHERE id = ?`, userID).Scan(&id); err != nil {
		t.Fatalf("read users.role_id: %v", err)
	}
	return id
}

func heldRoleIDs(t *testing.T, database *db.DB, userID int64) []int64 {
	t.Helper()
	m, err := database.GetMemberRoles(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetMemberRoles: %v", err)
	}
	if m == nil {
		return nil
	}
	ids := slices.Clone(m.IDs)
	slices.Sort(ids)
	return ids
}

// UpdateUserRole means "replace every role with this one" and keeps
// users.role_id equal to the top held role.
func TestUpdateUserRole_ReplacesEveryRoleAndMirrors(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, err := database.CreateUser(ctx, "multi", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := database.AddUserRole(ctx, uid, 3); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	if got := mirrorRoleID(t, database, uid); got != 3 {
		t.Fatalf("mirror after adding Moderator = %d, want 3 (the top role)", got)
	}

	if err := database.UpdateUserRole(ctx, uid, 2); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	if got := heldRoleIDs(t, database, uid); !slices.Equal(got, []int64{2}) {
		t.Fatalf("held roles after replace = %v, want [2]", got)
	}
	if got := mirrorRoleID(t, database, uid); got != 2 {
		t.Fatalf("mirror after replace = %d, want 2", got)
	}

	// A lower role replaces a higher one (the mirror follows, never ratchets).
	if err := database.UpdateUserRole(ctx, uid, 4); err != nil {
		t.Fatalf("UpdateUserRole down: %v", err)
	}
	if got := mirrorRoleID(t, database, uid); got != 4 || !slices.Equal(heldRoleIDs(t, database, uid), []int64{4}) {
		t.Fatalf("after demotion mirror = %d, held = %v", got, heldRoleIDs(t, database, uid))
	}
}

// Deleting a role keeps the other roles of its members and hands the fallback
// only to members left with none; the mirror is re-synced for every holder.
func TestDeleteRoleReassigning_KeepsOtherRolesAndMirrors(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	custom, err := database.CreateRole(ctx, "Custom", nil, permissions.ReadMessages, 70, false, false)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	only, err := database.CreateUser(ctx, "only-custom", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := database.UpdateUserRole(ctx, only, custom.ID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	both, err := database.CreateUser(ctx, "custom-and-mod", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := database.AddUserRole(ctx, both, custom.ID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	if got := mirrorRoleID(t, database, both); got != custom.ID {
		t.Fatalf("precondition: mirror = %d, want the higher Custom role %d", got, custom.ID)
	}

	moved, err := database.DeleteRoleReassigning(ctx, custom.ID, permissions.MemberRoleID)
	if err != nil {
		t.Fatalf("DeleteRoleReassigning: %v", err)
	}
	slices.Sort(moved)
	if !slices.Equal(moved, []int64{only, both}) {
		t.Fatalf("returned holders = %v, want [%d %d]", moved, only, both)
	}
	if got := heldRoleIDs(t, database, only); !slices.Equal(got, []int64{permissions.MemberRoleID}) {
		t.Errorf("roleless holder holds %v, want only the fallback", got)
	}
	if got := mirrorRoleID(t, database, only); got != permissions.MemberRoleID {
		t.Errorf("roleless holder mirror = %d, want the fallback", got)
	}
	if got := heldRoleIDs(t, database, both); !slices.Equal(got, []int64{3}) {
		t.Errorf("member with another role holds %v, want just Moderator (no fallback added)", got)
	}
	if got := mirrorRoleID(t, database, both); got != 3 {
		t.Errorf("mirror after the deleted role went = %d, want Moderator (3)", got)
	}
}

// GetMemberGrants resolves each held role with its own override and OR's the
// masks; a single-role member carries no layers.
func TestGetMemberGrants_TwoRolesCarryLayersOnlyWhereARoleHasAnOverride(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	private, _ := database.CreateChannel(ctx, "private", "text", "", "", 0)
	plain, _ := database.CreateChannel(ctx, "plain", "text", "", "", 1)
	userOnly, _ := database.CreateChannel(ctx, "user-only", "text", "", "", 2)
	uid, err := database.CreateUser(ctx, "two-roles", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := database.AddUserRole(ctx, uid, 3); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	// Private channels are marked by denying READ to the default role.
	if err := database.UpsertChannelOverride(ctx, private, permissions.MemberRoleID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	if err := database.UpsertChannelUserOverride(ctx, userOnly, uid, permissions.AttachFiles, 0); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}

	g, err := database.GetMemberGrants(ctx, uid)
	if err != nil {
		t.Fatalf("GetMemberGrants: %v", err)
	}
	roles, _ := database.GetMemberRoles(ctx, uid)
	if g.Perms != roles.Perms {
		t.Errorf("Perms = %#x, want the OR of held masks %#x", g.Perms, roles.Perms)
	}
	if len(g.Layers[private]) != 2 {
		t.Fatalf("private channel layers = %+v, want one per held role", g.Layers[private])
	}
	if g.Overrides[private].Allow != 0 || g.Overrides[private].Deny != 0 {
		t.Errorf("a layered channel must not also carry a role-layer Override: %+v", g.Overrides[private])
	}
	if _, ok := g.Layers[plain]; ok {
		t.Errorf("a channel no held role overrides needs no layers: %+v", g.Layers[plain])
	}
	if _, ok := g.Layers[userOnly]; ok || g.Overrides[userOnly].UserAllow != permissions.AttachFiles {
		t.Errorf("user-only channel = layers %+v override %+v", g.Layers[userOnly], g.Overrides[userOnly])
	}

	ck := permissions.NewChecker(database)
	if !ck.HasChannelPermBatch(g, private, permissions.ReadMessages) {
		t.Error("Member (READ denied here) plus Moderator must still read the private channel")
	}
	memberOnly, _ := database.CreateUser(ctx, "member-only", "hash", int(permissions.MemberRoleID))
	mg, _ := database.GetMemberGrants(ctx, memberOnly)
	if ck.HasChannelPermBatch(mg, private, permissions.ReadMessages) {
		t.Error("a Member-only user must not read the private channel")
	}
	if len(mg.Layers) != 0 {
		t.Errorf("a one-role member carries no layers: %+v", mg.Layers)
	}

	// The live checker path agrees with the batch path.
	for _, perm := range []int64{permissions.ReadMessages, permissions.SendMessages, permissions.AttachFiles} {
		for _, ch := range []int64{private, plain, userOnly} {
			live := ck.HasChannelPerm(ctx, roles.Held(), uid, ch, perm)
			if batch := ck.HasChannelPermBatch(g, ch, perm); live != batch {
				t.Errorf("channel %d perm %#x: live %v != batch %v", ch, perm, live, batch)
			}
		}
	}
}

// A last-admin guard must see an Administrator role that is not the member's
// top role.
func TestLastAdminGuard_AdminInLowerRole(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	// A high-ranked role with no administrator bit; the Admin role (80) sits
	// below it, so the account's mirror names the non-admin role.
	top, err := database.CreateRole(ctx, "Overlord", nil, permissions.ReadMessages, 95, false, false)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	uid, err := database.CreateUser(ctx, "hidden-admin", "hash", int(permissions.AdminRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := database.AddUserRole(ctx, uid, top.ID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	if got := mirrorRoleID(t, database, uid); got != top.ID {
		t.Fatalf("precondition: mirror = %d, want the non-admin top role", got)
	}
	n, err := database.CountAdminClassAccounts(ctx)
	if err != nil || n != 1 {
		t.Fatalf("CountAdminClassAccounts = %d, %v; want 1 (the Administrator role below the top still counts)", n, err)
	}
	if err := eraseAccount(ctx, database, uid); !errors.Is(err, db.ErrLastAdmin) {
		t.Fatalf("DeleteAccount(last admin holding the admin bit in a lower role) = %v, want ErrLastAdmin", err)
	}
}

// Eligible moderators and the decider's own authority read the OR of every
// held mask, so a bit granted by a role below the top still authorises.
func TestDeciderAuthority_ORsHeldMasks(t *testing.T) {
	database, ownerID, modID, memberID, member2ID := newAppealQueriesTestDB(t)
	ctx := context.Background()

	helper, err := database.CreateRole(ctx, "Helper", nil, permissions.ModerateMembers, 10, false, false)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if err := database.AddUserRole(ctx, member2ID, helper.ID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	if got := mirrorRoleID(t, database, member2ID); got != permissions.MemberRoleID {
		t.Fatalf("precondition: mirror = %d, want Member (the Helper role ranks below it)", got)
	}

	// Eligible: the moderator and the Member who also holds Helper.
	n, err := database.CountEligibleModerators(ctx, ownerID, memberID, permissions.ModerateMembers, permissions.Administrator)
	if err != nil || n != 2 {
		t.Fatalf("CountEligibleModerators = %d, %v; want 2 (mod and the Helper holder)", n, err)
	}

	actionID, err := database.WarnUser(ctx, memberID, ownerID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-two-role-decider", actionID, memberID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}
	action, _ := database.GetModerationAction(ctx, actionID)
	reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
	result, _, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, "upheld", member2ID, "ok",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, simpleAuthorityCheck)
	if err != nil || result != db.AppealWriteOK {
		t.Fatalf("decide by a Member holding Helper: result %v, err %v; want AppealWriteOK", result, err)
	}
	_ = modID
}

// Rank is the position of the TOP held role, for every actor-outranks check.
func TestRolePosition_UsesTopRole(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	actor, _ := database.CreateUser(ctx, "actor", "hash", int(permissions.MemberRoleID))
	target, _ := database.CreateUser(ctx, "target", "hash", 3) // Moderator, position 60
	// Admin (80) is added to the actor; Member (40) stays held.
	if err := database.AddUserRole(ctx, actor, permissions.AdminRoleID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	// The actor outranks the Moderator target through the Admin role...
	if _, err := database.BanUserWithAction(ctx, target, "r", nil, actor, nil); err != nil {
		t.Fatalf("BanUserWithAction by an actor whose TOP role (Admin) outranks the target: %v", err)
	}
	// ...but not once the Admin role is gone and only Member remains.
	other, _ := database.CreateUser(ctx, "other", "hash", 3)
	if err := database.RemoveUserRole(ctx, actor, permissions.AdminRoleID); err != nil {
		t.Fatalf("RemoveUserRole: %v", err)
	}
	if _, err := database.BanUserWithAction(ctx, other, "r", nil, actor, nil); !errors.Is(err, db.ErrOutranked) {
		t.Fatalf("BanUserWithAction after losing the top role = %v, want ErrOutranked", err)
	}
}

// A member with no user_roles row at all is still judged by users.role_id, so
// the last-admin guard cannot be skipped by a drifted database.
func TestLastAdminGuard_ZeroRoleRowsFallsBackToMirror(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, err := database.CreateUser(ctx, "rowless-admin", "hash", int(permissions.AdminRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	execAll(t, database, `DELETE FROM user_roles WHERE user_id = `+strconv.FormatInt(uid, 10))
	if err := eraseAccount(ctx, database, uid); !errors.Is(err, db.ErrLastAdmin) {
		t.Fatalf("DeleteAccount(last admin with no user_roles row) = %v, want ErrLastAdmin", err)
	}
	if err := eraseAccount(ctx, database, 987654); err == nil || errors.Is(err, db.ErrLastAdmin) {
		t.Fatalf("DeleteAccount(missing user) = %v, want an error", err)
	}
}

// ListMentionTargetsByRoles joins user_roles: a member is listed once and
// counted for any role they hold, with every held role reported.
func TestListMentionTargetsByRoles_TwoRoleHolderListedOnce(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, _ := database.CreateUser(ctx, "two", "hash", int(permissions.MemberRoleID))
	if err := database.AddUserRole(ctx, uid, 3); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	// The Moderator role (3) outranks Member, so it is the member's top role and
	// the users.role_id mirror. Asking for the LOWER role (Member) proves the
	// lookup reads user_roles and not the mirror.
	got, err := database.ListMentionTargetsByRoles(ctx, []int64{permissions.MemberRoleID})
	if err != nil {
		t.Fatalf("ListMentionTargetsByRoles: %v", err)
	}
	if len(got) != 1 || got[0].UserID != uid {
		t.Fatalf("targets = %+v, want the two-role holder exactly once", got)
	}
	slices.Sort(got[0].RoleIDs)
	if !slices.Equal(got[0].RoleIDs, []int64{3, permissions.MemberRoleID}) {
		t.Errorf("RoleIDs = %v, want both held roles", got[0].RoleIDs)
	}
	both, err := database.ListMentionTargetsByRoles(ctx, []int64{3, permissions.MemberRoleID})
	if err != nil || len(both) != 1 {
		t.Fatalf("asking for both roles = %+v, %v; want one row, not one per role", both, err)
	}
}

// ListUserIDsByRole (behind RoleService.AffectedUserIDs) reads user_roles.
func TestListUserIDsByRole_ReadsEveryHolder(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, _ := database.CreateUser(ctx, "holder", "hash", int(permissions.MemberRoleID))
	if err := database.AddUserRole(ctx, uid, 3); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	ids, err := database.ListUserIDsByRole(ctx, permissions.MemberRoleID)
	if err != nil || !slices.Contains(ids, uid) {
		t.Fatalf("ListUserIDsByRole(Member) = %v, %v; want the holder whose top role is Moderator", ids, err)
	}
	counts, err := database.CountRoleMembers(ctx)
	if err != nil || counts[permissions.MemberRoleID] != 1 || counts[3] != 1 {
		t.Fatalf("CountRoleMembers = %v, %v; want the holder counted under both roles", counts, err)
	}
}

// Effective carries the top role's identity with the OR of every held mask,
// and its colour is a copy, so editing it never reaches the cached Top.
func TestMemberRoles_EffectiveTopIdentityORMask(t *testing.T) {
	color := "#ff0000"
	m := &db.MemberRoles{
		Top:   db.Role{ID: 3, Name: "Moderator", Position: 80, Permissions: 0b0011, Color: &color},
		Perms: 0b0111,
		IDs:   []int64{3, 4},
		Masks: []int64{0b0011, 0b0100},
	}
	eff := m.Effective()
	if eff.ID != 3 || eff.Name != "Moderator" || eff.Position != 80 {
		t.Fatalf("identity = %d/%s/%d, want the top role", eff.ID, eff.Name, eff.Position)
	}
	if eff.Permissions != 0b0111 {
		t.Fatalf("Permissions = %b, want the OR of held masks", eff.Permissions)
	}
	*eff.Color = "#00ff00"
	if *m.Top.Color != "#ff0000" {
		t.Fatalf("editing Effective().Color changed Top.Color to %s", *m.Top.Color)
	}

	noColor := (&db.MemberRoles{Top: db.Role{ID: 4}, Perms: 1}).Effective()
	if noColor.Color != nil || noColor.Permissions != 1 {
		t.Fatalf("no-colour role: Color = %v, Permissions = %d", noColor.Color, noColor.Permissions)
	}
}

// Every role writer fails cleanly, changing nothing, when its context is gone
// before the transaction starts.
func TestRoleWriters_CancelledContextChangesNothing(t *testing.T) {
	database := openMigratedMemory(t)
	uid, err := database.CreateUser(context.Background(), "cancelled", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := database.UpdateUserRole(ctx, uid, 3); err == nil {
		t.Fatal("UpdateUserRole with a cancelled context returned nil")
	}
	if err := database.AddUserRole(ctx, uid, 3); err == nil {
		t.Fatal("AddUserRole with a cancelled context returned nil")
	}
	if err := database.RemoveUserRole(ctx, uid, permissions.MemberRoleID); err == nil {
		t.Fatal("RemoveUserRole with a cancelled context returned nil")
	}
	if _, err := database.DeleteRoleReassigning(ctx, 3, permissions.MemberRoleID); err == nil {
		t.Fatal("DeleteRoleReassigning with a cancelled context returned nil")
	}
	if got := heldRoleIDs(t, database, uid); !slices.Equal(got, []int64{permissions.MemberRoleID}) {
		t.Fatalf("held roles = %v, want only Member", got)
	}
}
