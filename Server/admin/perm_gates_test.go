package admin_test

// Route-level permission gates. The /admin/api perimeter admits any role
// holding a moderation bit; each group then re-checks the specific bit, so a
// Moderator can manage channels without being able to read settings, the audit
// log, or the owner-only routes.

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// moderatorMask is migration 001's seeded Moderator role: MANAGE_MESSAGES,
// MANAGE_CHANNELS, KICK_MEMBERS, BAN_MEMBERS (bits 16-19) and everything below.
const moderatorMask = int64(0x000FFFFF)

// createRoleUser upserts a role and a user holding it, returning the user id
// and a bearer token for that user's session.
func createRoleUser(t *testing.T, database *db.DB, roleID int64, name string, perms int64, position int, username string) (int64, string) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (?, ?, NULL, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		     name=excluded.name, permissions=excluded.permissions, position=excluded.position`,
		roleID, name, perms, position,
	); err != nil {
		t.Fatalf("seed role %s: %v", name, err)
	}
	uid, err := database.CreateUser(context.Background(), username, "$2a$12$placeholder", int(roleID))
	if err != nil {
		t.Fatalf("CreateUser %s: %v", username, err)
	}
	token := username + "-token-" + t.Name()
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession %s: %v", username, err)
	}
	return uid, token
}

// newModeratorHandler builds the admin API with a Moderator-role principal.
func newModeratorHandler(t *testing.T) (http.Handler, *db.DB, string) {
	t.Helper()
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, token := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")
	return handler, database, token
}

// ─── Perimeter ────────────────────────────────────────────────────────────────

func TestPerimeter_ModeratorAdmitted(t *testing.T) {
	handler, _, token := newModeratorHandler(t)

	// Perimeter-level routes: reachable with any moderation bit.
	for _, path := range []string{"/stats", "/users", "/me"} {
		if w := doRequest(t, handler, http.MethodGet, path, token, nil); w.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200; body: %s", path, w.Code, w.Body.String())
		}
	}
}

func TestPerimeter_NoModerationBitsRejected(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	// MANAGE_MESSAGES alone is not a perimeter bit — it has no admin route.
	_, token := createRoleUser(t, database, 11, "Helper", permissions.ManageMessages, 50, "helperuser")

	if w := doRequest(t, handler, http.MethodGet, "/stats", token, nil); w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
}

// ─── MANAGE_CHANNELS ──────────────────────────────────────────────────────────

func TestChannelRoutes_ModeratorAllowed(t *testing.T) {
	handler, _, token := newModeratorHandler(t)

	if w := doRequest(t, handler, http.MethodGet, "/channels", token, nil); w.Code != http.StatusOK {
		t.Fatalf("GET /channels = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, map[string]any{"name": "mod-made", "type": "text"})
	if w.Code != http.StatusCreated {
		t.Fatalf("POST /channels = %d, want 201; body: %s", w.Code, w.Body.String())
	}
	var created db.Channel
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal channel: %v", err)
	}
	if w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(created.ID), token,
		map[string]any{"name": "mod-renamed"}); w.Code != http.StatusOK {
		t.Errorf("PATCH /channels = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	// Channel-permission overrides ride the same gate.
	if w := doRequest(t, handler, http.MethodGet, "/channels/"+itoa(created.ID)+"/permissions", token, nil); w.Code != http.StatusOK {
		t.Errorf("GET channel permissions = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(created.ID), token, nil); w.Code != http.StatusNoContent {
		t.Errorf("DELETE /channels = %d, want 204; body: %s", w.Code, w.Body.String())
	}
}

// ─── BAN_MEMBERS reaches PATCH /users/{id} ───────────────────────────────────

// The ban path is authorized inside ModerationService, so the route must stay
// perimeter-level: gating it on ADMINISTRATOR (or on MANAGE_ROLES) would put
// banning out of a Moderator's reach entirely.
func TestPatchUserBan_ModeratorAllowed(t *testing.T) {
	handler, database, token := newModeratorHandler(t)
	targetUID, _ := database.CreateUser(context.Background(), "spammer", "hash", 3)

	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token,
		map[string]any{"banned": true, "ban_reason": "spam"})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	user, _ := database.GetUserByID(context.Background(), targetUID)
	if !user.Banned {
		t.Error("target should be banned")
	}
}

func TestChannelRoutes_WithoutManageChannelsForbidden(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, token := createRoleUser(t, database, 12, "Auditor", permissions.ViewAuditLog, 50, "auditoruser")

	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/channels"},
		{http.MethodPost, "/channels"},
		{http.MethodPatch, "/channels/1"},
		{http.MethodDelete, "/channels/1"},
		{http.MethodGet, "/channels/1/permissions"},
	} {
		if w := doRequest(t, handler, tc.method, tc.path, token, nil); w.Code != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403; body: %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}

// ─── VIEW_AUDIT_LOG / MANAGE_SERVER ──────────────────────────────────────────

func TestAuditAndSettings_ModeratorForbidden(t *testing.T) {
	handler, _, token := newModeratorHandler(t)

	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/audit-log"},
		{http.MethodGet, "/settings"},
		{http.MethodPatch, "/settings"},
		{http.MethodPost, "/logs/ticket"},
	} {
		if w := doRequest(t, handler, tc.method, tc.path, token, nil); w.Code != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403; body: %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}

func TestAuditAndSettings_BitHoldersAllowed(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, auditToken := createRoleUser(t, database, 12, "Auditor", permissions.ViewAuditLog, 50, "auditoruser")
	_, cfgToken := createRoleUser(t, database, 13, "Configurator", permissions.ManageServer, 50, "cfguser")

	if w := doRequest(t, handler, http.MethodGet, "/audit-log", auditToken, nil); w.Code != http.StatusOK {
		t.Errorf("GET /audit-log = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if w := doRequest(t, handler, http.MethodGet, "/settings", cfgToken, nil); w.Code != http.StatusOK {
		t.Errorf("GET /settings = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	// Each bit gates only its own group.
	if w := doRequest(t, handler, http.MethodGet, "/settings", auditToken, nil); w.Code != http.StatusForbidden {
		t.Errorf("auditor GET /settings = %d, want 403", w.Code)
	}
	if w := doRequest(t, handler, http.MethodGet, "/audit-log", cfgToken, nil); w.Code != http.StatusForbidden {
		t.Errorf("configurator GET /audit-log = %d, want 403", w.Code)
	}
}

// ─── Owner-only routes stay owner-only ───────────────────────────────────────

func TestOwnerOnlyRoutes_ModeratorForbidden(t *testing.T) {
	handler, _, token := newModeratorHandler(t)

	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/tokens"},
		{http.MethodPost, "/tokens"},
		{http.MethodGet, "/backups"},
		{http.MethodPost, "/backup"},
		{http.MethodGet, "/updates"},
		{http.MethodPost, "/updates/apply"},
	} {
		if w := doRequest(t, handler, tc.method, tc.path, token, nil); w.Code != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403; body: %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}

// TestOwnerOnlyControlsStayOwnerOnly extends TestOwnerOnlyRoutes_ModeratorForbidden
// with a narrower role than moderatorMask: a user holding ONLY
// MODERATE_MEMBERS|KICK_MEMBERS|BAN_MEMBERS|MUTE_MEMBERS (B5-9's new bit
// plus the pre-existing voice/ban/kick moderation bits, nothing else) is
// still refused on every TLS, backup and update route the admin panel
// gates owner-only — proven by test, not merely asserted alongside the
// permission ladder documentation (BPR-072). This role passes the
// perimeter (it holds KICK_MEMBERS/BAN_MEMBERS/MUTE_MEMBERS, all AdminPerimeter
// bits) but must still hit ownerOnlyMiddleware's refusal on every one of
// these routes.
func TestOwnerOnlyControlsStayOwnerOnly(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	narrowMask := permissions.ModerateMembers | permissions.KickMembers | permissions.BanMembers | permissions.MuteMembers
	_, token := createRoleUser(t, database, 15, "NarrowMod", narrowMask, 60, "narrowmoduser")

	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/tokens"},
		{http.MethodPost, "/tokens"},
		{http.MethodGet, "/backups"},
		{http.MethodPost, "/backup"},
		{http.MethodGet, "/updates"},
		{http.MethodPost, "/updates/apply"},
	} {
		if w := doRequest(t, handler, tc.method, tc.path, token, nil); w.Code != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403; body: %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}

// ─── KICK_MEMBERS (force logout) ─────────────────────────────────────────────

func TestForceLogout_RequiresKickMembers(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, token := createRoleUser(t, database, 14, "ChannelMod", permissions.ManageChannels, 60, "chanmoduser")

	targetUID, _ := database.CreateUser(context.Background(), "victim", "hash", 3)
	if _, err := database.CreateSession(context.Background(), targetUID, "victim-hash-perm", "web", "1.2.3.4"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(targetUID)+"/sessions", token, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	sessions, _ := database.GetUserSessions(context.Background(), targetUID)
	if len(sessions) != 1 {
		t.Errorf("sessions = %d, want 1 (refused call must not cut sessions)", len(sessions))
	}
}

func TestForceLogout_HierarchyEnforced(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, token := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")

	// Owner (role 1, position 100) outranks the moderator.
	ownerUID, err := database.CreateUser(context.Background(), "theowner", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser owner: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), ownerUID, "owner-hash-hier", "web", "1.2.3.4"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(ownerUID)+"/sessions", token, nil); w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	sessions, _ := database.GetUserSessions(context.Background(), ownerUID)
	if len(sessions) != 1 {
		t.Errorf("owner sessions = %d, want 1", len(sessions))
	}

	// A lower-ranked member is fair game.
	memberUID, _ := database.CreateUser(context.Background(), "amember", "hash", 3)
	if _, err := database.CreateSession(context.Background(), memberUID, "member-hash-hier", "web", "1.2.3.4"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(memberUID)+"/sessions", token, nil); w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body: %s", w.Code, w.Body.String())
	}
}

// ─── MANAGE_ROLES (role assignment) ──────────────────────────────────────────

func TestPatchUserRole_RequiresManageRoles(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	// The seeded Moderator mask stops at bit 19 — no MANAGE_ROLES (bit 24).
	_, token := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")
	targetUID, _ := database.CreateUser(context.Background(), "promoteme", "hash", 3)

	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, map[string]any{"role_id": 2})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	user, _ := database.GetUserByID(context.Background(), targetUID)
	if user.RoleID != 3 {
		t.Errorf("role_id = %d, want 3 (unchanged)", user.RoleID)
	}
}

func TestPatchUserRole_CannotPromoteToOwner(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	// Role 2 "Admin" (position 80) holds MANAGE_ROLES but is below Owner.
	_, token := createRoleUser(t, database, 2, "Admin", 0x3FFFFFFF, 80, "adminuser2")
	targetUID, _ := database.CreateUser(context.Background(), "wannabeowner", "hash", 3)

	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token,
		map[string]any{"role_id": permissions.OwnerRoleID})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	user, _ := database.GetUserByID(context.Background(), targetUID)
	if user.RoleID != 3 {
		t.Errorf("role_id = %d, want 3 (unchanged)", user.RoleID)
	}
}

func TestPatchUserRole_ModeratorCannotDemoteAdmin(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	// A moderator that does hold MANAGE_ROLES still cannot touch a higher rank.
	_, token := createRoleUser(t, database, 10, "Moderator", moderatorMask|permissions.ManageRoles, 60, "moduser")
	adminUID, err := database.CreateUser(context.Background(), "sitting-admin", "hash", 2)
	if err != nil {
		t.Fatalf("CreateUser admin: %v", err)
	}

	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(adminUID), token, map[string]any{"role_id": 3})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	user, _ := database.GetUserByID(context.Background(), adminUID)
	if user.RoleID != 2 {
		t.Errorf("role_id = %d, want 2 (unchanged)", user.RoleID)
	}
}

// ─── RequireAdminAuth (plugin admin routes) ──────────────────────────────────

// The exported gate wraps surfaces outside this package (api/router.go mounts
// the plugin admin handler behind it). Widening the panel perimeter must not
// widen those: they stay ADMINISTRATOR-only.
func TestRequireAdminAuth_StaysAdministratorOnly(t *testing.T) {
	database := openAdminTestDB(t)
	reached := false
	guarded := admin.RequireAdminAuth(service.NewSessionService(database))(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")
	ownerToken := createAdminUser(t, database)

	if w := doRequest(t, guarded, http.MethodGet, "/plugins", modToken, nil); w.Code != http.StatusForbidden {
		t.Errorf("moderator = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	if reached {
		t.Error("handler reached by a non-administrator")
	}
	if w := doRequest(t, guarded, http.MethodGet, "/plugins", ownerToken, nil); w.Code != http.StatusOK {
		t.Errorf("owner = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if !reached {
		t.Error("handler not reached by the owner")
	}
}

// ─── GET /me ─────────────────────────────────────────────────────────────────

func TestGetMe_ReportsCallerPermissions(t *testing.T) {
	handler, _, token := newModeratorHandler(t)

	w := doRequest(t, handler, http.MethodGet, "/me", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var me struct {
		Username     string `json:"username"`
		RoleName     string `json:"role_name"`
		RolePosition int    `json:"role_position"`
		Permissions  int64  `json:"permissions"`
		IsOwner      bool   `json:"is_owner"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatalf("unmarshal me: %v", err)
	}
	if me.Username != "moduser" || me.RoleName != "Moderator" {
		t.Errorf("me = %+v, want moduser/Moderator", me)
	}
	if me.Permissions != moderatorMask {
		t.Errorf("permissions = %#x, want %#x", me.Permissions, moderatorMask)
	}
	if me.RolePosition != 60 || me.IsOwner {
		t.Errorf("role_position = %d, is_owner = %v; want 60/false", me.RolePosition, me.IsOwner)
	}
}

func TestGetMe_OwnerFlagged(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/me", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var me struct {
		IsOwner bool `json:"is_owner"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatalf("unmarshal me: %v", err)
	}
	if !me.IsOwner {
		t.Error("is_owner = false for the Owner role")
	}
}
