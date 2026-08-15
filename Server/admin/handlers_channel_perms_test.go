package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// mockPermInvalidator records permission-cache invalidation calls.
type mockPermInvalidator struct {
	invalidateUserIDs []int64
	invalidateAllN    int
}

func (m *mockPermInvalidator) InvalidateUser(userID int64) {
	m.invalidateUserIDs = append(m.invalidateUserIDs, userID)
}

func (m *mockPermInvalidator) InvalidateAll() {
	m.invalidateAllN++
}

// ─── GET /channels/{id}/permissions ──────────────────────────────────────────

func TestGetChannelPermissions_ReturnsAllRoles(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	chID, err := database.CreateChannel(context.Background(), "secret", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	w := doRequest(t, handler, http.MethodGet, "/channels/1/permissions", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		ChannelID int64                    `json:"channel_id"`
		Roles     []db.ChannelRoleOverride `json:"roles"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.ChannelID != chID && resp.ChannelID != 1 {
		t.Errorf("channel_id = %d", resp.ChannelID)
	}
	if len(resp.Roles) != 3 {
		t.Fatalf("expected 3 roles, got %d", len(resp.Roles))
	}
	if resp.Roles[0].RoleName != "Owner" {
		t.Errorf("first role = %q, want Owner (position desc)", resp.Roles[0].RoleName)
	}
	for _, role := range resp.Roles {
		if role.Allow != 0 || role.Deny != 0 {
			t.Errorf("role %d: expected zero overrides, got (%#x, %#x)", role.RoleID, role.Allow, role.Deny)
		}
	}
}

func TestGetChannelPermissions_NotFound(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/channels/9999/permissions", token, nil)
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestGetChannelPermissions_DMRejected(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	chID, err := database.CreateChannel(context.Background(), "dm-chan", "dm", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel dm: %v", err)
	}

	w := doRequest(t, handler, http.MethodGet,
		"/channels/"+itoa(chID)+"/permissions", token, nil)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

// ─── PUT /channels/{id}/permissions/{roleId} ─────────────────────────────────

func TestPutChannelPermission_PersistsAndPropagates(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	inv := &mockPermInvalidator{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, inv, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	chID, err := database.CreateChannel(context.Background(), "secret", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	// A member of the targeted role, so the narrowed invalidation has someone
	// to evict. Users of other roles must NOT be evicted.
	memberID, err := database.CreateUser(context.Background(), "role3member", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	denyPrivate := permissions.ReadMessages | permissions.ConnectVoice
	body := map[string]any{"allow": 0, "deny": denyPrivate}
	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/3", token, body)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	allow, deny, err := database.GetChannelPermissions(context.Background(), chID, 3)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	if allow != 0 || deny != denyPrivate {
		t.Errorf("persisted override = (%#x, %#x), want (0, %#x)", allow, deny, denyPrivate)
	}

	// The eviction is narrowed to the targeted role's members — a role-scoped
	// override cannot change any other user's verdict, so the whole-cache
	// flush (and its repopulate stampede) is reserved for the fail-safe path.
	if inv.invalidateAllN != 0 {
		t.Errorf("InvalidateAll calls = %d, want 0 (narrowed invalidation)", inv.invalidateAllN)
	}
	if len(inv.invalidateUserIDs) != 1 || inv.invalidateUserIDs[0] != memberID {
		t.Errorf("InvalidateUser calls = %v, want exactly [%d]", inv.invalidateUserIDs, memberID)
	}
	if len(hub.visibilityRefreshes) != 1 || hub.visibilityRefreshes[0].ID != chID {
		t.Errorf("RefreshChannelVisibility not called for channel %d", chID)
	}

	entries, err := database.GetAuditLog(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	found := false
	for _, e := range entries {
		if e.Action == "channel_perms_update" {
			found = true
		}
	}
	if !found {
		t.Error("expected channel_perms_update audit entry")
	}
}

func TestPutChannelPermission_MasksUnknownBits(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	chID, err := database.CreateChannel(context.Background(), "secret2", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	// 0x4 and 0x8 are undefined bits — they must be dropped.
	body := map[string]any{"allow": 0x4 | permissions.SendMessages, "deny": 0x8}
	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/3", token, body)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	allow, deny, err := database.GetChannelPermissions(context.Background(), chID, 3)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	if allow != permissions.SendMessages {
		t.Errorf("allow = %#x, want %#x (unknown bits dropped)", allow, permissions.SendMessages)
	}
	if deny != 0 {
		t.Errorf("deny = %#x, want 0 (unknown bits dropped)", deny)
	}
}

func TestPutChannelPermission_UnknownRole(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	chID, err := database.CreateChannel(context.Background(), "secret3", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/999", token, map[string]any{"allow": 0, "deny": 2})
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body: %s", w.Code, w.Body.String())
	}
}

func TestPutChannelPermission_NonAdminForbidden(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	_ = createAdminUser(t, database)
	memberToken := createMemberUser(t, database)

	chID, err := database.CreateChannel(context.Background(), "secret4", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/3", memberToken, map[string]any{"allow": 0, "deny": 2})
	if w.Code != http.StatusForbidden && w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 403/401; body: %s", w.Code, w.Body.String())
	}
}

// A MANAGE_CHANNELS holder without ADMINISTRATOR must not be able to grant a
// permission bit their own role lacks (e.g. MANAGE_SERVER) by writing it into
// a channel override — the escalation this override endpoint must refuse.
func TestPutChannelPermission_ModeratorCannotEscalate(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")

	chID, err := database.CreateChannel(context.Background(), "escalate", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	// Target a role below the Moderator's own position (Member, position 40)
	// so only the escalation guard, not the hierarchy guard, is exercised.
	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/3", modToken,
		map[string]any{"allow": permissions.ManageServer, "deny": 0})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body: %s", w.Code, w.Body.String())
	}

	allow, deny, err := database.GetChannelPermissions(context.Background(), chID, 3)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	if allow != 0 || deny != 0 {
		t.Errorf("forbidden grant persisted: (%#x, %#x)", allow, deny)
	}
}

// An ADMINISTRATOR-holding actor (e.g. Owner) can still grant any bit through
// a channel override, since ADMINISTRATOR bypasses the escalation guard.
func TestPutChannelPermission_AdministratorCanGrantAnyBit(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	chID, err := database.CreateChannel(context.Background(), "admin-grant", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/3", token,
		map[string]any{"allow": permissions.ManageServer, "deny": 0})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	allow, _, err := database.GetChannelPermissions(context.Background(), chID, 3)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	if allow != permissions.ManageServer {
		t.Errorf("allow = %#x, want %#x", allow, permissions.ManageServer)
	}
}

// The role-layer endpoint must refuse to write an override for a role at or
// above the actor's own position, even when the requested bits are within
// the actor's own mask — mirroring service.requireBelowActor.
func TestPutChannelPermission_RefusesEqualOrHigherRole(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")

	chID, err := database.CreateChannel(context.Background(), "hierarchy", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	cases := []struct {
		name   string
		roleID string
	}{
		{"higher role (Admin, position 80)", "2"},
		{"own role (Moderator, position 60)", "10"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := doRequest(t, handler, http.MethodPut,
				"/channels/"+itoa(chID)+"/permissions/"+tc.roleID, modToken,
				map[string]any{"allow": permissions.ReadMessages, "deny": 0})
			if w.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403; body: %s", w.Code, w.Body.String())
			}
		})
	}
}

// ─── DELETE /channels/{id}/permissions/{roleId} ──────────────────────────────

func TestDeleteChannelPermission_ClearsOverride(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	inv := &mockPermInvalidator{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, inv, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	chID, err := database.CreateChannel(context.Background(), "secret5", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.UpsertChannelOverride(context.Background(), chID, 3, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	memberID, err := database.CreateUser(context.Background(), "role3clear", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	w := doRequest(t, handler, http.MethodDelete,
		"/channels/"+itoa(chID)+"/permissions/3", token, nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body: %s", w.Code, w.Body.String())
	}

	allow, deny, err := database.GetChannelPermissions(context.Background(), chID, 3)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	if allow != 0 || deny != 0 {
		t.Errorf("override still present: (%#x, %#x)", allow, deny)
	}
	// Narrowed invalidation: only the targeted role's members are evicted.
	if inv.invalidateAllN != 0 {
		t.Errorf("InvalidateAll calls = %d, want 0 (narrowed invalidation)", inv.invalidateAllN)
	}
	if len(inv.invalidateUserIDs) != 1 || inv.invalidateUserIDs[0] != memberID {
		t.Errorf("InvalidateUser calls = %v, want exactly [%d]", inv.invalidateUserIDs, memberID)
	}
	if len(hub.visibilityRefreshes) != 1 {
		t.Errorf("RefreshChannelVisibility calls = %d, want 1", len(hub.visibilityRefreshes))
	}

	// Deleting again is idempotent.
	w = doRequest(t, handler, http.MethodDelete,
		"/channels/"+itoa(chID)+"/permissions/3", token, nil)
	if w.Code != http.StatusNoContent {
		t.Errorf("second delete status = %d, want 204", w.Code)
	}
}

// Deleting an override is a permission mutation: removing a deny row restores
// exactly the access the PUT path refuses to grant. The DELETE handler must
// therefore refuse targets at or above the actor's own position, mirroring
// TestPutChannelPermission_RefusesEqualOrHigherRole (A-2026-08-01).
func TestDeleteChannelPermission_RefusesEqualOrHigherRole(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")

	chID, err := database.CreateChannel(context.Background(), "hierarchy-del", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	cases := []struct {
		name   string
		roleID int64
	}{
		{"higher role (Admin, position 80)", 2},
		{"own role (Moderator, position 60)", 10},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Seed the override the attacker wants gone (e.g. the deny that
			// keeps a private channel hidden from their role).
			if err := database.UpsertChannelOverride(context.Background(), chID, tc.roleID, 0, permissions.ReadMessages); err != nil {
				t.Fatalf("UpsertChannelOverride: %v", err)
			}

			w := doRequest(t, handler, http.MethodDelete,
				"/channels/"+itoa(chID)+"/permissions/"+itoa(tc.roleID), modToken, nil)
			if w.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403; body: %s", w.Code, w.Body.String())
			}

			allow, deny, err := database.GetChannelPermissions(context.Background(), chID, tc.roleID)
			if err != nil {
				t.Fatalf("GetChannelPermissions: %v", err)
			}
			if allow != 0 || deny != permissions.ReadMessages {
				t.Errorf("override mutated by forbidden delete: (%#x, %#x)", allow, deny)
			}
		})
	}
}

// A missing role must 404 before any deletion happens, matching the PUT twin
// (TestPutChannelPermission_UnknownRole).
func TestDeleteChannelPermission_UnknownRole(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	chID, err := database.CreateChannel(context.Background(), "hierarchy-del-404", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	w := doRequest(t, handler, http.MethodDelete,
		"/channels/"+itoa(chID)+"/permissions/999", token, nil)
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body: %s", w.Code, w.Body.String())
	}
}
