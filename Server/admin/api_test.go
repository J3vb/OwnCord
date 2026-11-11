package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/migrations"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// newTestModService builds a real ModerationService over the test database so
// PATCH-user ban paths exercise the production authorization (BAN_MEMBERS +
// role hierarchy) instead of a stub.
func newTestModService(database *db.DB) *service.ModerationService {
	st := database
	checker := permissions.NewChecker(st)
	return service.NewModerationService(st, service.NewPermissionService(st, checker))
}

// newTestChannelService builds a real ChannelService over the test database
// so the channel routes exercise the same S-03/S-04 policy production runs.
func newTestChannelService(database *db.DB) *service.ChannelService {
	return service.NewChannelService(database, service.NewPermissionService(database, nil))
}

// newTestSettingsService builds a real SettingsService over the test
// database so the settings routes exercise the same policy production runs.
func newTestSettingsService(database *db.DB) *service.SettingsService {
	return service.NewSettingsService(database)
}

// newTestRoleService builds a real RoleService over the test database so the
// role routes exercise the production authorization (MANAGE_ROLES + hierarchy)
// instead of a stub.
func newTestRoleService(database *db.DB) *service.RoleService {
	st := database
	checker := permissions.NewChecker(st)
	return service.NewRoleService(st, service.NewPermissionService(st, checker))
}

// permObserver is the invalidation sink the wired test services report to.
type permObserver interface {
	InvalidateUser(userID int64)
	InvalidateAll()
}

// observeInvalidations reports every eviction p issues to inv (nil: none).
func observeInvalidations(p *service.PermissionService, inv permObserver) *service.PermissionService {
	if inv != nil {
		p.SetInvalidationObserver(func(userID int64, all bool) {
			if all {
				inv.InvalidateAll()
				return
			}
			inv.InvalidateUser(userID)
		})
	}
	return p
}

// newTestServicesFor is newTestServices wired the way the composition root
// wires production (WP 5.1a): the role, channel and moderation services own
// permission-cache invalidation and the live fan-out, so a test that watches
// the hub or the invalidation log installs them here. hub receives the
// fan-out; inv (may be nil) is told of every eviction the services issue, in
// the same order and with the same ids the handlers used to send it.
func newTestServicesFor(database *db.DB, hub service.PermissionChangeNotifier, inv permObserver) *service.Services {
	observe := func(p *service.PermissionService) *service.PermissionService {
		return observeInvalidations(p, inv)
	}
	checker := permissions.NewChecker(database)
	mod := service.NewModerationService(database, observe(service.NewPermissionService(database, checker)))
	roles := service.NewRoleService(database, observe(service.NewPermissionService(database, checker)))
	channels := service.NewChannelService(database, observe(service.NewPermissionService(database, nil)))
	mod.SetPermissionNotifier(hub)
	roles.SetPermissionNotifier(hub)
	channels.SetPermissionNotifier(hub)
	svc := newTestServices(database)
	svc.Moderation, svc.Roles, svc.Channels = mod, roles, channels
	return svc
}

// newTestServices bundles the services NewAdminAPI routes to, each a real one
// over the test database so the routes exercise production authorization
// rather than stubs. Tests that need a service absent (the fail-closed rows)
// build the bundle and nil the one field they mean.
func newTestServices(database *db.DB) *service.Services {
	return &service.Services{
		Moderation: newTestModService(database),
		Roles:      newTestRoleService(database),
		Settings:   newTestSettingsService(database),
		Channels:   newTestChannelService(database),
		Users:      service.NewUserService(database),
		Tokens:     service.NewTokenService(database),
		Sessions:   service.NewSessionService(database),
		Auth:       service.NewAuthService(database, auth.NewRateLimiter(), nil, nil),
	}
}

// svcWithRoles is newTestServices with a caller-supplied RoleService, for the
// rows that need to observe or substitute that one service.
func svcWithRoles(database *db.DB, roles *service.RoleService) *service.Services {
	svc := newTestServices(database)
	svc.Roles = roles
	return svc
}

// openAdminTestDB opens a fresh in-memory database for admin API tests.
func openAdminTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	// 001's seeded Admin and Moderator carry bit 14 as an unused bit; migration
	// 081 clears it, and a real server has run it (WP 8.4c), so the fixture
	// applies the shipped file rather than a copy of its statement.
	manageBackups, err := migrations.FS.ReadFile("081_manage_backups.sql")
	if err != nil {
		t.Fatalf("read 081_manage_backups.sql: %v", err)
	}
	// 082 clears the seven owner-type bits (WP 8.4d) the same way.
	ownerTypeBits, err := migrations.FS.ReadFile("082_owner_type_permissions.sql")
	if err != nil {
		t.Fatalf("read 082_owner_type_permissions.sql: %v", err)
	}
	migrFS := fstest.MapFS{
		"001_initial_schema.sql":         {Data: adminSchema},
		"081_manage_backups.sql":         {Data: manageBackups},
		"082_owner_type_permissions.sql": {Data: ownerTypeBits},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// createAdminUser creates an Owner-role user and returns a valid bearer token.
func createAdminUser(t *testing.T, database *db.DB) string {
	t.Helper()
	// Owner role has permissions = 2147483647 (includes ADMINISTRATOR bit 0x40000000)
	uid := mustCreateUser(t, database, "adminuser", "$2a$12$placeholder", 1)

	token := "test-admin-token-" + t.Name()
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(context.Background(), uid, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return token
}

// createMemberUser creates a Member-role user and returns a valid bearer token.
func createMemberUser(t *testing.T, database *db.DB) string {
	t.Helper()
	// Member role (id=3) has limited permissions, not ADMINISTRATOR
	uid := mustCreateUser(t, database, "memberuser", "$2a$12$placeholder", 3)

	token := "test-member-token-" + t.Name()
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(context.Background(), uid, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return token
}

func doRequest(t *testing.T, handler http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var bodyBytes []byte
	if body != nil {
		var err error
		bodyBytes, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("json.Marshal body: %v", err)
		}
	}

	req := httptest.NewRequest(method, path, bytes.NewReader(bodyBytes))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

// ─── GET /admin/api/stats ─────────────────────────────────────────────────────

func TestAdminAPI_Stats_OK(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodGet, "/stats", token, nil)

	expectStatus(t, w, http.StatusOK)

	stats := decodeBody[map[string]any](t, w)
	if _, ok := stats["user_count"]; !ok {
		t.Error("response missing 'user_count'")
	}
	if _, ok := stats["message_count"]; !ok {
		t.Error("response missing 'message_count'")
	}
}

func TestAdminAPI_Stats_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodGet, "/stats", "", nil)

	expectStatus(t, w, http.StatusUnauthorized)
}

func TestAdminAPI_Stats_Forbidden(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createMemberUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/stats", token, nil)

	expectStatus(t, w, http.StatusForbidden)
}

// ─── GET /admin/api/users ─────────────────────────────────────────────────────

func TestAdminAPI_ListUsers_OK(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodGet, "/users?limit=50&offset=0", token, nil)

	expectStatus(t, w, http.StatusOK)

	users := decodeBody[[]any](t, w)
	// At least the admin user we created
	if len(users) < 1 {
		t.Error("expected at least 1 user in response")
	}
}

func TestAdminAPI_ListUsers_DefaultPagination(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	// No query params — should use defaults
	w := doRequest(t, handler, http.MethodGet, "/users", token, nil)

	expectStatus(t, w, http.StatusOK)
}

func TestAdminAPI_ListUsers_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodGet, "/users", "", nil)

	expectStatus(t, w, http.StatusUnauthorized)
}

// ─── PATCH /admin/api/users/{id} ─────────────────────────────────────────────

// TestAdminAPI_PatchUser_BanHierarchy locks the W1-4 fix: the admin-auth
// perimeter alone no longer authorizes bans — ModerationService's role
// hierarchy runs on the live PATCH path, so an admin-panel actor cannot ban
// an equal- or higher-ranked user (previously any panel actor could ban the
// owner via the raw UPDATE).
func TestAdminAPI_PatchUser_BanHierarchy(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	ownerToken := createAdminUser(t, database) // Owner role (pos 100)

	// A second owner-rank user: equal position, cannot be banned.
	peerUID := mustCreateUser(t, database, "peerowner", "$2a$12$placeholder", 1)
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(peerUID), ownerToken,
		map[string]any{"banned": true})
	requireStatus(t, w, http.StatusForbidden)
	if u, _ := database.GetUserByID(context.Background(), peerUID); u.Banned {
		t.Fatal("equal-rank target must not be banned")
	}

	// A lower-positioned role that still holds ADMINISTRATOR (panel access):
	// its holder must not be able to ban the higher-ranked owner.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (9, 'JuniorAdmin', ?, 50, 0)`,
		permissions.Administrator,
	); err != nil {
		t.Fatalf("inserting junior admin role: %v", err)
	}
	juniorUID := mustCreateUser(t, database, "junioradmin", "$2a$12$placeholder", 9)
	juniorToken := "junior-token-" + t.Name()
	if _, err := database.CreateSession(context.Background(), juniorUID, auth.HashToken(juniorToken), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession junior: %v", err)
	}
	ownerUser, err := database.GetUserByUsername(context.Background(), "adminuser")
	if err != nil || ownerUser == nil {
		t.Fatalf("GetUserByUsername adminuser: %v", err)
	}
	w = doRequest(t, handler, http.MethodPatch, "/users/"+itoa(ownerUser.ID), juniorToken,
		map[string]any{"banned": true})
	requireStatus(t, w, http.StatusForbidden)
	if u, _ := database.GetUserByID(context.Background(), ownerUser.ID); u.Banned {
		t.Fatal("owner must not be banned by a lower rank")
	}

	// Downward ban still works: junior admin (pos 50) bans a member (pos 40).
	memberUID := mustCreateUser(t, database, "banme", "$2a$12$placeholder", 3)
	w = doRequest(t, handler, http.MethodPatch, "/users/"+itoa(memberUID), juniorToken,
		map[string]any{"banned": true, "ban_reason": "spam"})
	requireStatus(t, w, http.StatusOK)
	if u, _ := database.GetUserByID(context.Background(), memberUID); !u.Banned {
		t.Fatal("member should be banned by higher-ranked actor")
	}
}

func TestAdminAPI_PatchUser_BanUser(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	// Create a target user
	targetUID := mustCreateUser(t, database, "target", "hash", 3)

	body := map[string]any{
		"banned":     true,
		"ban_reason": "spam",
	}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	expectStatus(t, w, http.StatusOK)

	// Verify user is banned in DB
	user, err := database.GetUserByID(context.Background(), targetUID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !user.Banned {
		t.Error("user should be banned after PATCH")
	}
}

func TestAdminAPI_PatchUser_ChangeRole(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	targetUID := mustCreateUser(t, database, "rolechange", "hash", 3)

	body := map[string]any{
		"role_id": float64(2),
	}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	expectStatus(t, w, http.StatusOK)

	user, _ := database.GetUserByID(context.Background(), targetUID)
	if user.RoleID != 2 {
		t.Errorf("RoleID = %d, want 2", user.RoleID)
	}
}

func TestAdminAPI_PatchUser_NotFound(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	body := map[string]any{"banned": true}
	w := doRequest(t, handler, http.MethodPatch, "/users/99999", token, body)

	expectStatus(t, w, http.StatusNotFound)
}

func TestAdminAPI_PatchUser_InvalidID(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodPatch, "/users/abc", token, nil)

	expectStatus(t, w, http.StatusBadRequest)
}

// ─── DELETE /admin/api/users/{id}/sessions ────────────────────────────────────

func TestAdminAPI_ForceLogout_OK(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	targetUID := mustCreateUser(t, database, "logoutme", "hash", 3)
	_, _ = database.CreateSession(context.Background(), targetUID, "victim-token-hash", "web", "1.2.3.4")

	w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(targetUID)+"/sessions", token, nil)

	expectStatus(t, w, http.StatusNoContent)

	sessions, _ := database.GetUserSessions(context.Background(), targetUID)
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after force logout, got %d", len(sessions))
	}
}

func TestAdminAPI_ForceLogout_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodDelete, "/users/1/sessions", "", nil)

	expectStatus(t, w, http.StatusUnauthorized)
}

// ─── GET /admin/api/audit-log ─────────────────────────────────────────────────

func TestAdminAPI_AuditLog_OK(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	uid := mustCreateUser(t, database, "actor", "hash", 1)
	_ = database.LogAudit(context.Background(), uid, "TEST_ACTION", "user", uid, "detail")

	w := doRequest(t, handler, http.MethodGet, "/audit-log?limit=10&offset=0", token, nil)

	expectStatus(t, w, http.StatusOK)

	entries := decodeBody[[]any](t, w)
	if len(entries) != 1 {
		t.Errorf("expected 1 entry, got %d", len(entries))
	}
}

func TestAdminAPI_AuditLog_Empty(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodGet, "/audit-log", token, nil)

	expectStatus(t, w, http.StatusOK)

	entries := decodeBody[[]any](t, w)
	if len(entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(entries))
	}
}

// ─── POST /admin/api/backup ───────────────────────────────────────────────────

func TestAdminAPI_Backup_RequiresOwner(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	// Admin (role 2) can authenticate but is not Owner (role 1, position 100)
	adminUID := mustCreateUser(t, database, "adminonly", "hash", 2)
	token := "admin-only-token"
	_, _ = database.CreateSession(context.Background(), adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/backup", token, nil)

	// Should be forbidden — not Owner role
	expectStatus(t, w, http.StatusForbidden)
}

func TestAdminAPI_Backup_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodPost, "/backup", "", nil)

	expectStatus(t, w, http.StatusUnauthorized)
}

// ─── Task 0.3: actor stored in context ───────────────────────────────────────

// TestAdminAPI_ActorFromContext verifies that after auth middleware runs, the
// user ID surfaced by audit log entries comes from the context-stored user (not
// a redundant DB lookup). We exercise this through the PATCH /users/{id} path
// which logs an audit entry containing the actor_id.
func TestAdminAPI_ActorFromContext_AuditEntry(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	// Create a target user to act on.
	targetUID := mustCreateUser(t, database, "ctxtarget", "hash", 3)

	body := map[string]any{"banned": true, "ban_reason": "context test"}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	requireStatus(t, w, http.StatusOK)

	// The audit log should have a non-zero actor_id showing the actor was
	// resolved (not 0, which would indicate a failed context lookup).
	entries, err := database.GetAuditLog(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("expected at least 1 audit entry")
	}
	// All entries should have a non-zero actor_id.
	for _, e := range entries {
		if e.ActorID == 0 {
			t.Errorf("audit entry actor_id = 0, expected the admin user's ID (actor stored from context)")
		}
	}
}

// TestAdminAPI_ActorFromContext_ForceLogout exercises actorFromContext via the
// DELETE /users/{id}/sessions path.
func TestAdminAPI_ActorFromContext_ForceLogout(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	targetUID := mustCreateUser(t, database, "logoutctx", "hash", 3)
	_, _ = database.CreateSession(context.Background(), targetUID, "victim-hash-ctx", "web", "1.2.3.4")

	w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(targetUID)+"/sessions", token, nil)

	requireStatus(t, w, http.StatusNoContent)

	entries, err := database.GetAuditLog(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("expected at least 1 audit entry")
	}
	for _, e := range entries {
		if e.ActorID == 0 {
			t.Errorf("audit entry actor_id = 0, expected non-zero actor from context")
		}
	}
}

// ─── Fix 2.1: Sensitive field redaction ──────────────────────────────────────

// TestAdminAPI_ListUsers_NoPasswordHash verifies that GET /users does not
// expose the PasswordHash field in any returned user object.
func TestAdminAPI_ListUsers_NoPasswordHash(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	// Create a second user so the list is non-trivial.
	_, _ = database.CreateUser(context.Background(), "plainuser", "supersecretbcrypthash", 3)

	w := doRequest(t, handler, http.MethodGet, "/users", token, nil)

	requireStatus(t, w, http.StatusOK)

	body := w.Body.String()
	// The raw bcrypt hash must never appear in the response.
	if strings.Contains(body, "supersecretbcrypthash") {
		t.Error("GET /users response contains PasswordHash — sensitive field leaked")
	}
	// The JSON key itself must also be absent.
	if strings.Contains(body, "password_hash") || strings.Contains(body, "PasswordHash") {
		t.Error("GET /users response contains password_hash key — sensitive field leaked")
	}
}

// TestAdminAPI_ListUsers_NoTOTPSecret verifies that GET /users does not
// expose the TOTPSecret field.
func TestAdminAPI_ListUsers_NoTOTPSecret(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodGet, "/users", token, nil)

	requireStatus(t, w, http.StatusOK)

	body := w.Body.String()
	if strings.Contains(body, "totp_secret") || strings.Contains(body, "TOTPSecret") {
		t.Error("GET /users response contains totp_secret key — sensitive field leaked")
	}
}

// TestAdminAPI_ListUsers_PublicFieldsPresent verifies that safe public fields
// are still present after the sensitive-field removal.
func TestAdminAPI_ListUsers_PublicFieldsPresent(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodGet, "/users", token, nil)

	requireStatus(t, w, http.StatusOK)

	users := decodeBody[[]map[string]any](t, w)
	if len(users) == 0 {
		t.Fatal("expected at least one user")
	}

	u := users[0]
	for _, field := range []string{"id", "username", "status", "role_id", "created_at", "banned", "role_name"} {
		if _, ok := u[field]; !ok {
			t.Errorf("GET /users response user object missing expected field %q", field)
		}
	}
}

// TestAdminAPI_PatchUser_NoPasswordHash verifies that PATCH /users/{id} does
// not expose PasswordHash in the returned user object.
func TestAdminAPI_PatchUser_NoPasswordHash(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	targetUID := mustCreateUser(t, database, "patchvictim", "topsecretbcrypt", 3)

	body := map[string]any{
		"banned":     true,
		"ban_reason": "test",
	}
	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, body)

	requireStatus(t, w, http.StatusOK)

	respBody := w.Body.String()
	if strings.Contains(respBody, "topsecretbcrypt") {
		t.Error("PATCH /users/{id} response contains PasswordHash — sensitive field leaked")
	}
	if strings.Contains(respBody, "password_hash") || strings.Contains(respBody, "PasswordHash") {
		t.Error("PATCH /users/{id} response contains password_hash key — sensitive field leaked")
	}
}

// TestAdminAPI_PatchUser_NoTOTPSecret verifies that PATCH /users/{id} does
// not expose TOTPSecret in the returned user object.
func TestAdminAPI_PatchUser_NoTOTPSecret(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	targetUID := mustCreateUser(t, database, "patchtotp", "hash", 3)

	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(targetUID), token, map[string]any{
		"banned": false,
	})

	requireStatus(t, w, http.StatusOK)

	respBody := w.Body.String()
	if strings.Contains(respBody, "totp_secret") || strings.Contains(respBody, "TOTPSecret") {
		t.Error("PATCH /users/{id} response contains totp_secret — sensitive field leaked")
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// itoa converts an int64 to a string for use in URL paths.
func itoa(n int64) string {
	return fmt.Sprint(n)
}

// TestAdminAPI_NilServiceBundleFailsClosed pins the distinction
// adminRequiredServices draws. A nil service the ROUTER dereferences has no
// request-time branch left to fail closed in — the handler would panic on the
// first request — so the constructor builds those from the handle it already
// holds. A nil service only a HANDLER dereferences stays nil, because the
// handler checks it and answers 500; those refusals are pinned elsewhere and
// must keep being exercised.
//
// Reported by a review bot on the user and auth families: /stats, /users and
// /tokens had moved off the raw handle without the guard moving with them, so
// the fail-closed posture this constructor documents had quietly stopped being
// true for exactly those routes.
func TestAdminAPI_NilServiceBundleFailsClosed(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, nil)
	token := createAdminUser(t, database) // Owner role — reaches the token routes too

	for _, tc := range []struct {
		name, method, path string
		body               any
	}{
		{"stats", http.MethodGet, "/stats", nil},
		{"users", http.MethodGet, "/users", nil},
		{"tokens", http.MethodGet, "/tokens", nil},
		{"setup status", http.MethodGet, "/setup/status", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// A panic here fails the test outright, which is the point: the
			// route must answer something, whatever it answers.
			w := doRequest(t, handler, tc.method, tc.path, token, tc.body)
			if w.Code >= 500 {
				t.Errorf("%s %s = %d with a nil bundle; want a real answer, not a server fault: %s",
					tc.method, tc.path, w.Code, w.Body.String())
			}
		})
	}
}
