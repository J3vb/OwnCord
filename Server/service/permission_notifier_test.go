package service

import (
	"context"
	"reflect"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// WP 5.1a acceptance (ARCH-018): the services, not the admin handlers, own
// permission-cache invalidation and the live fan-out. Every test here calls a
// service method with NO handler in sight.

// permNotifyEvent is one recorded PermissionChangeNotifier call. probe is whatever
// the test's probe func observed AT THE MOMENT of the call, which is how the
// invalidate-before-notify order is proven: a notifier that runs before the
// cache is dropped would observe the stale answer.
type permNotifyEvent struct {
	kind   string // "roles", "audience" or "revoke"
	fan    RoleFanout
	chanID int64
	userID int64
	probe  any
}

type permNotifyRecorder struct {
	probe  func() any
	events []permNotifyEvent
}

func (r *permNotifyRecorder) observe() any {
	if r.probe == nil {
		return nil
	}
	return r.probe()
}

func (r *permNotifyRecorder) RoleChanged(f RoleFanout) {
	r.events = append(r.events, permNotifyEvent{kind: "roles", fan: f, probe: r.observe()})
}

func (r *permNotifyRecorder) ChannelAudienceChanged(ch *db.Channel) {
	r.events = append(r.events, permNotifyEvent{kind: "audience", chanID: ch.ID, probe: r.observe()})
}

func (r *permNotifyRecorder) RevokeUnreadable(userID int64) {
	r.events = append(r.events, permNotifyEvent{kind: "revoke", userID: userID, probe: r.observe()})
}

func (r *permNotifyRecorder) kinds() []string {
	out := make([]string, 0, len(r.events))
	for _, e := range r.events {
		out = append(out, e.kind)
	}
	return out
}

// roleProbe reports the role the PermissionService serves for userID right
// now, as "name:permissions:position".
func roleProbe(t *testing.T, perms *PermissionService, userID int64) func() any {
	t.Helper()
	return func() any {
		role, err := perms.GetRoleForUser(context.Background(), userID)
		if err != nil || role == nil {
			t.Errorf("GetRoleForUser(%d): %v", userID, err)
			return nil
		}
		return [3]any{role.Name, role.Permissions, role.Position}
	}
}

func TestUpdateRole_ServiceInvalidatesThenNotifies(t *testing.T) {
	svc, database := newRoleCRUDService(t)
	ctx := context.Background()
	created, err := svc.CreateRole(ctx, 1, RoleInput{Name: new("Bots"), Permissions: new(permissions.ReadMessages)})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	seedUserRole(t, database, 4, created.ID)
	seedUserRole(t, database, 5, created.ID)
	rec := &permNotifyRecorder{probe: roleProbe(t, svc.perms, 4)}
	svc.SetPermissionNotifier(rec)

	// Warm the cache with the pre-change role.
	if got := roleProbe(t, svc.perms, 4)(); got != [3]any{"Bots", permissions.ReadMessages, created.Position} {
		t.Fatalf("warm probe = %v", got)
	}

	_, res, err := svc.UpdateRole(ctx, 1, created.ID, RoleInput{
		Name:        new("Robots"),
		Permissions: new(permissions.ReadMessages | permissions.SendMessages),
	})
	if err != nil || !res.PermsChanged || !res.Renamed {
		t.Fatalf("UpdateRole = %+v, %v", res, err)
	}

	if !reflect.DeepEqual(rec.kinds(), []string{"roles"}) {
		t.Fatalf("notifier calls = %v, want one RoleChanged", rec.kinds())
	}
	ev := rec.events[0]
	want := [3]any{"Robots", permissions.ReadMessages | permissions.SendMessages, created.Position}
	if ev.probe != want {
		t.Errorf("cache at notify time = %v, want the post-change role %v (invalidate must precede notify)", ev.probe, want)
	}
	slices.Sort(ev.fan.Visibility)
	slices.Sort(ev.fan.MemberUpdate)
	wantFan := RoleFanout{Roles: true, Visibility: []int64{4, 5}, MemberUpdate: []int64{4, 5}}
	if !reflect.DeepEqual(ev.fan, wantFan) {
		t.Errorf("fan-out = %+v, want %+v", ev.fan, wantFan)
	}
}

func TestUpdateRole_ColorOnlyEditSkipsVisibilityAndMemberUpdate(t *testing.T) {
	svc, database := newRoleCRUDService(t)
	ctx := context.Background()
	created, err := svc.CreateRole(ctx, 1, RoleInput{Name: new("Bots")})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	seedUserRole(t, database, 4, created.ID)
	rec := &permNotifyRecorder{}
	svc.SetPermissionNotifier(rec)

	if _, _, err := svc.UpdateRole(ctx, 1, created.ID, RoleInput{Color: new("#ff0000")}); err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	if len(rec.events) != 1 || !reflect.DeepEqual(rec.events[0].fan, RoleFanout{Roles: true}) {
		t.Fatalf("events = %+v, want exactly {Roles}", rec.events)
	}
}

// failingMemberList makes the role-member lookup fail, the "unreadable member
// list" edge: per-user targeting cannot be trusted, so the service must flush
// every cached mask and address every connected user.
type failingMemberList struct{ Store }

func (failingMemberList) ListUserIDsByRole(context.Context, int64) ([]int64, error) {
	return nil, context.DeadlineExceeded
}

func TestUpdateRole_UnreadableMemberListFlushesAllAndFansOutToEveryone(t *testing.T) {
	base, database := newRoleCRUDService(t)
	ctx := context.Background()
	created, err := base.CreateRole(ctx, 1, RoleInput{Name: new("Bots")})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	seedUserRole(t, database, 4, created.ID)
	svc := NewRoleService(failingMemberList{database}, base.perms)
	rec := &permNotifyRecorder{}
	svc.SetPermissionNotifier(rec)

	// Warm an UNRELATED user's cache, then change that user's role behind the
	// cache's back: only a full flush can make the change visible.
	if r, _ := svc.perms.GetRoleForUser(ctx, 5); r == nil || r.ID != permissions.MemberRoleID {
		t.Fatalf("warm role = %+v", r)
	}
	if err := database.UpdateUserRole(ctx, 5, permissions.ModeratorRoleID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}

	if _, _, err := svc.UpdateRole(ctx, 1, created.ID, RoleInput{
		Name: new("Robots"), Permissions: new(permissions.ReadMessages),
	}); err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	if r, _ := svc.perms.GetRoleForUser(ctx, 5); r == nil || r.ID != permissions.ModeratorRoleID {
		t.Errorf("unrelated user's cache survived an unreadable-member-list edit: %+v", r)
	}
	want := RoleFanout{Roles: true, AllConnected: true}
	if len(rec.events) != 1 || !reflect.DeepEqual(rec.events[0].fan, want) {
		t.Fatalf("events = %+v, want one %+v", rec.events, want)
	}
}

func TestUpdateRole_FailedUpdateNotifiesNobody(t *testing.T) {
	svc, _ := newRoleCRUDService(t)
	rec := &permNotifyRecorder{}
	svc.SetPermissionNotifier(rec)
	if _, _, err := svc.UpdateRole(context.Background(), 1, 9999, RoleInput{Name: new("x")}); err == nil {
		t.Fatal("UpdateRole of a missing role succeeded")
	}
	if len(rec.events) != 0 {
		t.Fatalf("events = %+v, want none after a refused edit", rec.events)
	}
}

func TestCreateRole_NotifiesRolesOnly(t *testing.T) {
	svc, _ := newRoleCRUDService(t)
	rec := &permNotifyRecorder{}
	svc.SetPermissionNotifier(rec)
	if _, err := svc.CreateRole(context.Background(), 1, RoleInput{Name: new("Bots")}); err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if len(rec.events) != 1 || !reflect.DeepEqual(rec.events[0].fan, RoleFanout{Roles: true}) {
		t.Fatalf("events = %+v, want exactly {Roles}", rec.events)
	}
}

func TestReorderRoles_FlushesCacheThenNotifies(t *testing.T) {
	svc, _ := newRoleCRUDService(t)
	ctx := context.Background()
	rec := &permNotifyRecorder{probe: roleProbe(t, svc.perms, 3)}
	svc.SetPermissionNotifier(rec)
	before := roleProbe(t, svc.perms, 3)() // warm: Moderator at 60

	// Reorder the roles below the Owner: Admin, Moderator, Member -> reversed.
	updated, err := svc.ReorderRoles(ctx, 1, []int64{permissions.MemberRoleID, permissions.ModeratorRoleID, permissions.AdminRoleID})
	if err != nil {
		t.Fatalf("ReorderRoles: %v", err)
	}
	if len(updated) == 0 || len(rec.events) != 1 || !reflect.DeepEqual(rec.events[0].fan, RoleFanout{Roles: true}) {
		t.Fatalf("events = %+v", rec.events)
	}
	if rec.events[0].probe == before {
		t.Errorf("cached role still %v at notify time: reorder must flush before notifying", before)
	}
	if after := roleProbe(t, svc.perms, 3)(); after != rec.events[0].probe {
		t.Errorf("probe changed between notify (%v) and return (%v)", rec.events[0].probe, after)
	}
}

func TestDeleteRole_RevokesInlineThenNotifies(t *testing.T) {
	svc, database := newRoleCRUDService(t)
	ctx := context.Background()
	role, err := svc.CreateRole(ctx, 1, RoleInput{Name: new("Contractor"), Position: new(30)})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	seedUserRole(t, database, 4, role.ID)
	seedUserRole(t, database, 5, role.ID)
	rec := &permNotifyRecorder{probe: roleProbe(t, svc.perms, 4)}
	svc.SetPermissionNotifier(rec)
	roleProbe(t, svc.perms, 4)() // warm with the doomed role

	_, _, moved, err := svc.DeleteRole(ctx, 1, role.ID)
	if err != nil || len(moved) != 2 {
		t.Fatalf("DeleteRole moved=%v err=%v", moved, err)
	}
	if got, want := rec.kinds(), []string{"revoke", "revoke", "roles"}; !slices.Equal(got, want) {
		t.Fatalf("notifier order = %v, want %v", got, want)
	}
	for _, e := range rec.events {
		if e.probe == nil || e.probe.([3]any)[0] == "Contractor" {
			t.Errorf("%s ran against the deleted role's cached mask %v", e.kind, e.probe)
		}
	}
	last := rec.events[2].fan
	if !last.Roles || !slices.Equal(last.Visibility, moved) || !slices.Equal(last.MemberUpdate, moved) {
		t.Errorf("fan-out = %+v, moved = %v", last, moved)
	}
}

func TestDeleteRole_InlineRevokeIsCappedAndWorkerGetsEveryone(t *testing.T) {
	svc, database := newRoleCRUDService(t)
	ctx := context.Background()
	role, err := svc.CreateRole(ctx, 1, RoleInput{Name: new("Crowd"), Position: new(30)})
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	total := roleRevokeInline + 5
	for i := range total {
		id := int64(100 + i)
		seedUser(t, database, &db.User{ID: id})
		seedUserRole(t, database, id, role.ID)
	}
	rec := &permNotifyRecorder{}
	svc.SetPermissionNotifier(rec)

	_, _, moved, err := svc.DeleteRole(ctx, 1, role.ID)
	if err != nil || len(moved) != total {
		t.Fatalf("DeleteRole moved=%d err=%v", len(moved), err)
	}
	revokes := 0
	for _, e := range rec.events {
		if e.kind == "revoke" {
			revokes++
		}
	}
	if revokes != roleRevokeInline {
		t.Errorf("inline revokes = %d, want the %d cap", revokes, roleRevokeInline)
	}
	if last := rec.events[len(rec.events)-1]; last.kind != "roles" || len(last.fan.Visibility) != total {
		t.Errorf("final event = %+v, want one RoleChanged naming all %d members", last, total)
	}
}

func TestChangeUserRole_InvalidatesRevokesThenNotifies(t *testing.T) {
	svc, _ := newTestRoleService(t)
	ctx := context.Background()
	rec := &permNotifyRecorder{probe: roleProbe(t, svc.perms, 5)}
	svc.SetPermissionNotifier(rec)
	roleProbe(t, svc.perms, 5)() // warm: member

	if _, err := svc.ChangeUserRole(ctx, 1, 5, 3); err != nil {
		t.Fatalf("ChangeUserRole: %v", err)
	}
	if got, want := rec.kinds(), []string{"revoke", "roles"}; !slices.Equal(got, want) {
		t.Fatalf("notifier order = %v, want %v", got, want)
	}
	for _, e := range rec.events {
		if p, _ := e.probe.([3]any); p[0] != "mod" {
			t.Errorf("%s saw cached role %v, want the new role (invalidate before notify)", e.kind, e.probe)
		}
	}
	if rec.events[0].userID != 5 {
		t.Errorf("revoked user = %d, want 5", rec.events[0].userID)
	}
	want := RoleFanout{Visibility: []int64{5}, MemberUpdate: []int64{5}}
	if !reflect.DeepEqual(rec.events[1].fan, want) {
		t.Errorf("fan-out = %+v, want %+v", rec.events[1].fan, want)
	}
}

func TestChangeUserRole_RefusedNotifiesNobody(t *testing.T) {
	svc, _ := newTestRoleService(t)
	rec := &permNotifyRecorder{}
	svc.SetPermissionNotifier(rec)
	if _, err := svc.ChangeUserRole(context.Background(), 4, 5, 3); err == nil {
		t.Fatal("member role change succeeded")
	}
	if len(rec.events) != 0 {
		t.Fatalf("events = %+v, want none", rec.events)
	}
}

// ─── Channel overrides ───────────────────────────────────────────────────────

func channelPermProbe(perms *PermissionService, userID, channelID int64) func() any {
	return func() any {
		return perms.HasChannelPerm(context.Background(), userID, channelID, permissions.ReadMessages)
	}
}

func TestPutRoleOverride_ServiceAloneRevokesAccessAndNotifiesAfter(t *testing.T) {
	svc, database, mod, low, ch := seedOverrideFixture(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 31})
	seedUserRole(t, database, 31, low.ID)
	rec := &permNotifyRecorder{probe: channelPermProbe(svc.perms, 31, ch.ID)}
	svc.SetPermissionNotifier(rec)

	if !svc.perms.HasChannelPerm(ctx, 31, ch.ID, permissions.ReadMessages) { // warms the cache
		t.Fatal("precondition: the role should read the channel")
	}
	if _, err := svc.PutRoleOverride(ctx, 7, mod, ch, low.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("PutRoleOverride: %v", err)
	}
	if svc.perms.HasChannelPerm(ctx, 31, ch.ID, permissions.ReadMessages) {
		t.Error("the cached mask still grants READ_MESSAGES after the deny: the service must invalidate")
	}
	if len(rec.events) != 1 || rec.events[0].kind != "audience" || rec.events[0].chanID != ch.ID {
		t.Fatalf("events = %+v, want one ChannelAudienceChanged(%d)", rec.events, ch.ID)
	}
	if rec.events[0].probe != false {
		t.Error("the audience refresh ran before the cache was invalidated")
	}

	// And clearing it restores access, again with no handler.
	if _, err := svc.DeleteRoleOverride(ctx, 7, mod, ch, low.ID); err != nil {
		t.Fatalf("DeleteRoleOverride: %v", err)
	}
	if !svc.perms.HasChannelPerm(ctx, 31, ch.ID, permissions.ReadMessages) {
		t.Error("the cleared deny still hides the channel")
	}
	if len(rec.events) != 2 || rec.events[1].probe != true {
		t.Fatalf("events = %+v, want a second audience refresh seeing the restored grant", rec.events)
	}
}

func TestUserOverride_ServiceAloneInvalidatesTargetAndNotifies(t *testing.T) {
	svc, database, mod, low, ch := seedOverrideFixture(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 32})
	seedUserRole(t, database, 32, low.ID)
	rec := &permNotifyRecorder{probe: channelPermProbe(svc.perms, 32, ch.ID)}
	svc.SetPermissionNotifier(rec)
	channelPermProbe(svc.perms, 32, ch.ID)() // warm

	if _, err := svc.PutUserOverride(ctx, 7, mod, ch, 32, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("PutUserOverride: %v", err)
	}
	if len(rec.events) != 1 || rec.events[0].kind != "audience" || rec.events[0].probe != false {
		t.Fatalf("events = %+v, want one audience refresh that already sees the deny", rec.events)
	}
	if _, err := svc.DeleteUserOverride(ctx, 7, mod, ch, 32); err != nil {
		t.Fatalf("DeleteUserOverride: %v", err)
	}
	if len(rec.events) != 2 || rec.events[1].probe != true {
		t.Fatalf("events = %+v", rec.events)
	}
}

func TestRoleOverride_UnreadableMemberListFlushesEveryCachedMask(t *testing.T) {
	base, database, mod, low, ch := seedOverrideFixture(t)
	ctx := context.Background()
	svc := NewChannelService(failingMemberList{database}, base.perms)
	rec := &permNotifyRecorder{}
	svc.SetPermissionNotifier(rec)
	// An unrelated user, cached, then changed behind the cache's back.
	seedUser(t, database, &db.User{ID: 33})
	seedUserRole(t, database, 33, permissions.MemberRoleID)
	if r, _ := svc.perms.GetRoleForUser(ctx, 33); r == nil || r.ID != permissions.MemberRoleID {
		t.Fatalf("warm role = %+v", r)
	}
	if err := database.UpdateUserRole(ctx, 33, permissions.ModeratorRoleID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}

	res, err := svc.PutRoleOverride(ctx, 7, mod, ch, low.ID, 0, permissions.ReadMessages)
	if err != nil || !res.AffectedAll {
		t.Fatalf("PutRoleOverride = %+v, %v; want AffectedAll", res, err)
	}
	if r, _ := svc.perms.GetRoleForUser(ctx, 33); r == nil || r.ID != permissions.ModeratorRoleID {
		t.Errorf("cache survived an unreadable-member-list override: %+v", r)
	}
	if len(rec.events) != 1 || rec.events[0].kind != "audience" {
		t.Fatalf("events = %+v, want the audience refresh still to run", rec.events)
	}
}

func TestRefusedOverrideNeitherInvalidatesNorNotifies(t *testing.T) {
	svc, _, mod, low, ch := seedOverrideFixture(t)
	rec := &permNotifyRecorder{}
	svc.SetPermissionNotifier(rec)
	// Granting a bit the actor lacks is refused.
	if _, err := svc.PutRoleOverride(context.Background(), 7, mod, ch, low.ID, permissions.ManageServer, 0); err == nil {
		t.Fatal("escalating override accepted")
	}
	if len(rec.events) != 0 {
		t.Fatalf("events = %+v, want none", rec.events)
	}
}
