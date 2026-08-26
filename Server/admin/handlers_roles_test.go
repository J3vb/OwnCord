package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
		newTestModService(database), newTestRoleService(database))
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
	// Every mutation ships the new list to connected clients.
	if len(hub.rolesUpdates) != 1 {
		t.Fatalf("BroadcastRolesUpdate called %d times, want 1", len(hub.rolesUpdates))
	}
	if len(hub.rolesUpdates[0]) != 4 {
		t.Errorf("broadcast carried %d roles, want the full list of 4", len(hub.rolesUpdates[0]))
	}
	// A new role has no members, so nothing changed visibility.
	if hub.allVisibilityRefreshes != 0 {
		t.Errorf("RefreshAllChannelVisibility called %d times on create, want 0", hub.allVisibilityRefreshes)
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil,
		newTestModService(database), nil)
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
	if hub.allVisibilityRefreshes != 1 {
		t.Errorf("RefreshAllChannelVisibility called %d times, want 1", hub.allVisibilityRefreshes)
	}
	if len(hub.rolesUpdates) != 1 {
		t.Errorf("roles_update broadcasts = %d, want 1", len(hub.rolesUpdates))
	}
}

func TestAdminAPI_PatchRole_RenameOnlySkipsResync(t *testing.T) {
	database := openAdminTestDB(t)
	handler, hub, inv, token := newRolesHandler(t, database)

	w := doRequest(t, handler, http.MethodPatch, "/roles/3", token, map[string]any{"name": "Regulars"})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if decodeRole(t, w.Body.Bytes()).Name != "Regulars" {
		t.Errorf("name not applied: %s", w.Body.String())
	}
	if hub.allVisibilityRefreshes != 0 {
		t.Errorf("RefreshAllChannelVisibility called %d times for a rename, want 0", hub.allVisibilityRefreshes)
	}
	if len(inv.invalidateUserIDs) != 0 {
		t.Errorf("InvalidateUser called %v for a rename, want none", inv.invalidateUserIDs)
	}
	if len(hub.rolesUpdates) != 1 {
		t.Errorf("roles_update broadcasts = %d, want 1 — the name is in the client's role list", len(hub.rolesUpdates))
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
	hub.rolesUpdates = nil

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
	if len(hub.memberUpdates) != 1 || hub.memberUpdates[0].userID != uid {
		t.Errorf("member_update broadcasts = %+v, want one for the reassigned member", hub.memberUpdates)
	}
	if hub.memberUpdates[0].roleName != "Member" {
		t.Errorf("member_update role = %q, want the default role's name", hub.memberUpdates[0].roleName)
	}
	if hub.allVisibilityRefreshes != 1 {
		t.Errorf("RefreshAllChannelVisibility called %d times, want 1", hub.allVisibilityRefreshes)
	}
	if len(hub.rolesUpdates) != 1 {
		t.Errorf("roles_update broadcasts = %d, want 1", len(hub.rolesUpdates))
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
	if positions[3] != 2 || positions[2] != 1 {
		t.Errorf("positions = %v, want role 3 above role 2 (2 and 1)", positions)
	}
	if positions[1] != 100 {
		t.Errorf("owner position = %d, want it untouched at 100", positions[1])
	}
	// Positions feed the hierarchy checks, so the cached role snapshots go.
	if inv.invalidateAllN == 0 {
		t.Error("InvalidateAll was not called after a reorder")
	}
	if len(hub.rolesUpdates) != 1 {
		t.Errorf("roles_update broadcasts = %d, want 1", len(hub.rolesUpdates))
	}
	// "reorder" must not be parsed as a role id by the {id} route.
	if hub.allVisibilityRefreshes != 0 {
		t.Errorf("RefreshAllChannelVisibility called %d times for a reorder, want 0", hub.allVisibilityRefreshes)
	}
}

// ─── broadcast fan-out must survive request cancellation ────────────────────

// TestBroadcastRoles_SurvivesCanceledRequestContext pins OC-0170:
// broadcastRoles re-reads the role list with r.Context() AFTER the mutation
// (create/update/delete/reorder) has already committed. If the admin's
// request is aborted (tab closed, deadline fired) in that window, the re-read
// must not ride the same now-canceled context, or the roles_update broadcast
// is silently skipped and every connected client keeps the stale role list.
// This mirrors OC-0139's fix for broadcastEmojiSet in api/emoji_handler.go
// and the analogous fix for broadcastDMOpen in api/dm_handler.go.
func TestBroadcastRoles_SurvivesCanceledRequestContext(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the request was already aborted by the time the commit lands

	admin.BroadcastRolesForTest(ctx, database, hub)

	if len(hub.rolesUpdates) != 1 {
		t.Fatalf("roles_update broadcasts = %d, want 1 (fan-out must survive a canceled request context)", len(hub.rolesUpdates))
	}
	if len(hub.rolesUpdates[0]) != 3 {
		t.Errorf("broadcast carried %d roles, want the seeded 3", len(hub.rolesUpdates[0]))
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
	if len(hub.rolesUpdates) != 0 {
		t.Error("a refused reorder must not broadcast")
	}
}
