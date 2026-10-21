package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// The admin test schema seeds Owner (id 1, pos 100, ADMINISTRATOR), Admin
// (id 2, pos 80, everything but ADMINISTRATOR) and Member (id 3, pos 40,
// is_default). createAdminUser signs in as the Owner.

// newRolesHandler wires the full admin API with a mock hub and a recording
// permission invalidator, and returns them alongside an Owner bearer token.
func newRolesHandler(t *testing.T, database *db.DB) (http.Handler, *mockHub, *mockPermInvalidator, string) {
	t.Helper()
	hub := &mockHub{}
	inv := &mockPermInvalidator{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, inv,
		newTestServicesFor(database, hub, inv))
	return handler, hub, inv, createAdminUser(t, database)
}

// createUserWithRole creates a user holding an existing roleID and returns a
// bearer token for them. (perm_gates_test.go's createRoleUser also upserts the
// role; these tests want the schema's seeded roles left exactly as they are.)
func createUserWithRole(t *testing.T, database *db.DB, username string, roleID int) string {
	t.Helper()
	uid, err := database.CreateUser(context.Background(), username, "$2a$12$placeholder", roleID)
	if err != nil {
		t.Fatalf("CreateUser %s: %v", username, err)
	}
	token := "test-token-" + username + "-" + t.Name()
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession %s: %v", username, err)
	}
	return token
}

// doRequestRaw sends a request with a raw (possibly malformed) body, which
// doRequest cannot express because it marshals its body argument.
func doRequestRaw(t *testing.T, handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

// decodeRole unmarshals a role response body.
func decodeRole(t *testing.T, body []byte) db.Role {
	t.Helper()
	var role db.Role
	if err := json.Unmarshal(body, &role); err != nil {
		t.Fatalf("unmarshal role: %v (body %s)", err, body)
	}
	return role
}

// ─── POST /roles ─────────────────────────────────────────────────────────────

func TestAdminAPI_CreateRole_OK(t *testing.T) {
	database := openAdminTestDB(t)
	handler, hub, _, token := newRolesHandler(t, database)

	w := doRequest(t, handler, http.MethodPost, "/roles", token, map[string]any{
		"name":        "Helper",
		"color":       "#12ab34",
		"permissions": permissions.ReadMessages | permissions.SendMessages,
		"position":    50,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
	role := decodeRole(t, w.Body.Bytes())
	if role.Name != "Helper" || role.Position != 50 {
		t.Errorf("role = %+v", role)
	}
	if role.Color == nil || *role.Color != "#12AB34" {
		t.Errorf("color = %v, want #12AB34", role.Color)
	}
	// Every mutation ships the new list to connected clients: one enqueue
	// asking for a roles_update, which the hub's worker re-reads at send time.
	if len(hub.roleRefreshes) != 1 || hub.rolesEnqueues() != 1 {
		t.Fatalf("role refresh enqueues = %+v, want exactly one asking for roles_update", hub.roleRefreshes)
	}
	// A new role has no members, so nothing changed visibility.
	if hub.visibilityEnqueues() != 0 || len(hub.memberUpdateIDs()) != 0 {
		t.Errorf("create enqueued a visibility refresh or member_update: %+v", hub.roleRefreshes)
	}
}

func TestAdminAPI_CreateRole_DuplicateNameIsBadRequest(t *testing.T) {
	database := openAdminTestDB(t)
	handler, _, _, token := newRolesHandler(t, database)

	w := doRequest(t, handler, http.MethodPost, "/roles", token, map[string]any{"name": "mEmBeR"})
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

func TestAdminAPI_Roles_RequireManageRoles(t *testing.T) {
	database := openAdminTestDB(t)
	handler, _, _, _ := newRolesHandler(t, database)
	// A role inside the admin perimeter but without MANAGE_ROLES.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (9, 'Janitor', ?, 50, 0)`,
		permissions.ManageChannels,
	); err != nil {
		t.Fatalf("seed role: %v", err)
	}
	token := createUserWithRole(t, database, "janitor", 9)

	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/roles", nil},
		{http.MethodPost, "/roles", map[string]any{"name": "x"}},
		{http.MethodPatch, "/roles/3", map[string]any{"name": "x"}},
		{http.MethodPatch, "/roles/reorder", map[string]any{"role_ids": []int64{3}}},
		{http.MethodDelete, "/roles/3", nil},
	} {
		w := doRequest(t, handler, tc.method, tc.path, token, tc.body)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s %s: status = %d, want 403; body: %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}

func TestAdminAPI_Roles_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler, _, _, _ := newRolesHandler(t, database)

	if w := doRequest(t, handler, http.MethodGet, "/roles", "", nil); w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestAdminAPI_Roles_ServiceUnavailableFailsClosed(t *testing.T) {
	database := openAdminTestDB(t)
	// nil RoleService: the routes must refuse rather than fall through to an
	// unchecked write.
	svc := newTestServices(database)
	svc.Roles = nil
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	token := createAdminUser(t, database)

	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/roles", nil},
		{http.MethodPost, "/roles", map[string]any{"name": "x"}},
		{http.MethodPatch, "/roles/3", map[string]any{"name": "x"}},
		{http.MethodPatch, "/roles/reorder", map[string]any{"role_ids": []int64{3}}},
		{http.MethodDelete, "/roles/3", nil},
	} {
		w := doRequest(t, handler, tc.method, tc.path, token, tc.body)
		if w.Code != http.StatusInternalServerError {
			t.Errorf("%s %s: status = %d, want 500", tc.method, tc.path, w.Code)
		}
	}
}

// ─── GET /roles ──────────────────────────────────────────────────────────────

func TestAdminAPI_ListRoles_CarriesMemberCounts(t *testing.T) {
	database := openAdminTestDB(t)
	handler, _, _, token := newRolesHandler(t, database)
	createUserWithRole(t, database, "member1", 3)
	createUserWithRole(t, database, "member2", 3)

	w := doRequest(t, handler, http.MethodGet, "/roles", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var list []struct {
		ID          int64 `json:"id"`
		Position    int   `json:"position"`
		MemberCount int   `json:"member_count"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("got %d roles, want 3", len(list))
	}
	if list[0].Position < list[len(list)-1].Position {
		t.Error("roles are not ordered by position descending")
	}
	counts := map[int64]int{}
	for _, r := range list {
		counts[r.ID] = r.MemberCount
	}
	if counts[3] != 2 {
		t.Errorf("member count = %d, want 2", counts[3])
	}
	if counts[1] != 1 {
		t.Errorf("owner count = %d, want 1 (the acting admin)", counts[1])
	}
}

// ─── PATCH /roles/{id} ───────────────────────────────────────────────────────

func TestAdminAPI_PatchRole_PermissionChangeInvalidatesAndResyncs(t *testing.T) {
	database := openAdminTestDB(t)
	handler, hub, inv, token := newRolesHandler(t, database)
	createUserWithRole(t, database, "member1", 3)

	w := doRequest(t, handler, http.MethodPatch, "/roles/3", token, map[string]any{
		"permissions": permissions.ReadMessages,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	// The one member of role 3 has their cached mask dropped …
	if len(inv.invalidateUserIDs) != 1 || inv.invalidateUserIDs[0] == 0 {
		t.Errorf("InvalidateUser calls = %v, want the single role member", inv.invalidateUserIDs)
	}
	// … and every channel's audience is recomputed, because READ_MESSAGES moved.
	if hub.visibilityEnqueues() != 1 {
		t.Errorf("visibility refresh enqueues = %d, want 1", hub.visibilityEnqueues())
	}
	if got := hub.roleRefreshes[0].Visibility; !slices.Equal(got, inv.invalidateUserIDs) {
		t.Errorf("refreshed users = %v, want the invalidated role members %v", got, inv.invalidateUserIDs)
	}
	if hub.rolesEnqueues() != 1 {
		t.Errorf("roles_update enqueues = %d, want 1", hub.rolesEnqueues())
	}
}

func TestAdminAPI_PatchRole_RenameOnlySkipsResync(t *testing.T) {
	database := openAdminTestDB(t)
	handler, hub, inv, token := newRolesHandler(t, database)
	createUserWithRole(t, database, "member1", 3)

	w := doRequest(t, handler, http.MethodPatch, "/roles/3", token, map[string]any{"name": "Regulars"})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if decodeRole(t, w.Body.Bytes()).Name != "Regulars" {
		t.Errorf("name not applied: %s", w.Body.String())
	}
	if hub.visibilityEnqueues() != 0 {
		t.Errorf("visibility refresh enqueues = %d for a rename, want 0", hub.visibilityEnqueues())
	}
	// The cached snapshot holds the role row (name, colour, position), so even a
	// rename drops the members' entries or GetRoleForUser would serve the old one.
	if len(inv.invalidateUserIDs) != 1 {
		t.Errorf("InvalidateUser calls = %v for a rename, want the single role member", inv.invalidateUserIDs)
	}
	if hub.rolesEnqueues() != 1 {
		t.Errorf("roles_update enqueues = %d, want 1 — the name is in the client's role list", hub.rolesEnqueues())
	}
}

func TestAdminAPI_PatchRole_HierarchyDenied(t *testing.T) {
	database := openAdminTestDB(t)
	handler, _, _, _ := newRolesHandler(t, database)
	adminToken := createUserWithRole(t, database, "admin2", 2)

	// The Admin actor (80) may not edit the Owner role (100) …
	w := doRequest(t, handler, http.MethodPatch, "/roles/1", adminToken, map[string]any{"name": "Pwned"})
	if w.Code != http.StatusForbidden {
		t.Errorf("edit owner role: status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	// … nor their own.
	w = doRequest(t, handler, http.MethodPatch, "/roles/2", adminToken, map[string]any{"name": "Superadmin"})
	if w.Code != http.StatusForbidden {
		t.Errorf("edit own role: status = %d, want 403", w.Code)
	}
	// … nor push a role up to their own rank.
	w = doRequest(t, handler, http.MethodPatch, "/roles/3", adminToken, map[string]any{"position": 80})
	if w.Code != http.StatusForbidden {
		t.Errorf("promote role to own rank: status = %d, want 403", w.Code)
	}
}

func TestAdminAPI_PatchRole_InvalidIDAndBody(t *testing.T) {
	database := openAdminTestDB(t)
	handler, _, _, token := newRolesHandler(t, database)

	if w := doRequest(t, handler, http.MethodPatch, "/roles/abc", token, map[string]any{}); w.Code != http.StatusBadRequest {
		t.Errorf("non-numeric id: status = %d, want 400", w.Code)
	}
	if w := doRequest(t, handler, http.MethodPatch, "/roles/999", token, map[string]any{"name": "x"}); w.Code != http.StatusNotFound {
		t.Errorf("missing role: status = %d, want 404", w.Code)
	}
	req := doRequestRaw(t, handler, http.MethodPatch, "/roles/3", token, "{not json")
	if req.Code != http.StatusBadRequest {
		t.Errorf("malformed body: status = %d, want 400", req.Code)
	}
}

// ─── DELETE /roles/{id} ──────────────────────────────────────────────────────

func TestAdminAPI_DeleteRole_ReassignsAndBroadcasts(t *testing.T) {
	database := openAdminTestDB(t)
	handler, hub, inv, token := newRolesHandler(t, database)
	ctx := context.Background()

	w := doRequest(t, handler, http.MethodPost, "/roles", token, map[string]any{
		"name": "Contractor", "position": 50,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	created := decodeRole(t, w.Body.Bytes())
	uid, err := database.CreateUser(ctx, "contractor", "$2a$12$placeholder", int(created.ID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	hub.roleRefreshes = nil

	w = doRequest(t, handler, http.MethodDelete, "/roles/"+itoa(created.ID), token, nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("delete: status = %d, want 204; body: %s", w.Code, w.Body.String())
	}

	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if user.RoleID != 3 {
		t.Errorf("member role after delete = %d, want the default role 3", user.RoleID)
	}
	if len(inv.invalidateUserIDs) == 0 {
		t.Error("reassigned member's cached permissions were not invalidated")
	}
	// One enqueue carries the whole fan-out; the worker reads the fallback
	// role's name when it sends, so the request names only the users.
	if len(hub.roleRefreshes) != 1 {
		t.Fatalf("role refresh enqueues = %+v, want exactly one", hub.roleRefreshes)
	}
	got := hub.roleRefreshes[0]
	if !slices.Equal(got.MemberUpdate, []int64{uid}) || !slices.Equal(got.Visibility, []int64{uid}) {
		t.Errorf("enqueue = %+v, want member_update and visibility for just the reassigned member %d", got, uid)
	}
	if !got.Roles || got.AllConnected {
		t.Errorf("enqueue = %+v, want roles_update and no all-connected sweep", got)
	}
}

func TestAdminAPI_DeleteRole_OwnerAndDefaultRefused(t *testing.T) {
	database := openAdminTestDB(t)
	handler, _, _, token := newRolesHandler(t, database)

	// Nothing outranks the Owner role, so the hierarchy check refuses first.
	if w := doRequest(t, handler, http.MethodDelete, "/roles/1", token, nil); w.Code != http.StatusForbidden {
		t.Errorf("delete owner role: status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	// The default role clears the hierarchy check and is stopped by is_default.
	w := doRequest(t, handler, http.MethodDelete, "/roles/3", token, nil)
	if w.Code != http.StatusBadRequest {
		t.Errorf("delete default role: status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
	if role, _ := database.GetRoleByID(context.Background(), 3); role == nil {
		t.Fatal("the default role was deleted")
	}
}

// ─── PATCH /roles/reorder ────────────────────────────────────────────────────

func TestAdminAPI_ReorderRoles_NormalizesAndBroadcasts(t *testing.T) {
	database := openAdminTestDB(t)
	handler, hub, inv, token := newRolesHandler(t, database)

	w := doRequest(t, handler, http.MethodPatch, "/roles/reorder", token, map[string]any{
		"role_ids": []int64{3, 2},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var list []db.Role
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	positions := map[int64]int{}
	for _, r := range list {
		positions[r.ID] = r.Position
	}
	// Two roles below the owner's 100 take a stride of 33: role 3 above role 2,
	// with room left below each for a manager to create in. The pair used to be
	// compacted to 2 and 1, which left none (OC-0374 — the service-side pins are
	// in service/role_reorder_spacing_test.go).
	if positions[3] != 66 || positions[2] != 33 {
		t.Errorf("positions = %v, want role 3 above role 2 (66 and 33)", positions)
	}
	if positions[1] != 100 {
		t.Errorf("owner position = %d, want it untouched at 100", positions[1])
	}
	// Positions feed the hierarchy checks, so the cached role snapshots go.
	if inv.invalidateAllN == 0 {
		t.Error("InvalidateAll was not called after a reorder")
	}
	if hub.rolesEnqueues() != 1 {
		t.Errorf("roles_update enqueues = %d, want 1", hub.rolesEnqueues())
	}
	// "reorder" must not be parsed as a role id by the {id} route.
	if hub.visibilityEnqueues() != 0 {
		t.Errorf("visibility refresh enqueues = %d for a reorder, want 0", hub.visibilityEnqueues())
	}
}

func TestAdminAPI_ReorderRoles_PartialListRefused(t *testing.T) {
	database := openAdminTestDB(t)
	handler, hub, _, token := newRolesHandler(t, database)

	w := doRequest(t, handler, http.MethodPatch, "/roles/reorder", token, map[string]any{
		"role_ids": []int64{3},
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
	if len(hub.roleRefreshes) != 0 {
		t.Error("a refused reorder must not broadcast")
	}
}

func TestAdminAPI_PatchRole_StaleExpectedPermissionsIs409(t *testing.T) {
	database := openAdminTestDB(t)
	handler, hub, inv, token := newRolesHandler(t, database)
	createUserWithRole(t, database, "member1", 3)

	// Role 3's stored mask is not 1, so an editor that loaded 1 is stale.
	w := doRequest(t, handler, http.MethodPatch, "/roles/3", token, map[string]any{
		"permissions":          permissions.ReadMessages,
		"expected_permissions": 1,
	})
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"ROLE_CONFLICT"`) {
		t.Errorf("body = %s, want code ROLE_CONFLICT", w.Body.String())
	}
	if len(inv.invalidateUserIDs) != 0 || hub.rolesEnqueues() != 0 {
		t.Errorf("a refused edit must have no side effects: invalidations=%v roles enqueues=%d",
			inv.invalidateUserIDs, hub.rolesEnqueues())
	}

	// The current mask goes through.
	var stored db.Role
	rw := doRequest(t, handler, http.MethodGet, "/roles", token, nil)
	var list []db.Role
	if err := json.Unmarshal(rw.Body.Bytes(), &list); err != nil {
		t.Fatalf("unmarshal roles: %v", err)
	}
	for _, r := range list {
		if r.ID == 3 {
			stored = r
		}
	}
	w = doRequest(t, handler, http.MethodPatch, "/roles/3", token, map[string]any{
		"permissions":          permissions.ReadMessages,
		"expected_permissions": stored.Permissions,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("matching: status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}
