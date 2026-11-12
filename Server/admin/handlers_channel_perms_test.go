package admin_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
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
	database, handler, token := newAdminHarness(t)

	chID := mustCreateChannel(t, database, "secret", "text")

	w := doRequest(t, handler, http.MethodGet, "/channels/1/permissions", token, nil)
	requireStatus(t, w, http.StatusOK)

	resp := decodeBody[struct {
		ChannelID int64                    `json:"channel_id"`
		Roles     []db.ChannelRoleOverride `json:"roles"`
	}](t, w)
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
	_, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodGet, "/channels/9999/permissions", token, nil)
	expectStatus(t, w, http.StatusNotFound)
}

func TestGetChannelPermissions_DMRejected(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	chID := mustCreateChannel(t, database, "dm-chan", "dm")

	// S-04 (B3-8 channel family): a DM id answers 404, identically to a
	// missing id, so this surface no longer confirms which ids are private
	// conversations — the pre-family 400 did (A-2026-08-02). The
	// indistinguishability itself is pinned by
	// TestS04_DMAndMissingChannelAnswerIdentically.
	w := doRequest(t, handler, http.MethodGet,
		"/channels/"+itoa(chID)+"/permissions", token, nil)
	expectStatus(t, w, http.StatusNotFound)
}

// ─── PUT /channels/{id}/permissions/{roleId} ─────────────────────────────────

func TestPutChannelPermission_PersistsAndPropagates(t *testing.T) {
	database, hub, inv, handler, token := newPermHarness(t)

	chID := mustCreateChannel(t, database, "secret", "text")

	// A member of the targeted role, so the narrowed invalidation has someone
	// to evict. Users of other roles must NOT be evicted.
	memberID := mustCreateUser(t, database, "role3member", "hash", 3)

	denyPrivate := permissions.ReadMessages | permissions.ConnectVoice
	body := map[string]any{"allow": 0, "deny": denyPrivate}
	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/3", token, body)
	requireStatus(t, w, http.StatusOK)

	allow, deny := channelPerms(t, database, chID, 3)
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

	requireAuditAction(t, database, "channel_perms_update")
}

func TestPutChannelPermission_MasksUnknownBits(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	chID := mustCreateChannel(t, database, "secret2", "text")

	// 0x20000000 (bit 29) is an undefined bit — it must be dropped.
	body := map[string]any{"allow": 0x20000000 | permissions.SendMessages, "deny": 0x20000000}
	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/3", token, body)
	requireStatus(t, w, http.StatusOK)

	allow, deny := channelPerms(t, database, chID, 3)
	if allow != permissions.SendMessages {
		t.Errorf("allow = %#x, want %#x (unknown bits dropped)", allow, permissions.SendMessages)
	}
	if deny != 0 {
		t.Errorf("deny = %#x, want 0 (unknown bits dropped)", deny)
	}
}

func TestPutChannelPermission_UnknownRole(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	chID := mustCreateChannel(t, database, "secret3", "text")

	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/999", token, map[string]any{"allow": 0, "deny": 2})
	expectStatus(t, w, http.StatusNotFound)
}

func TestPutChannelPermission_NonAdminForbidden(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_ = createAdminUser(t, database)
	memberToken := createMemberUser(t, database)

	chID := mustCreateChannel(t, database, "secret4", "text")

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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")

	chID := mustCreateChannel(t, database, "escalate", "text")

	// Target a role below the Moderator's own position (Member, position 40)
	// so only the escalation guard, not the hierarchy guard, is exercised.
	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/3", modToken,
		map[string]any{"allow": permissions.ManageServer, "deny": 0})
	requireStatus(t, w, http.StatusForbidden)

	allow, deny := channelPerms(t, database, chID, 3)
	if allow != 0 || deny != 0 {
		t.Errorf("forbidden grant persisted: (%#x, %#x)", allow, deny)
	}
}

// An ADMINISTRATOR-holding actor (e.g. Owner) can still grant any bit through
// a channel override, since ADMINISTRATOR bypasses the escalation guard.
func TestPutChannelPermission_AdministratorCanGrantAnyBit(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	chID := mustCreateChannel(t, database, "admin-grant", "text")

	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/3", token,
		map[string]any{"allow": permissions.ManageServer, "deny": 0})
	requireStatus(t, w, http.StatusOK)

	allow, _ := channelPerms(t, database, chID, 3)
	if allow != permissions.ManageServer {
		t.Errorf("allow = %#x, want %#x", allow, permissions.ManageServer)
	}
}

// The role-layer endpoint must refuse to write an override for a role at or
// above the actor's own position, even when the requested bits are within
// the actor's own mask — mirroring service.requireBelowActor.
func TestPutChannelPermission_RefusesEqualOrHigherRole(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")

	chID := mustCreateChannel(t, database, "hierarchy", "text")

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
			requireStatus(t, w, http.StatusForbidden)
		})
	}
}

// ─── DELETE /channels/{id}/permissions/{roleId} ──────────────────────────────

func TestDeleteChannelPermission_ClearsOverride(t *testing.T) {
	database, hub, inv, handler, token := newPermHarness(t)

	chID := mustCreateChannel(t, database, "secret5", "text")
	if err := database.UpsertChannelOverride(context.Background(), chID, 3, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	memberID := mustCreateUser(t, database, "role3clear", "hash", 3)

	w := doRequest(t, handler, http.MethodDelete,
		"/channels/"+itoa(chID)+"/permissions/3", token, nil)
	requireStatus(t, w, http.StatusNoContent)

	allow, deny := channelPerms(t, database, chID, 3)
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
	expectStatus(t, w, http.StatusNoContent)
}

// Deleting an override is a permission mutation: removing a deny row restores
// exactly the access the PUT path refuses to grant. The DELETE handler must
// therefore refuse targets at or above the actor's own position, mirroring
// TestPutChannelPermission_RefusesEqualOrHigherRole (A-2026-08-01).
func TestDeleteChannelPermission_RefusesEqualOrHigherRole(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")

	chID := mustCreateChannel(t, database, "hierarchy-del", "text")

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
			requireStatus(t, w, http.StatusForbidden)

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
	database, handler, token := newAdminHarness(t)

	chID := mustCreateChannel(t, database, "hierarchy-del-404", "text")

	w := doRequest(t, handler, http.MethodDelete,
		"/channels/"+itoa(chID)+"/permissions/999", token, nil)
	expectStatus(t, w, http.StatusNotFound)
}

// Clearing an override is a permission grant when it removes a deny bit the
// actor's own role does not hold: EffectivePerms = (rolePerm &^ deny) | allow,
// so wiping a deny row hands back exactly the access the PUT path refuses to
// grant (TestPutChannelPermission_ModeratorCannotEscalate). The DELETE
// handler must apply requireGrantableOverride to the override being REMOVED,
// not skip it just because the hierarchy guard alone passes.
func TestDeleteChannelPermission_EscalationGuard(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	// Helper role: low position, base permissions include MANAGE_MESSAGES.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (20, 'Helper', NULL, ?, 5, 0)`,
		permissions.ManageMessages,
	); err != nil {
		t.Fatalf("seed Helper role: %v", err)
	}

	// Actor: MANAGE_CHANNELS holder without MANAGE_MESSAGES or ADMINISTRATOR,
	// ranked above Helper so only the escalation guard is exercised.
	_, modToken := createRoleUser(t, database, 10, "Moderator", permissions.ManageChannels, 70, "moduser")

	chID := mustCreateChannel(t, database, "escalate-del", "text")
	if err := database.UpsertChannelOverride(context.Background(), chID, 20, 0, permissions.ManageMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	w := doRequest(t, handler, http.MethodDelete,
		"/channels/"+itoa(chID)+"/permissions/20", modToken, nil)
	requireStatus(t, w, http.StatusForbidden)

	allow, deny := channelPerms(t, database, chID, 20)
	if allow != 0 || deny != permissions.ManageMessages {
		t.Errorf("override mutated by forbidden delete: (%#x, %#x)", allow, deny)
	}
}

// A PUT with an all-zero mask that clears an existing deny bit the actor's
// own role does not hold is exactly as much an escalation as writing that
// bit directly (TestPutChannelPermission_ModeratorCannotEscalate): clearing a
// deny is a grant. requireGrantableOverride must see the bits being REMOVED
// by this write, not just the (trivially empty) bits being written.
func TestPutChannelPermission_ClearByZeroMaskEscalationGuard(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (20, 'Helper', NULL, ?, 5, 0)`,
		permissions.ManageMessages,
	); err != nil {
		t.Fatalf("seed Helper role: %v", err)
	}
	_, modToken := createRoleUser(t, database, 10, "Moderator", permissions.ManageChannels, 70, "moduser")

	chID := mustCreateChannel(t, database, "escalate-zero", "text")
	if err := database.UpsertChannelOverride(context.Background(), chID, 20, 0, permissions.ManageMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	w := doRequest(t, handler, http.MethodPut,
		"/channels/"+itoa(chID)+"/permissions/20", modToken,
		map[string]any{"allow": 0, "deny": 0})
	requireStatus(t, w, http.StatusForbidden)

	allow, deny := channelPerms(t, database, chID, 20)
	if allow != 0 || deny != permissions.ManageMessages {
		t.Errorf("override mutated by forbidden zero-mask PUT: (%#x, %#x)", allow, deny)
	}
}
