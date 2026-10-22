package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// WP 6.5d: category permission templates, the sync lifecycle and their routes.

const (
	catModRole    = 30 // MANAGE_CHANNELS, no MANAGE_SERVER: the guarded actor
	catTargetRole = 31 // the role the overrides target
)

type catPermFixture struct {
	t        *testing.T
	database *db.DB
	handler  http.Handler
	hub      *mockHub
	inv      *mockPermInvalidator
	admin    string
	mod      string
	cat      db.ChannelCategory
	a, b     db.Channel
}

func newCatPermFixture(t *testing.T) *catPermFixture {
	t.Helper()
	database := openAdminTestDB(t)
	f := &catPermFixture{t: t, database: database, hub: &mockHub{}, inv: &mockPermInvalidator{}}
	f.handler = admin.NewAdminAPI(database, "1.0.0", f.hub, nil, nil, nil, nil, newTestServicesFor(database, f.hub, f.inv))
	f.admin = createAdminUser(t, database)
	_, f.mod = createRoleUser(t, database, catModRole, "CatMod", permissions.ManageChannels|permissions.ReadMessages|permissions.SendMessages, 50, "catmod")
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default) VALUES (?, 'CatTarget', NULL, ?, 10, 0)`,
		catTargetRole, permissions.ReadMessages|permissions.SendMessages); err != nil {
		t.Fatalf("seed target role: %v", err)
	}
	f.cat = f.mustCategory("Games")
	f.a = f.mustChannel("alpha", f.cat.ID)
	f.b = f.mustChannel("beta", f.cat.ID)
	return f
}

func (f *catPermFixture) call(token, method, path string, body any) (int, []byte) {
	f.t.Helper()
	w := doRequest(f.t, f.handler, method, path, token, body)
	return w.Code, w.Body.Bytes()
}

func (f *catPermFixture) mustCategory(name string) db.ChannelCategory {
	f.t.Helper()
	code, body := f.call(f.admin, http.MethodPost, "/channels/categories", map[string]any{"name": name})
	if code != http.StatusCreated {
		f.t.Fatalf("create category: %d %s", code, body)
	}
	var c db.ChannelCategory
	_ = json.Unmarshal(body, &c)
	return c
}

func (f *catPermFixture) mustChannel(name string, categoryID int64) db.Channel {
	f.t.Helper()
	code, body := f.call(f.mod, http.MethodPost, "/channels", map[string]any{"name": name, "category_id": categoryID})
	if code != http.StatusCreated {
		f.t.Fatalf("create channel %s: %d %s", name, code, body)
	}
	var ch db.Channel
	_ = json.Unmarshal(body, &ch)
	return ch
}

func (f *catPermFixture) path(suffix string) string {
	return "/channels/categories/" + itoa(f.cat.ID) + suffix
}

func (f *catPermFixture) row(ch db.Channel) (int64, int64) {
	f.t.Helper()
	a, d, err := f.database.GetChannelPermissions(context.Background(), ch.ID, catTargetRole)
	if err != nil {
		f.t.Fatalf("GetChannelPermissions: %v", err)
	}
	return a, d
}

func (f *catPermFixture) synced(ch db.Channel) bool {
	f.t.Helper()
	ok, err := f.database.ChannelPermissionsSynced(context.Background(), ch.ID)
	if err != nil {
		f.t.Fatalf("ChannelPermissionsSynced: %v", err)
	}
	return ok
}

func (f *catPermFixture) auditHas(action string) bool {
	f.t.Helper()
	entries, err := f.database.GetAuditLog(context.Background(), 100, 0)
	if err != nil {
		f.t.Fatalf("GetAuditLog: %v", err)
	}
	return slices.ContainsFunc(entries, func(e db.AuditEntry) bool { return e.Action == action })
}

func TestCategoryPermissions_RequireManageChannels(t *testing.T) {
	f := newCatPermFixture(t)
	member := createMemberUser(t, f.database)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, f.path("/permissions")},
		{http.MethodPut, f.path("/permissions/" + itoa(catTargetRole))},
		{http.MethodDelete, f.path("/permissions/" + itoa(catTargetRole))},
		{http.MethodPut, f.path("/user-permissions/1")},
		{http.MethodDelete, f.path("/user-permissions/1")},
		{http.MethodPost, "/channels/" + itoa(f.a.ID) + "/permissions/sync"},
	} {
		code, _ := f.call(member, tc.method, tc.path, map[string]any{"allow": 2, "deny": 0})
		if code != http.StatusForbidden {
			t.Errorf("%s %s as a member: %d, want 403", tc.method, tc.path, code)
		}
	}
	if a, d := f.row(f.a); a != 0 || d != 0 {
		t.Errorf("a refused request wrote (%d,%d)", a, d)
	}
}

func TestCategoryPermissions_GetListsEveryRoleAndExistingUserRows(t *testing.T) {
	f := newCatPermFixture(t)
	uid, err := f.database.CreateUser(context.Background(), "listed", "x", catTargetRole)
	if err != nil {
		t.Fatal(err)
	}
	if code, body := f.call(f.mod, http.MethodPut, f.path("/user-permissions/"+itoa(uid)), map[string]any{"allow": permissions.ReadMessages}); code != http.StatusOK {
		t.Fatalf("put user: %d %s", code, body)
	}
	code, body := f.call(f.mod, http.MethodGet, f.path("/permissions"), nil)
	if code != http.StatusOK {
		t.Fatalf("get: %d %s", code, body)
	}
	var resp struct {
		CategoryID int64                    `json:"category_id"`
		Roles      []db.ChannelRoleOverride `json:"roles"`
		Users      []db.ChannelUserOverride `json:"users"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.CategoryID != f.cat.ID || len(resp.Roles) < 4 || len(resp.Users) != 1 || resp.Users[0].UserID != uid {
		t.Errorf("response = %+v", resp)
	}
	if code, _ := f.call(f.mod, http.MethodGet, "/channels/categories/9999/permissions", nil); code != http.StatusNotFound {
		t.Errorf("unknown category: %d, want 404", code)
	}
	if code, _ := f.call(f.mod, http.MethodGet, "/channels/categories/abc/permissions", nil); code != http.StatusBadRequest {
		t.Errorf("bad id: %d, want 400", code)
	}
}

func TestCategoryPermissions_PutWritesEverySyncedChannelAndRefreshesEach(t *testing.T) {
	f := newCatPermFixture(t)
	holder, err := f.database.CreateUser(context.Background(), "holder", "x", catTargetRole)
	if err != nil {
		t.Fatal(err)
	}
	f.hub.visibilityRefreshes = nil
	code, body := f.call(f.mod, http.MethodPut, f.path("/permissions/"+itoa(catTargetRole)), map[string]any{"allow": permissions.ReadMessages, "deny": permissions.SendMessages})
	if code != http.StatusOK {
		t.Fatalf("put: %d %s", code, body)
	}
	for _, ch := range []db.Channel{f.a, f.b} {
		if a, d := f.row(ch); a != permissions.ReadMessages || d != permissions.SendMessages {
			t.Errorf("channel %s = (%#x,%#x)", ch.Name, a, d)
		}
	}
	refreshed := make([]int64, 0, len(f.hub.visibilityRefreshes))
	for _, ch := range f.hub.visibilityRefreshes {
		refreshed = append(refreshed, ch.ID)
	}
	slices.Sort(refreshed)
	if !slices.Equal(refreshed, []int64{f.a.ID, f.b.ID}) {
		t.Errorf("visibility refreshed for %v, want each touched channel", refreshed)
	}
	if !slices.Contains(f.inv.invalidateUserIDs, holder) {
		t.Errorf("invalidated %v, want the role's holder %d", f.inv.invalidateUserIDs, holder)
	}
	if !f.auditHas("category_perms_update") {
		t.Error("no category_perms_update audit row")
	}

	// Clearing removes the template row and every synced channel's row.
	if code, body := f.call(f.mod, http.MethodDelete, f.path("/permissions/"+itoa(catTargetRole)), nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", code, body)
	}
	if a, d := f.row(f.a); a != 0 || d != 0 {
		t.Errorf("after delete = (%d,%d)", a, d)
	}
	if !f.auditHas("category_perms_clear") {
		t.Error("no category_perms_clear audit row")
	}
}

func TestCategoryPermissions_EscalationRefusedWithNothingWritten(t *testing.T) {
	f := newCatPermFixture(t)
	// A synced channel carries a MANAGE_SERVER deny the mod's role lacks; the
	// write's own bits are harmless.
	if _, err := f.database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, 0, ?)`,
		f.a.ID, catTargetRole, permissions.ManageServer); err != nil {
		t.Fatal(err)
	}
	f.hub.visibilityRefreshes = nil
	f.inv.invalidateUserIDs, f.inv.invalidateAllN = nil, 0
	code, body := f.call(f.mod, http.MethodPut, f.path("/permissions/"+itoa(catTargetRole)), map[string]any{"allow": permissions.ReadMessages})
	if code != http.StatusForbidden || !strings.Contains(string(body), "cannot grant a permission your own role lacks") {
		t.Fatalf("put: %d %s, want 403 with the guard's message", code, body)
	}
	if a, d := f.row(f.a); a != 0 || d != permissions.ManageServer {
		t.Errorf("channel a = (%#x,%#x), want it untouched", a, d)
	}
	if a, d := f.row(f.b); a != 0 || d != 0 {
		t.Errorf("channel b = (%#x,%#x), want nothing written", a, d)
	}
	if len(f.hub.visibilityRefreshes) != 0 || len(f.inv.invalidateUserIDs) != 0 || f.inv.invalidateAllN != 0 {
		t.Error("a refused write fanned out")
	}
	// The escalating bit itself, and a clear, are refused too.
	if code, _ := f.call(f.mod, http.MethodPut, f.path("/permissions/"+itoa(catTargetRole)), map[string]any{"allow": permissions.ManageServer}); code != http.StatusForbidden {
		t.Errorf("escalating put: %d, want 403", code)
	}
	if code, _ := f.call(f.mod, http.MethodDelete, f.path("/permissions/"+itoa(catTargetRole)), nil); code != http.StatusForbidden {
		t.Errorf("clearing a foreign deny: %d, want 403", code)
	}
	// The administrator is not subject to the escalation guard.
	if code, body := f.call(f.admin, http.MethodPut, f.path("/permissions/"+itoa(catTargetRole)), map[string]any{"allow": permissions.ReadMessages}); code != http.StatusOK {
		t.Errorf("admin put: %d %s", code, body)
	}
}

func TestCategoryPermissions_HierarchyGuards(t *testing.T) {
	f := newCatPermFixture(t)
	// The mod's own role and the Owner role are not below it.
	for _, roleID := range []int64{catModRole, 1} {
		if code, _ := f.call(f.mod, http.MethodPut, f.path("/permissions/"+itoa(roleID)), map[string]any{"allow": 2}); code != http.StatusForbidden {
			t.Errorf("put role %d: %d, want 403", roleID, code)
		}
		if code, _ := f.call(f.mod, http.MethodDelete, f.path("/permissions/"+itoa(roleID)), nil); code != http.StatusForbidden {
			t.Errorf("delete role %d: %d, want 403", roleID, code)
		}
	}
	ownerUser, err := f.database.CreateUser(context.Background(), "boss", "x", 1)
	if err != nil {
		t.Fatal(err)
	}
	if code, _ := f.call(f.mod, http.MethodPut, f.path("/user-permissions/"+itoa(ownerUser)), map[string]any{"deny": 2}); code != http.StatusForbidden {
		t.Errorf("higher-ranked user: %d, want 403", code)
	}
	if code, _ := f.call(f.mod, http.MethodDelete, f.path("/user-permissions/"+itoa(ownerUser)), nil); code != http.StatusForbidden {
		t.Errorf("higher-ranked user delete: %d, want 403", code)
	}
	if code, _ := f.call(f.mod, http.MethodPut, f.path("/permissions/9999"), map[string]any{}); code != http.StatusNotFound {
		t.Errorf("unknown role: %d, want 404", code)
	}
	if code, _ := f.call(f.mod, http.MethodPut, f.path("/user-permissions/9999"), map[string]any{}); code != http.StatusNotFound {
		t.Errorf("unknown user: %d, want 404", code)
	}
	if code, _ := f.call(f.mod, http.MethodPut, f.path("/permissions/x"), map[string]any{}); code != http.StatusBadRequest {
		t.Errorf("bad role id: %d, want 400", code)
	}
	if code, _ := f.call(f.mod, http.MethodPut, f.path("/user-permissions/x"), map[string]any{}); code != http.StatusBadRequest {
		t.Errorf("bad user id: %d, want 400", code)
	}
	if code, _ := f.call(f.mod, http.MethodPut, "/channels/categories/x/permissions/"+itoa(catTargetRole), map[string]any{}); code != http.StatusBadRequest {
		t.Errorf("bad category id: %d, want 400", code)
	}
	w := doRequestRaw(t, f.handler, http.MethodPut, f.path("/permissions/"+itoa(catTargetRole)), f.mod, "{nope")
	if w.Code != http.StatusBadRequest {
		t.Errorf("bad body: %d, want 400", w.Code)
	}
}

func TestCategoryPermissions_UserRowsWriteAndClearOnSyncedChannels(t *testing.T) {
	f := newCatPermFixture(t)
	uid, err := f.database.CreateUser(context.Background(), "member", "x", catTargetRole)
	if err != nil {
		t.Fatal(err)
	}
	f.inv.invalidateUserIDs = nil
	code, body := f.call(f.mod, http.MethodPut, f.path("/user-permissions/"+itoa(uid)), map[string]any{"allow": permissions.ReadMessages})
	if code != http.StatusOK {
		t.Fatalf("put: %d %s", code, body)
	}
	if a, _, _ := f.database.GetUserChannelPermissions(context.Background(), f.b.ID, uid); a != permissions.ReadMessages {
		t.Errorf("synced channel user row = %#x", a)
	}
	if !slices.Equal(f.inv.invalidateUserIDs, []int64{uid}) {
		t.Errorf("invalidated %v, want only the target", f.inv.invalidateUserIDs)
	}
	if code, body := f.call(f.mod, http.MethodDelete, f.path("/user-permissions/"+itoa(uid)), nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", code, body)
	}
	if a, _, _ := f.database.GetUserChannelPermissions(context.Background(), f.b.ID, uid); a != 0 {
		t.Errorf("user row left: %#x", a)
	}
	if !f.auditHas("category_user_perms_update") || !f.auditHas("category_user_perms_clear") {
		t.Error("missing category user audit rows")
	}
}

// Copying the template is not a grant by the creator: a MANAGE_CHANNELS holder
// who lacks the bits in the template can still create a channel in the
// category.
func TestCreateChannelInCategory_CopiesTheTemplateWithoutBlockingALowerCreator(t *testing.T) {
	f := newCatPermFixture(t)
	if code, body := f.call(f.admin, http.MethodPut, f.path("/permissions/"+itoa(catTargetRole)), map[string]any{"deny": permissions.ManageServer | permissions.ReadMessages}); code != http.StatusOK {
		t.Fatalf("admin template: %d %s", code, body)
	}
	holder, err := f.database.CreateUser(context.Background(), "holder", "x", catTargetRole)
	if err != nil {
		t.Fatal(err)
	}
	f.inv.invalidateUserIDs = nil
	ch := f.mustChannel("created-by-a-mod", f.cat.ID)
	if a, d := f.row(ch); a != 0 || d != permissions.ManageServer|permissions.ReadMessages {
		t.Errorf("new channel row = (%#x,%#x), want the template's", a, d)
	}
	if !f.synced(ch) {
		t.Error("new channel should start synced")
	}
	if !slices.Contains(f.inv.invalidateUserIDs, holder) {
		t.Errorf("invalidated %v, want the template role's holder dropped before the channel is announced", f.inv.invalidateUserIDs)
	}
	// The legacy category string reaches the same template.
	code, body := f.call(f.mod, http.MethodPost, "/channels", map[string]any{"name": "legacy", "category": "GAMES"})
	if code != http.StatusCreated {
		t.Fatalf("legacy create: %d %s", code, body)
	}
	var legacy db.Channel
	_ = json.Unmarshal(body, &legacy)
	if _, d := f.row(legacy); d != permissions.ManageServer|permissions.ReadMessages || !f.synced(legacy) {
		t.Errorf("legacy create deny = %#x synced=%v", d, f.synced(legacy))
	}
}

func TestChannelPermissions_DirectEditUnsyncsAndWireCarriesTheFlag(t *testing.T) {
	f := newCatPermFixture(t)
	listed := func() map[int64]bool {
		code, body := f.call(f.mod, http.MethodGet, "/channels", nil)
		if code != http.StatusOK {
			t.Fatalf("list: %d %s", code, body)
		}
		var rows []struct {
			ID     int64 `json:"id"`
			Synced *bool `json:"permissions_synced"`
		}
		if err := json.Unmarshal(body, &rows); err != nil {
			t.Fatal(err)
		}
		out := map[int64]bool{}
		for _, r := range rows {
			if r.Synced == nil {
				t.Fatalf("channel %d has no permissions_synced in the admin list", r.ID)
			}
			out[r.ID] = *r.Synced
		}
		return out
	}
	if got := listed(); !got[f.a.ID] || !got[f.b.ID] {
		t.Fatalf("list = %v, want both synced", got)
	}
	if code, body := f.call(f.mod, http.MethodPut, "/channels/"+itoa(f.a.ID)+"/permissions/"+itoa(catTargetRole), map[string]any{"allow": permissions.ReadMessages}); code != http.StatusOK {
		t.Fatalf("direct put: %d %s", code, body)
	}
	if got := listed(); got[f.a.ID] || !got[f.b.ID] {
		t.Errorf("list after a direct edit = %v, want a unsynced and b synced", got)
	}
	code, body := f.call(f.mod, http.MethodGet, "/channels/"+itoa(f.a.ID)+"/permissions", nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"permissions_synced":false`) {
		t.Errorf("channel permissions GET = %d %s, want permissions_synced:false", code, body)
	}
	code, body = f.call(f.mod, http.MethodGet, "/channels/"+itoa(f.b.ID)+"/permissions", nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"permissions_synced":true`) {
		t.Errorf("channel permissions GET = %d %s, want permissions_synced:true", code, body)
	}
	// The flag is admin-only: the websocket channel payload struct has none.
	raw, _ := json.Marshal(f.a)
	if strings.Contains(string(raw), "permissions_synced") {
		t.Error("db.Channel (the ws payload source) must not carry permissions_synced")
	}
}

func TestPatchChannel_MoveKeepsOverridesUnlessSyncPermissions(t *testing.T) {
	f := newCatPermFixture(t)
	other := f.mustCategory("Music")
	if code, body := f.call(f.admin, http.MethodPut, f.path("/permissions/"+itoa(catTargetRole)), map[string]any{"allow": permissions.ReadMessages}); code != http.StatusOK {
		t.Fatalf("template: %d %s", code, body)
	}
	otherPath := "/channels/categories/" + itoa(other.ID) + "/permissions/" + itoa(catTargetRole)
	if code, body := f.call(f.admin, http.MethodPut, otherPath, map[string]any{"allow": permissions.SendMessages}); code != http.StatusOK {
		t.Fatalf("other template: %d %s", code, body)
	}

	if code, body := f.call(f.mod, http.MethodPatch, "/channels/"+itoa(f.a.ID), map[string]any{"category_id": other.ID}); code != http.StatusOK {
		t.Fatalf("plain move: %d %s", code, body)
	}
	if a, _ := f.row(f.a); a != permissions.ReadMessages {
		t.Errorf("a plain move changed the row to %#x", a)
	}
	if f.synced(f.a) {
		t.Error("a plain move must unsync")
	}

	f.inv.invalidateUserIDs, f.hub.visibilityRefreshes = nil, nil
	holder, err := f.database.CreateUser(context.Background(), "holder", "x", catTargetRole)
	if err != nil {
		t.Fatal(err)
	}
	code, body := f.call(f.mod, http.MethodPatch, "/channels/"+itoa(f.b.ID), map[string]any{"category_id": other.ID, "sync_permissions": true})
	if code != http.StatusOK {
		t.Fatalf("sync move: %d %s", code, body)
	}
	if a, _ := f.row(f.b); a != permissions.SendMessages || !f.synced(f.b) {
		t.Errorf("after a sync move row=%#x synced=%v, want the target template and synced", a, f.synced(f.b))
	}
	if !slices.Contains(f.inv.invalidateUserIDs, holder) || len(f.hub.visibilityRefreshes) == 0 {
		t.Errorf("sync move fan-out: invalidated %v, refreshes %d", f.inv.invalidateUserIDs, len(f.hub.visibilityRefreshes))
	}
	if !f.auditHas("channel_perms_sync") {
		t.Error("no channel_perms_sync audit row")
	}

	// A sync the actor could not have written by hand is refused whole: the
	// channel does not move either.
	if _, err := f.database.ExecContext(context.Background(),
		`UPDATE channel_overrides SET deny = ? WHERE channel_id = ?`, permissions.ManageServer, f.b.ID); err != nil {
		t.Fatal(err)
	}
	code, body = f.call(f.mod, http.MethodPatch, "/channels/"+itoa(f.b.ID), map[string]any{"category_id": f.cat.ID, "sync_permissions": true})
	if code != http.StatusForbidden {
		t.Fatalf("refused sync move: %d %s, want 403", code, body)
	}
	got, _ := f.database.GetChannel(context.Background(), f.b.ID)
	if got.CategoryID != other.ID {
		t.Errorf("a refused sync moved the channel to category %d", got.CategoryID)
	}
	// And sync_permissions with no category is a 400.
	if code, _ := f.call(f.admin, http.MethodPatch, "/channels/"+itoa(f.b.ID), map[string]any{"category_id": 0, "sync_permissions": true}); code != http.StatusBadRequest {
		t.Errorf("sync without a category: %d, want 400", code)
	}
}

func TestSyncEndpoint(t *testing.T) {
	f := newCatPermFixture(t)
	if code, body := f.call(f.admin, http.MethodPut, f.path("/permissions/"+itoa(catTargetRole)), map[string]any{"allow": permissions.ReadMessages}); code != http.StatusOK {
		t.Fatalf("template: %d %s", code, body)
	}
	syncPath := "/channels/" + itoa(f.a.ID) + "/permissions/sync"
	// Drift: a direct edit unsyncs and diverges.
	if code, body := f.call(f.mod, http.MethodPut, "/channels/"+itoa(f.a.ID)+"/permissions/"+itoa(catTargetRole), map[string]any{"allow": permissions.SendMessages}); code != http.StatusOK {
		t.Fatalf("drift: %d %s", code, body)
	}
	f.hub.visibilityRefreshes = nil
	code, body := f.call(f.mod, http.MethodPost, syncPath, nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"permissions_synced":true`) {
		t.Fatalf("sync: %d %s", code, body)
	}
	if a, _ := f.row(f.a); a != permissions.ReadMessages || !f.synced(f.a) {
		t.Errorf("after sync row=%#x synced=%v", a, f.synced(f.a))
	}
	if len(f.hub.visibilityRefreshes) != 1 {
		t.Errorf("visibility refreshes = %d, want 1", len(f.hub.visibilityRefreshes))
	}
	if !f.auditHas("channel_perms_sync") {
		t.Error("no channel_perms_sync audit row")
	}

	// 404 for an unknown channel, 400 for an uncategorized one.
	if code, _ := f.call(f.mod, http.MethodPost, "/channels/9999/permissions/sync", nil); code != http.StatusNotFound {
		t.Errorf("unknown channel: %d, want 404", code)
	}
	loose, err := f.database.CreateChannel(context.Background(), "loose", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if code, _ := f.call(f.mod, http.MethodPost, "/channels/"+itoa(loose)+"/permissions/sync", nil); code != http.StatusBadRequest {
		t.Errorf("uncategorized: %d, want 400", code)
	}

	// 403 when the rows to replace carry a bit the actor lacks.
	if _, err := f.database.ExecContext(context.Background(),
		`UPDATE channel_overrides SET deny = ? WHERE channel_id = ?`, permissions.ManageServer, f.a.ID); err != nil {
		t.Fatal(err)
	}
	if code, _ := f.call(f.mod, http.MethodPost, syncPath, nil); code != http.StatusForbidden {
		t.Errorf("escalating sync: %d, want 403", code)
	}
	if _, d := f.row(f.a); d != permissions.ManageServer {
		t.Errorf("a refused sync changed the row: deny %#x", d)
	}
}

func TestDeleteCategory_UnsyncsChannelsThatKeepTheirOverrides(t *testing.T) {
	f := newCatPermFixture(t)
	if code, body := f.call(f.admin, http.MethodPut, f.path("/permissions/"+itoa(catTargetRole)), map[string]any{"allow": permissions.ReadMessages}); code != http.StatusOK {
		t.Fatalf("template: %d %s", code, body)
	}
	if code, body := f.call(f.mod, http.MethodDelete, "/channels/categories/"+itoa(f.cat.ID), nil); code != http.StatusNoContent {
		t.Fatalf("delete category: %d %s", code, body)
	}
	for _, ch := range []db.Channel{f.a, f.b} {
		if a, _ := f.row(ch); a != permissions.ReadMessages {
			t.Errorf("channel %s lost its override: %#x", ch.Name, a)
		}
		if f.synced(ch) {
			t.Errorf("channel %s still synced", ch.Name)
		}
	}
	if code, _ := f.call(f.mod, http.MethodGet, f.path("/permissions"), nil); code != http.StatusNotFound {
		t.Errorf("template of a deleted category: %d, want 404", code)
	}
}
