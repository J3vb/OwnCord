package service

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Category permission templates (WP 6.5d): the guards, the single-transaction
// write across synced channels, and the sync lifecycle.

type catPermFixture struct {
	svc      *ChannelService
	database *db.DB
	mod      *db.Role // MANAGE_CHANNELS, no MANAGE_SERVER: the guarded actor
	admin    *db.Role // ADMINISTRATOR, above everyone
	low      *db.Role // the role the overrides target
	cat      *db.ChannelCategory
	a, b     *db.Channel // both created in cat, so both synced
}

func newCatPermFixture(t *testing.T) *catPermFixture {
	t.Helper()
	svc, database := newChannelAdminService(t)
	ctx := context.Background()
	f := &catPermFixture{svc: svc, database: database}
	f.mod = &db.Role{ID: 21, Name: "cat-mod", Position: 50, Permissions: permissions.ManageChannels | permissions.ReadMessages | permissions.SendMessages}
	f.admin = &db.Role{ID: 20, Name: "cat-admin", Position: 90, Permissions: permissions.Administrator}
	f.low = &db.Role{ID: 22, Name: "cat-low", Position: 10, Permissions: permissions.ReadMessages | permissions.SendMessages}
	seedRole(t, database, f.mod)
	seedRole(t, database, f.admin)
	seedRole(t, database, f.low)
	change, err := svc.CreateCategory(ctx, 1, "Games")
	if err != nil {
		t.Fatalf("CreateCategory: %v", err)
	}
	f.cat = change.Category
	f.a = f.newChannel(t, "alpha", f.cat.ID)
	f.b = f.newChannel(t, "beta", f.cat.ID)
	return f
}

func (f *catPermFixture) newChannel(t *testing.T, name string, categoryID int64) *db.Channel {
	t.Helper()
	ch, _, err := f.svc.AdminCreateChannel(context.Background(), 1, AdminChannelCreate{Name: name, CategoryID: categoryID}, nil)
	if err != nil {
		t.Fatalf("AdminCreateChannel(%s): %v", name, err)
	}
	return ch
}

func (f *catPermFixture) synced(t *testing.T, ch *db.Channel) bool {
	t.Helper()
	ok, err := f.svc.ChannelPermissionsSynced(context.Background(), ch.ID)
	if err != nil {
		t.Fatalf("ChannelPermissionsSynced: %v", err)
	}
	return ok
}

func (f *catPermFixture) channelRow(t *testing.T, ch *db.Channel, roleID int64) (int64, int64) {
	t.Helper()
	allow, deny, err := f.database.GetChannelPermissions(context.Background(), ch.ID, roleID)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	return allow, deny
}

func (f *catPermFixture) categoryRow(t *testing.T, roleID int64) (int64, int64) {
	t.Helper()
	roles, _, err := f.svc.CategoryPermissions(context.Background(), f.cat.ID)
	if err != nil {
		t.Fatalf("CategoryPermissions: %v", err)
	}
	for _, r := range roles {
		if r.RoleID == roleID {
			return r.Allow, r.Deny
		}
	}
	t.Fatalf("role %d missing from the category listing", roleID)
	return 0, 0
}

func (f *catPermFixture) auditHas(t *testing.T, action string) bool {
	t.Helper()
	entries, err := f.database.GetAuditLog(context.Background(), 50, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	return slices.ContainsFunc(entries, func(e db.AuditEntry) bool { return e.Action == action })
}

func TestCategoryOverride_WritesTemplateAndEverySyncedChannel(t *testing.T) {
	f := newCatPermFixture(t)
	res, err := f.svc.PutCategoryRoleOverride(context.Background(), 7, f.mod, f.cat.ID, f.low.ID, permissions.ReadMessages, permissions.SendMessages)
	if err != nil {
		t.Fatalf("PutCategoryRoleOverride: %v", err)
	}
	if len(res.Channels) != 2 {
		t.Fatalf("touched channels = %d, want both synced channels", len(res.Channels))
	}
	for _, ch := range []*db.Channel{f.a, f.b} {
		if allow, deny := f.channelRow(t, ch, f.low.ID); allow != permissions.ReadMessages || deny != permissions.SendMessages {
			t.Errorf("channel %s row = (%#x,%#x), want the template's", ch.Name, allow, deny)
		}
	}
	if allow, deny := f.categoryRow(t, f.low.ID); allow != permissions.ReadMessages || deny != permissions.SendMessages {
		t.Errorf("category row = (%#x,%#x)", allow, deny)
	}
	if !f.auditHas(t, "category_perms_update") {
		t.Error("no category_perms_update audit row")
	}
	for _, ch := range []*db.Channel{f.a, f.b} {
		if !f.synced(t, ch) {
			t.Errorf("channel %s lost its synced flag", ch.Name)
		}
	}
}

func TestCategoryOverride_LeavesUnsyncedChannelsAlone(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	// A direct edit unsyncs b and gives it its own row.
	if _, err := f.svc.PutRoleOverride(ctx, 7, f.mod, f.b, f.low.ID, permissions.SendMessages, 0); err != nil {
		t.Fatalf("PutRoleOverride: %v", err)
	}
	res, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, f.low.ID, permissions.ReadMessages, 0)
	if err != nil {
		t.Fatalf("PutCategoryRoleOverride: %v", err)
	}
	if len(res.Channels) != 1 || res.Channels[0].ID != f.a.ID {
		t.Fatalf("touched = %+v, want only the synced channel", res.Channels)
	}
	if allow, _ := f.channelRow(t, f.b, f.low.ID); allow != permissions.SendMessages {
		t.Errorf("unsynced channel row = %#x, want its own %#x", allow, permissions.SendMessages)
	}
}

// Edge case 1: the bits are fine on the category row, but the write would
// clear a deny the actor's role lacks on a synced channel. Refused as a whole.
func TestCategoryOverride_RefusedWhenASyncedChannelCarriesABitTheActorLacks(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	// Channel a (synced) carries a MANAGE_SERVER deny that the category row
	// does not. The actor writing a harmless allow would overwrite it.
	if _, err := f.database.ExecContext(ctx,
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, 0, ?)`,
		f.a.ID, f.low.ID, permissions.ManageServer); err != nil {
		t.Fatal(err)
	}
	_, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, f.low.ID, permissions.ReadMessages, 0)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
	if allow, deny := f.channelRow(t, f.a, f.low.ID); allow != 0 || deny != permissions.ManageServer {
		t.Errorf("channel a row = (%#x,%#x), want it untouched", allow, deny)
	}
	if allow, deny := f.channelRow(t, f.b, f.low.ID); allow != 0 || deny != 0 {
		t.Errorf("channel b row = (%#x,%#x), want nothing written", allow, deny)
	}
	if allow, deny := f.categoryRow(t, f.low.ID); allow != 0 || deny != 0 {
		t.Errorf("category row = (%#x,%#x), want nothing written", allow, deny)
	}
	if f.auditHas(t, "category_perms_update") {
		t.Error("a refused write left an audit row")
	}
	// An administrator is not subject to the escalation guard.
	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.admin, f.cat.ID, f.low.ID, permissions.ReadMessages, 0); err != nil {
		t.Fatalf("administrator write: %v", err)
	}
}

func TestCategoryOverride_EscalationOverTheCategoryRowItself(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.admin, f.cat.ID, f.low.ID, 0, permissions.ManageServer); err != nil {
		t.Fatal(err)
	}
	// An all-zero write over a deny the actor lacks is a grant; so is a clear.
	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, f.low.ID, 0, 0); !errors.Is(err, ErrForbidden) {
		t.Errorf("zero write: err = %v, want ErrForbidden", err)
	}
	if _, err := f.svc.DeleteCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, f.low.ID); !errors.Is(err, ErrForbidden) {
		t.Errorf("delete: err = %v, want ErrForbidden", err)
	}
	if _, deny := f.categoryRow(t, f.low.ID); deny != permissions.ManageServer {
		t.Errorf("category deny = %#x, want it kept", deny)
	}
	if _, deny := f.channelRow(t, f.a, f.low.ID); deny != permissions.ManageServer {
		t.Errorf("channel deny = %#x, want it kept", deny)
	}
	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, f.low.ID, permissions.ManageServer, 0); !errors.Is(err, ErrForbidden) {
		t.Errorf("escalating write: err = %v, want ErrForbidden", err)
	}
}

func TestCategoryOverride_ClearRemovesTemplateAndSyncedRows(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, f.low.ID, permissions.ReadMessages, 0); err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.DeleteCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, f.low.ID)
	if err != nil {
		t.Fatalf("DeleteCategoryRoleOverride: %v", err)
	}
	if len(res.Channels) != 2 {
		t.Errorf("touched = %d, want 2", len(res.Channels))
	}
	for _, ch := range []*db.Channel{f.a, f.b} {
		if allow, deny := f.channelRow(t, ch, f.low.ID); allow != 0 || deny != 0 {
			t.Errorf("channel %s still has (%#x,%#x)", ch.Name, allow, deny)
		}
	}
	if !f.auditHas(t, "category_perms_clear") {
		t.Error("no category_perms_clear audit row")
	}
}

func TestCategoryOverride_HierarchyGuards(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	peer := &db.Role{ID: 23, Name: "cat-peer", Position: f.mod.Position, Permissions: permissions.ReadMessages}
	seedRole(t, f.database, peer)
	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, peer.ID, permissions.ReadMessages, 0); !errors.Is(err, ErrForbidden) {
		t.Errorf("peer role: err = %v, want ErrForbidden", err)
	}
	if _, err := f.svc.DeleteCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, peer.ID); !errors.Is(err, ErrForbidden) {
		t.Errorf("peer role delete: err = %v, want ErrForbidden", err)
	}
	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, 9999, 0, 0); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown role: err = %v, want ErrNotFound", err)
	}
	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.mod, 9999, f.low.ID, 0, 0); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown category: err = %v, want ErrNotFound", err)
	}

	seedUser(t, f.database, &db.User{ID: 31, Username: "low-user"})
	seedUserRole(t, f.database, 31, f.low.ID)
	seedUser(t, f.database, &db.User{ID: 32, Username: "high-user"})
	seedUserRole(t, f.database, 32, f.admin.ID)
	if _, err := f.svc.PutCategoryUserOverride(ctx, 7, f.mod, f.cat.ID, 32, 0, permissions.ReadMessages); !errors.Is(err, ErrForbidden) {
		t.Errorf("higher user: err = %v, want ErrForbidden", err)
	}
	if _, err := f.svc.DeleteCategoryUserOverride(ctx, 7, f.mod, f.cat.ID, 32); !errors.Is(err, ErrForbidden) {
		t.Errorf("higher user delete: err = %v, want ErrForbidden", err)
	}
	if _, err := f.svc.PutCategoryUserOverride(ctx, 7, f.mod, f.cat.ID, 9999, 0, 0); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown user: err = %v, want ErrNotFound", err)
	}
	res, err := f.svc.PutCategoryUserOverride(ctx, 7, f.mod, f.cat.ID, 31, permissions.ReadMessages, 0)
	if err != nil {
		t.Fatalf("lower user: %v", err)
	}
	if !slices.Equal(res.AffectedUsers, []int64{31}) {
		t.Errorf("affected = %v, want just the target", res.AffectedUsers)
	}
	allow, _, err := f.database.GetUserChannelPermissions(ctx, f.a.ID, 31)
	if err != nil || allow != permissions.ReadMessages {
		t.Errorf("synced channel user row = %#x, %v", allow, err)
	}
	if !f.auditHas(t, "category_user_perms_update") {
		t.Error("no category_user_perms_update audit row")
	}
	if _, err := f.svc.DeleteCategoryUserOverride(ctx, 7, f.mod, f.cat.ID, 31); err != nil {
		t.Fatalf("user clear: %v", err)
	}
	if allow, _, _ := f.database.GetUserChannelPermissions(ctx, f.a.ID, 31); allow != 0 {
		t.Errorf("user row not cleared: %#x", allow)
	}
}

// Invalidation is the union of affected users, and a write reports every
// touched channel so each one gets its visibility refreshed.
func TestCategoryOverride_InvalidationCoversRoleHolders(t *testing.T) {
	f := newCatPermFixture(t)
	for _, id := range []int64{41, 42} {
		seedUser(t, f.database, &db.User{ID: id})
		seedUserRole(t, f.database, id, f.low.ID)
	}
	other := f.newChannel(t, "gamma", f.cat.ID)
	res, err := f.svc.PutCategoryRoleOverride(context.Background(), 7, f.mod, f.cat.ID, f.low.ID, 0, permissions.ReadMessages)
	if err != nil {
		t.Fatal(err)
	}
	if res.AffectedAll || !slices.Equal(dedupe(res.AffectedUsers), []int64{41, 42}) {
		t.Errorf("affected = %v all=%v, want the role's holders", res.AffectedUsers, res.AffectedAll)
	}
	ids := make([]int64, 0, len(res.Channels))
	for _, c := range res.Channels {
		ids = append(ids, c.ID)
	}
	slices.Sort(ids)
	if !slices.Equal(ids, []int64{f.a.ID, f.b.ID, other.ID}) {
		t.Errorf("channels = %v, want every touched channel", ids)
	}
}

// failingHolders makes the narrow invalidation list unreadable.
type failingHolders struct{ *db.DB }

func (failingHolders) ListUserIDsByRole(context.Context, int64) ([]int64, error) {
	return nil, errors.New("boom")
}

func TestCategoryOverride_InvalidationFailsSafeToFullFlush(t *testing.T) {
	f := newCatPermFixture(t)
	svc := NewChannelService(failingHolders{f.database}, NewPermissionService(f.database, nil))
	res, err := svc.PutCategoryRoleOverride(context.Background(), 7, f.mod, f.cat.ID, f.low.ID, permissions.ReadMessages, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !res.AffectedAll {
		t.Error("an unreadable holder list must widen to a full flush")
	}
}

func TestCategoryOverride_StoreWithoutCategoriesAnswersInternal(t *testing.T) {
	svc := &ChannelService{}
	if _, err := svc.PutCategoryRoleOverride(context.Background(), 1, &db.Role{}, 1, 1, 0, 0); !errors.Is(err, ErrInternal) {
		t.Errorf("err = %v, want ErrInternal", err)
	}
	if _, _, err := svc.CategoryPermissions(context.Background(), 1); !errors.Is(err, ErrInternal) {
		t.Errorf("list: err = %v, want ErrInternal", err)
	}
	if _, err := svc.SyncChannelPermissions(context.Background(), 1, &db.Role{}, &db.Channel{ID: 1, CategoryID: 1}); !errors.Is(err, ErrInternal) {
		t.Errorf("sync: err = %v, want ErrInternal", err)
	}
	if _, err := svc.ChannelPermissionsSynced(context.Background(), 1); !errors.Is(err, ErrInternal) {
		t.Errorf("synced: err = %v, want ErrInternal", err)
	}
}

func TestCategoryPermissions_ListsEveryRoleAndOnlyOverriddenUsers(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	seedUser(t, f.database, &db.User{ID: 31, Username: "has-row"})
	seedUserRole(t, f.database, 31, f.low.ID)
	seedUser(t, f.database, &db.User{ID: 33, Username: "no-row"})
	seedUserRole(t, f.database, 33, f.low.ID)
	if _, err := f.svc.PutCategoryUserOverride(ctx, 7, f.mod, f.cat.ID, 31, permissions.ReadMessages, 0); err != nil {
		t.Fatal(err)
	}
	roles, users, err := f.svc.CategoryPermissions(ctx, f.cat.ID)
	if err != nil {
		t.Fatal(err)
	}
	var all int
	if err := f.database.QueryRowContext(ctx, `SELECT COUNT(*) FROM roles`).Scan(&all); err != nil {
		t.Fatal(err)
	}
	if len(roles) != all {
		t.Errorf("roles = %d, want every role (%d)", len(roles), all)
	}
	if len(users) != 1 || users[0].UserID != 31 {
		t.Errorf("users = %+v, want only the one with a row", users)
	}
	if _, _, err := f.svc.CategoryPermissions(ctx, 9999); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown category: err = %v, want ErrNotFound", err)
	}
	if _, _, err := f.svc.CategoryPermissions(ctx, 0); !errors.Is(err, ErrBadRequest) {
		t.Errorf("zero id: err = %v, want ErrBadRequest", err)
	}
}

// WP 5.1a pattern for WP 6.5d: the service, not the admin handler, drops the
// cache and refreshes every touched channel's audience, after the commit.
func TestCategoryOverride_ServiceNotifiesOncePerTouchedChannelAfterCommit(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	seedUser(t, f.database, &db.User{ID: 31, Username: "member"})
	seedUserRole(t, f.database, 31, f.low.ID)
	rec, inval := f.watch()
	if _, err := f.svc.perms.GetRoleForUser(ctx, 31); err != nil {
		t.Fatal(err)
	}
	// At notify time the write must be committed on every touched channel and
	// the holder's cached permissions already dropped.
	rec.probe = func() any {
		var rows [2][2]int64
		for i, ch := range []*db.Channel{f.a, f.b} {
			rows[i][0], rows[i][1] = f.channelRow(t, ch, f.low.ID)
		}
		return [2]any{rows, slices.Contains(inval.users, 31)}
	}

	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, f.low.ID, permissions.ReadMessages, permissions.SendMessages); err != nil {
		t.Fatalf("PutCategoryRoleOverride: %v", err)
	}

	if len(rec.events) != 2 {
		t.Fatalf("events = %+v, want one audience refresh per touched channel", rec.events)
	}
	got := make([]int64, 0, len(rec.events))
	want := [2]any{[2][2]int64{{permissions.ReadMessages, permissions.SendMessages}, {permissions.ReadMessages, permissions.SendMessages}}, true}
	for _, ev := range rec.events {
		if ev.kind != "audience" {
			t.Errorf("event kind = %q, want audience", ev.kind)
		}
		if ev.probe != want {
			t.Errorf("state at notify time = %v, want the committed rows and an invalidated holder", ev.probe)
		}
		got = append(got, ev.chanID)
	}
	slices.Sort(got)
	if wantIDs := []int64{f.a.ID, f.b.ID}; !slices.Equal(got, wantIDs) {
		t.Errorf("refreshed channels = %v, want %v", got, wantIDs)
	}
	if inval.all {
		t.Error("a role write with a readable holder list must not flush the whole cache")
	}

	// A refused write neither invalidates nor notifies.
	rec.events, inval.users = nil, nil
	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, f.low.ID, permissions.ManageServer, 0); !errors.Is(err, ErrForbidden) {
		t.Fatalf("escalating template write: err = %v, want ErrForbidden", err)
	}
	if len(rec.events) != 0 || inval.any() {
		t.Errorf("a refused write left events = %+v, invalidations = %+v", rec.events, inval)
	}
}
