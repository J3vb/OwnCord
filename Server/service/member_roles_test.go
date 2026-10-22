package service

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// WP 6.3c: adding and removing one role of a member. Roles come from
// newTestRoleService: owner 1 (100) > admin 2 (80) > mod 3 (60, MANAGE_ROLES) >
// member 4 (40); users 1=owner, 2=admin, 3=mod, 4 and 5=member. helper (7) sits
// at 50, between mod and member.
const memberRolesHelperID = int64(7)

func newMemberRolesFixture(t *testing.T) (*ModerationService, *db.DB) {
	t.Helper()
	svc, database := newTestRoleService(t)
	seedRole(t, database, &db.Role{ID: memberRolesHelperID, Name: "helper", Position: 50, Permissions: permissions.ReadMessages})
	return svc, database
}

func heldIDs(t *testing.T, database *db.DB, userID int64) []int64 {
	t.Helper()
	held, err := database.GetMemberRoles(context.Background(), userID)
	if err != nil || held == nil {
		t.Fatalf("GetMemberRoles(%d) = %v, %v", userID, held, err)
	}
	return held.IDs
}

func TestAddUserRole_Hierarchy(t *testing.T) {
	cases := []struct {
		name    string
		actor   int64
		target  int64
		role    int64
		wantErr error
	}{
		{"no MANAGE_ROLES", 4, 5, memberRolesHelperID, ErrForbidden},
		{"role at actor rank", 3, 5, 3, ErrForbidden},
		{"role above actor rank", 3, 5, 2, ErrForbidden},
		{"target outranks actor", 3, 2, memberRolesHelperID, ErrForbidden},
		{"target at actor rank", 3, 3, memberRolesHelperID, ErrBadRequest}, // self
		{"unknown role", 3, 5, 9999, ErrBadRequest},
		{"unknown target", 3, 999, memberRolesHelperID, ErrNotFound},
		{"ok", 3, 5, memberRolesHelperID, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, database := newMemberRolesFixture(t)
			_, err := svc.AddUserRole(context.Background(), tc.actor, tc.target, tc.role)
			if tc.wantErr == nil {
				if err != nil {
					t.Fatalf("AddUserRole: %v", err)
				}
				if got := heldIDs(t, database, tc.target); !slices.Equal(got, []int64{memberRolesHelperID, 4}) {
					t.Fatalf("held roles = %v, want [helper member] (top first)", got)
				}
				if got := roleIDOf(t, database, tc.target); got != memberRolesHelperID {
					t.Errorf("users.role_id = %d, want the new top role %d", got, memberRolesHelperID)
				}
				return
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("AddUserRole err = %v, want %v", err, tc.wantErr)
			}
			if tc.target == 5 {
				if got := heldIDs(t, database, 5); !slices.Equal(got, []int64{4}) {
					t.Errorf("refused add changed the held roles to %v", got)
				}
			}
		})
	}
}

func TestAddUserRole_AuditsInvalidatesAndNotifiesOnce(t *testing.T) {
	svc, database := newMemberRolesFixture(t)
	ctx := context.Background()
	rec := &permNotifyRecorder{probe: roleProbe(t, svc.perms, 5)}
	svc.SetPermissionNotifier(rec)
	// Warm the cache with the member-only snapshot.
	if got := roleProbe(t, svc.perms, 5)(); got != [3]any{"member", permissions.SendMessages, 40} {
		t.Fatalf("warm probe = %v", got)
	}

	if _, err := svc.AddUserRole(ctx, 3, 5, memberRolesHelperID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	// A second grant of the same role is a no-op: no audit row, no fan-out.
	if _, err := svc.AddUserRole(ctx, 3, 5, memberRolesHelperID); err != nil {
		t.Fatalf("repeat AddUserRole: %v", err)
	}

	want := [3]any{"helper", permissions.SendMessages | permissions.ReadMessages, 50}
	if len(rec.events) != 2 || rec.kinds()[0] != "revoke" || rec.kinds()[1] != "roles" {
		t.Fatalf("notifier calls = %v, want one revoke and one roles", rec.kinds())
	}
	for _, ev := range rec.events {
		if ev.probe != want {
			t.Errorf("cache at %s time = %v, want %v (the cache must be dropped before the fan-out)", ev.kind, ev.probe, want)
		}
	}
	if fan := rec.events[1].fan; !slices.Equal(fan.Visibility, []int64{5}) || !slices.Equal(fan.MemberUpdate, []int64{5}) {
		t.Errorf("fan-out = %+v, want visibility and member_update for user 5", fan)
	}
	entries, err := database.GetAuditLog(ctx, 20, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	n := 0
	for _, e := range entries {
		if e.Action == "role_add" && e.TargetID == 5 && e.ActorID == 3 {
			n++
		}
	}
	if n != 1 {
		t.Errorf("role_add audit rows = %d, want 1", n)
	}
}

func TestRemoveUserRole_LastRoleRefused(t *testing.T) {
	svc, database := newMemberRolesFixture(t)
	ctx := context.Background()

	_, err := svc.RemoveUserRole(ctx, 3, 5, 4)
	if !errors.Is(err, ErrLastRole) || !errors.Is(err, ErrConflict) {
		t.Fatalf("removing the only role: err = %v, want ErrLastRole (a conflict)", err)
	}
	if got := heldIDs(t, database, 5); !slices.Equal(got, []int64{4}) {
		t.Fatalf("held roles = %v, want the member role kept", got)
	}

	// With a second role the first can go; the audit row and mirror follow.
	if _, err := svc.AddUserRole(ctx, 3, 5, memberRolesHelperID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	if _, err := svc.RemoveUserRole(ctx, 3, 5, memberRolesHelperID); err != nil {
		t.Fatalf("RemoveUserRole: %v", err)
	}
	if got := roleIDOf(t, database, 5); got != 4 {
		t.Errorf("users.role_id = %d, want 4 after removing the top role", got)
	}
	// A role the member does not hold is a no-op, not a refusal.
	if _, err := svc.RemoveUserRole(ctx, 3, 5, memberRolesHelperID); err != nil {
		t.Errorf("removing a role not held: %v", err)
	}
	entries, err := database.GetAuditLog(ctx, 20, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	var removed int
	for _, e := range entries {
		if e.Action == "role_remove" {
			removed++
		}
	}
	if removed != 1 {
		t.Errorf("role_remove audit rows = %d, want 1 (the refused and the no-op removals write none)", removed)
	}
}

func TestRemoveUserRole_ConcurrentLastTwo(t *testing.T) {
	for round := range 15 {
		svc, database := newMemberRolesFixture(t)
		ctx := context.Background()
		if _, err := svc.AddUserRole(ctx, 3, 5, memberRolesHelperID); err != nil {
			t.Fatalf("round %d: AddUserRole: %v", round, err)
		}

		// Two moderators race to strip the member's last two roles.
		var wg sync.WaitGroup
		start := make(chan struct{})
		errs := make([]error, 2)
		for i, role := range []int64{4, memberRolesHelperID} {
			wg.Go(func() {
				<-start
				_, errs[i] = svc.RemoveUserRole(ctx, 3, 5, role)
			})
		}
		close(start)
		wg.Wait()

		ok, last := 0, 0
		for _, err := range errs {
			switch {
			case err == nil:
				ok++
			case errors.Is(err, ErrLastRole):
				last++
			default:
				t.Fatalf("round %d: unexpected error %v", round, err)
			}
		}
		if ok != 1 || last != 1 {
			t.Fatalf("round %d: %d succeeded and %d got LAST_ROLE, want exactly one of each", round, ok, last)
		}
		if got := heldIDs(t, database, 5); len(got) != 1 {
			t.Fatalf("round %d: member holds %v, want exactly one role left", round, got)
		}
	}
}

func TestPatchRoleID_ReplacesSet(t *testing.T) {
	svc, database := newMemberRolesFixture(t)
	ctx := context.Background()
	if _, err := svc.AddUserRole(ctx, 3, 5, memberRolesHelperID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	if _, err := svc.ChangeUserRole(ctx, 1, 5, 3); err != nil {
		t.Fatalf("ChangeUserRole: %v", err)
	}
	if got := heldIDs(t, database, 5); !slices.Equal(got, []int64{3}) {
		t.Fatalf("held roles after PATCH role_id = %v, want exactly [3]", got)
	}
	if got := roleIDOf(t, database, 5); got != 3 {
		t.Errorf("users.role_id = %d, want 3", got)
	}
}

func TestDeleteRole_MemberWithOtherRoleKeepsIt(t *testing.T) {
	modSvc, database := newMemberRolesFixture(t)
	ctx := context.Background()
	roles := NewRoleService(database, modSvc.perms)
	rec := &permNotifyRecorder{}
	roles.SetPermissionNotifier(rec)

	// User 5 holds member + helper; user 4 holds only helper.
	if _, err := modSvc.AddUserRole(ctx, 3, 5, memberRolesHelperID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	seedUserRole(t, database, 4, memberRolesHelperID)

	if _, _, moved, err := roles.DeleteRole(ctx, 1, memberRolesHelperID); err != nil {
		t.Fatalf("DeleteRole: %v", err)
	} else if slices.Sort(moved); !slices.Equal(moved, []int64{4, 5}) {
		t.Fatalf("moved = %v, want both holders", moved)
	}
	if got := heldIDs(t, database, 5); !slices.Equal(got, []int64{4}) {
		t.Errorf("user 5 holds %v, want just the member role they already had", got)
	}
	if got := heldIDs(t, database, 4); !slices.Equal(got, []int64{4}) {
		t.Errorf("user 4 holds %v, want the default role they were left with none", got)
	}
	if got := roleIDOf(t, database, 5); got != 4 {
		t.Errorf("user 5 users.role_id = %d, want 4", got)
	}
}

func TestReorder_ResyncsTopRole(t *testing.T) {
	modSvc, database := newMemberRolesFixture(t)
	ctx := context.Background()
	roles := NewRoleService(database, modSvc.perms)
	rec := &permNotifyRecorder{probe: roleProbe(t, modSvc.perms, 5)}
	roles.SetPermissionNotifier(rec)

	// User 5 holds helper (50) above member (40): helper is the top role.
	if _, err := modSvc.AddUserRole(ctx, 3, 5, memberRolesHelperID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	if got := roleProbe(t, modSvc.perms, 5)(); got.([3]any)[0] != "helper" {
		t.Fatalf("warm probe = %v, want helper on top", got)
	}

	// Flip them: member above helper. Admin and mod keep their places.
	if _, err := roles.ReorderRoles(ctx, 1, []int64{2, 3, 4, memberRolesHelperID}); err != nil {
		t.Fatalf("ReorderRoles: %v", err)
	}
	if got := roleIDOf(t, database, 5); got != 4 {
		t.Errorf("users.role_id = %d, want 4: the mirror follows the new top role", got)
	}
	if got := heldIDs(t, database, 5); !slices.Equal(got, []int64{4, memberRolesHelperID}) {
		t.Errorf("held order = %v, want [member helper]", got)
	}
	held, err := modSvc.perms.GetRoleForUser(ctx, 5)
	if err != nil || held == nil || held.Top.ID != 4 {
		t.Errorf("cached top role = %+v, %v, want the member role (cache must be dropped)", held, err)
	}
	last := rec.events[len(rec.events)-1]
	if last.kind != "roles" || !slices.Equal(last.fan.MemberUpdate, []int64{5}) || !last.fan.Roles {
		t.Errorf("reorder fan-out = %+v, want roles_update and a member_update for user 5 only", last.fan)
	}
}

func TestUpdateRole_PositionMoveResyncsTopRole(t *testing.T) {
	modSvc, database := newMemberRolesFixture(t)
	ctx := context.Background()
	roles := NewRoleService(database, modSvc.perms)
	rec := &permNotifyRecorder{}
	roles.SetPermissionNotifier(rec)
	if _, err := modSvc.AddUserRole(ctx, 3, 5, memberRolesHelperID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}

	// Drop helper below member: 45 is free, 39 is below member (40).
	if _, res, err := roles.UpdateRole(ctx, 1, memberRolesHelperID, RoleInput{Position: new(39)}); err != nil {
		t.Fatalf("UpdateRole: %v", err)
	} else if !slices.Equal(res.ResyncedMembers, []int64{5}) {
		t.Errorf("ResyncedMembers = %v, want [5]", res.ResyncedMembers)
	}
	if got := roleIDOf(t, database, 5); got != 4 {
		t.Errorf("users.role_id = %d, want 4 after the position move", got)
	}
	last := rec.events[len(rec.events)-1]
	if !slices.Equal(last.fan.MemberUpdate, []int64{5}) {
		t.Errorf("fan-out = %+v, want a member_update for user 5", last.fan)
	}
}

func TestRoleInput_HoistAndMentionable(t *testing.T) {
	svc, _ := newRoleCRUDService(t)
	ctx := context.Background()
	role, err := svc.CreateRole(ctx, 1, RoleInput{Name: new("Pingable"), Hoist: new(true), Mentionable: new(true)})
	if err != nil || !role.Hoist || !role.Mentionable {
		t.Fatalf("CreateRole = %+v, %v, want hoist and mentionable set", role, err)
	}
	plain, err := svc.CreateRole(ctx, 1, RoleInput{Name: new("Plain")})
	if err != nil || plain.Hoist || plain.Mentionable {
		t.Fatalf("CreateRole default = %+v, %v, want both false", plain, err)
	}
	// An omitted flag is left alone; a present one changes just that flag.
	updated, _, err := svc.UpdateRole(ctx, 1, role.ID, RoleInput{Hoist: new(false)})
	if err != nil || updated.Hoist || !updated.Mentionable {
		t.Fatalf("UpdateRole = %+v, %v, want hoist cleared and mentionable kept", updated, err)
	}
	all, err := svc.AllRoles(ctx)
	if err != nil {
		t.Fatalf("AllRoles: %v", err)
	}
	for _, r := range all {
		if r.ID == role.ID && (r.Hoist || !r.Mentionable) {
			t.Errorf("stored role = %+v, want hoist false mentionable true", r)
		}
	}
}
