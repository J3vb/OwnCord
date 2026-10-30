package admin_test

// Route-level permission gates. The /admin/api perimeter admits any role
// holding a moderation bit; each group then re-checks the specific bit, so a
// Moderator can manage channels without being able to read settings, the audit
// log, or the owner-only routes.

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// moderatorMask is migration 001's seeded Moderator role after migrations 081
// and 082: MANAGE_MESSAGES, MANAGE_CHANNELS, KICK_MEMBERS, BAN_MEMBERS (bits
// 16-19) and everything below, except the unused bits 2, 3, 4, 7, 8, 14 and 15
// that 081 and 082 clear (they are owner-type permissions now, which the seeded
// Moderator must not hold).
const moderatorMask = int64(0x000F3E63)

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
		{http.MethodGet, "/config"},
		{http.MethodPost, "/logs/ticket"},
		{http.MethodGet, "/logs/level"},
		{http.MethodPatch, "/logs/level"},
		{http.MethodDelete, "/logs/level"},
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
		{http.MethodGet, "/config/settings"},
		{http.MethodPost, "/restart"},
		{http.MethodGet, "/archive"},
		{http.MethodPost, "/users/1/recovery-credential"},
	} {
		if w := doRequest(t, handler, tc.method, tc.path, token, nil); w.Code != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403; body: %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}

// ownerOnlyRoutePathParam replaces every {param} segment in a route pattern
// with a harmless literal, so a request can actually be dispatched to it —
// the literal value never matters to ownerOnlyMiddleware, which runs before
// any handler touches the param.
var ownerOnlyRoutePathParam = regexp.MustCompile(`\{[^}]+\}`)

// expectedOwnerOnlyRoutes is the exact, literal inventory of routes wired
// behind ownerOnly alone. It is empty since WP 8.4d: the last owner-only routes
// (tokens, recovery credentials, updates, config, restore, delete and archive)
// became owner-or-bit routes in expectedGatedRoutes. What stays owner-only is
// a settings KEY check, not a route: the backup schedule and retention
// (TestBackupPolicySettings_NonOwnerForbidden). The registry and its middleware
// remain for the next route that is owner-only, and the empty inventory is
// compared EXACTLY so a route added to it fails here until it is listed.
var expectedOwnerOnlyRoutes = []admin.OwnerOnlyRoute{}

// gateExpectation is what one gate lets through, for the walk in
// TestGatedRoutes: the single bits whose holder passes, and whether an
// Administrator who lacks the bit passes too (true for the administrator tier
// and the older MANAGE_BACKUPS gate, false for the owner tier).
type gateExpectation struct {
	holders     []int64
	adminPasses bool
}

var gateExpectations = map[string]gateExpectation{
	"manage_backups":   {holders: []int64{permissions.ManageBackups}, adminPasses: true},
	"list_backups":     {holders: []int64{permissions.ManageBackups, permissions.RestoreBackups}, adminPasses: true},
	"restore_backups":  {holders: []int64{permissions.RestoreBackups}},
	"manage_config":    {holders: []int64{permissions.ManageConfig}},
	"manage_updates":   {holders: []int64{permissions.ManageUpdates}},
	"manage_tokens":    {holders: []int64{permissions.ManageTokens}},
	"issue_recovery":   {holders: []int64{permissions.IssueRecovery}},
	"view_diagnostics": {holders: []int64{permissions.ViewDiagnostics}, adminPasses: true},
	"erase_accounts":   {holders: []int64{permissions.EraseAccounts}, adminPasses: true},
}

// expectedGatedRoutes is the exact inventory of routes behind a routeGate
// (WP 8.4d, generalising 8.4c's owner-or-MANAGE_BACKUPS list): owner-tier
// routes the owner or an explicit holder reaches (an Administrator does not),
// and administrator-tier routes an Administrator or a holder reaches.
var expectedGatedRoutes = []admin.GatedRoute{
	{Method: http.MethodPost, Pattern: "/backup", Gate: "manage_backups"},
	{Method: http.MethodPost, Pattern: "/backups/{name}/link", Gate: "manage_backups"},
	{Method: http.MethodGet, Pattern: "/backups", Gate: "list_backups"},
	{Method: http.MethodDelete, Pattern: "/backups/{name}", Gate: "restore_backups"},
	{Method: http.MethodPost, Pattern: "/backups/{name}/restore", Gate: "restore_backups"},
	{Method: http.MethodGet, Pattern: "/archive", Gate: "restore_backups"},
	{Method: http.MethodPost, Pattern: "/archive/link", Gate: "restore_backups"},
	{Method: http.MethodGet, Pattern: "/config/settings", Gate: "manage_config"},
	{Method: http.MethodPatch, Pattern: "/config/settings", Gate: "manage_config"},
	{Method: http.MethodPost, Pattern: "/restart", Gate: "manage_config"},
	{Method: http.MethodGet, Pattern: "/updates", Gate: "manage_updates"},
	{Method: http.MethodPost, Pattern: "/updates/apply", Gate: "manage_updates"},
	{Method: http.MethodGet, Pattern: "/tokens", Gate: "manage_tokens"},
	{Method: http.MethodPost, Pattern: "/tokens", Gate: "manage_tokens"},
	{Method: http.MethodDelete, Pattern: "/tokens/{id}", Gate: "manage_tokens"},
	{Method: http.MethodPost, Pattern: "/users/{id}/recovery-credential", Gate: "issue_recovery"},
	{Method: http.MethodPost, Pattern: "/logs/ticket", Gate: "view_diagnostics"},
	{Method: http.MethodGet, Pattern: "/logs/level", Gate: "view_diagnostics"},
	{Method: http.MethodPatch, Pattern: "/logs/level", Gate: "view_diagnostics"},
	{Method: http.MethodDelete, Pattern: "/logs/level", Gate: "view_diagnostics"},
	{Method: http.MethodPost, Pattern: "/support-bundles/preview", Gate: "view_diagnostics"},
	{Method: http.MethodPost, Pattern: "/support-bundles/download", Gate: "view_diagnostics"},
	{Method: http.MethodGet, Pattern: "/attention", Gate: "view_diagnostics"},
	{Method: http.MethodGet, Pattern: "/system/stats", Gate: "view_diagnostics"},
	{Method: http.MethodDelete, Pattern: "/users/{id}", Gate: "erase_accounts"},
}

// sortedGatedRoutes returns a copy of routes sorted by (Method, Pattern).
func sortedGatedRoutes(routes []admin.GatedRoute) []admin.GatedRoute {
	sorted := slices.Clone(routes)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Method != sorted[j].Method {
			return sorted[i].Method < sorted[j].Method
		}
		return sorted[i].Pattern < sorted[j].Pattern
	})
	return sorted
}

// sortedOwnerOnlyRoutes returns a copy of routes sorted by (Method, Pattern)
// so two route lists can be compared regardless of registration order.
func sortedOwnerOnlyRoutes(routes []admin.OwnerOnlyRoute) []admin.OwnerOnlyRoute {
	sorted := append([]admin.OwnerOnlyRoute(nil), routes...)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Method != sorted[j].Method {
			return sorted[i].Method < sorted[j].Method
		}
		return sorted[i].Pattern < sorted[j].Pattern
	})
	return sorted
}

// TestBackupPolicySettings_NonOwnerForbidden pins BPR-072: the backup policy
// is owner-only even though PATCH /settings otherwise only needs MANAGE_SERVER.
// A MANAGE_SERVER holder and an ADMINISTRATOR that is not the Owner must both
// get 403 when the request carries backup_schedule or backup_retention, while
// the Owner and a plain setting both succeed — so the refusal is the owner
// check on those keys, not a route that rejects everyone.
func TestBackupPolicySettings_NonOwnerForbidden(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, manageToken := createRoleUser(t, database, 20, "ServerAdmin", permissions.ManageServer, 50, "serveradminuser")
	_, adminToken := createRoleUser(t, database, 21, "Administrator", permissions.Administrator, 90, "administratoruser")
	_, ownerToken := createRoleUser(t, database, permissions.OwnerRoleID, "Owner", permissions.Administrator, 100, "backuppolicyowner")

	validValue := map[string]string{"backup_schedule": "daily", "backup_retention": "30"}
	for _, key := range []string{"backup_schedule", "backup_retention"} {
		for _, tc := range []struct {
			name  string
			token string
		}{
			{"MANAGE_SERVER non-owner", manageToken},
			{"ADMINISTRATOR non-owner", adminToken},
		} {
			w := doRequest(t, handler, http.MethodPatch, "/settings", tc.token, map[string]string{key: validValue[key]})
			if w.Code != http.StatusForbidden {
				t.Errorf("%s PATCH %s = %d, want 403; body: %s", tc.name, key, w.Code, w.Body.String())
			}
		}
		// Positive control: the Owner may set it.
		w := doRequest(t, handler, http.MethodPatch, "/settings", ownerToken, map[string]string{key: validValue[key]})
		if w.Code != http.StatusOK {
			t.Errorf("Owner PATCH %s = %d, want 200; body: %s", key, w.Code, w.Body.String())
		}
	}

	// Positive control: the same MANAGE_SERVER token succeeds on an ordinary
	// setting, proving the 403s above are the owner-only key gate.
	if w := doRequest(t, handler, http.MethodPatch, "/settings", manageToken, map[string]string{"motd": "hello"}); w.Code != http.StatusOK {
		t.Errorf("MANAGE_SERVER PATCH motd = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}

// TestBackupPolicySettings_BoundedRetention rejects out-of-range backup
// retention values before they reach the maintenance sweep.
func TestBackupPolicySettings_BoundedRetention(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, ownerToken := createRoleUser(t, database, permissions.OwnerRoleID, "Owner", permissions.Administrator, 100, "retentionowner")

	for _, value := range []string{"1", "6", "banana", "-1", "99999"} {
		w := doRequest(t, handler, http.MethodPatch, "/settings", ownerToken, map[string]string{"backup_retention": value})
		if w.Code != http.StatusBadRequest {
			t.Errorf("PATCH backup_retention=%q = %d, want 400; body: %s", value, w.Code, w.Body.String())
		}
	}
	for _, value := range []string{"0", "7", "3650"} {
		w := doRequest(t, handler, http.MethodPatch, "/settings", ownerToken, map[string]string{"backup_retention": value})
		if w.Code != http.StatusOK {
			t.Errorf("PATCH backup_retention=%q = %d, want 200; body: %s", value, w.Code, w.Body.String())
		}
	}
}

// TestOwnerOnlyControlsStayOwnerOnly extends TestOwnerOnlyRoutes_ModeratorForbidden
// by walking the ACTUAL set of owner-only routes NewAdminAPI wires
// (admin.OwnerOnlyRoutesForTest) instead of a hand-listed subset (P2-13,
// Codex review: the previous version of this test hard-coded six routes and
// had already drifted, missing backup delete and restore). It is compared
// against expectedOwnerOnlyRoutes EXACTLY (P2-13 PARTIAL, round 3) rather
// than a vacuity guard, so both a shrunk inventory and a swapped or
// unexpectedly added route fail loudly. For each route: a
// narrow-but-AdminPerimeter role (MODERATE_MEMBERS|KICK_MEMBERS|
// BAN_MEMBERS|MUTE_MEMBERS, none of them owner-only) is refused with 403,
// and a POSITIVE CONTROL — an actual Owner-role user — is never refused
// with 403, proving the walk exercises ownerOnlyMiddleware's real gate
// rather than routes that would 403 (or 404, or panic) for everyone
// regardless of role. SetupOptions.BackupDir points the two backup routes
// with real filesystem effects at a temp dir so the Owner's requests stay
// hermetic.
func TestOwnerOnlyControlsStayOwnerOnly(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{BackupDir: t.TempDir()})

	routes := admin.OwnerOnlyRoutesForTest(handler)
	got, want := sortedOwnerOnlyRoutes(routes), sortedOwnerOnlyRoutes(expectedOwnerOnlyRoutes)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("admin.OwnerOnlyRoutesForTest() = %+v, want exactly %+v", got, want)
	}

	narrowMask := permissions.ModerateMembers | permissions.KickMembers | permissions.BanMembers | permissions.MuteMembers
	_, modToken := createRoleUser(t, database, 15, "NarrowMod", narrowMask, 60, "narrowmoduser")
	_, ownerToken := createRoleUser(t, database, permissions.OwnerRoleID, "Owner", permissions.Administrator, 100, "realowneruser")

	for _, route := range routes {
		path := ownerOnlyRoutePathParam.ReplaceAllString(route.Pattern, "x")
		t.Run(route.Method+" "+route.Pattern, func(t *testing.T) {
			if w := doRequest(t, handler, route.Method, path, modToken, nil); w.Code != http.StatusForbidden {
				t.Errorf("%s %s (narrow AdminPerimeter role) = %d, want 403; body: %s", route.Method, path, w.Code, w.Body.String())
			}
			if w := doRequest(t, handler, route.Method, path, ownerToken, nil); w.Code == http.StatusForbidden {
				t.Errorf("%s %s (Owner) = 403, want anything but 403 — ownerOnlyMiddleware must admit an actual Owner", route.Method, path)
			}
		})
	}

	// Positive control (Codex review): every case above asserts 403 for
	// modToken, which a blanket "reject everything" perimeter bug would
	// satisfy just as well as a correct ownerOnlyMiddleware — proving
	// nothing about whether it is the OWNER check specifically doing the
	// refusing. NarrowMod's mask (KickMembers, BanMembers, MuteMembers) is
	// all AdminPerimeter membership, and GET /me sits behind the perimeter
	// alone with no further requirePerm — so the SAME narrow-role token
	// that gets 403 on every owner-only route above must be admitted here.
	if w := doRequest(t, handler, http.MethodGet, "/me", modToken, nil); w.Code == http.StatusForbidden {
		t.Fatalf("GET /me (narrow AdminPerimeter role) = 403, want admitted — "+
			"the owner-only routes' 403s must come from ownerOnlyMiddleware, not a perimeter that rejects everything; body: %s", w.Body.String())
	}
}

// TestGatedRoutes walks the routes NewAdminAPI wires behind a routeGate
// (admin.GatedRoutesForTest) and compares them EXACTLY to expectedGatedRoutes,
// then checks each one against its gate: a narrow perimeter role without the
// bit and a plain member get 403, a holder of each admitting bit and the owner
// never do, and an Administrator WITHOUT the bit is refused on the owner tier
// (the seeded Admin must not gain owner powers on upgrade) and admitted on the
// administrator tier. No route is also registered owner-only.
func TestGatedRoutes(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{BackupDir: t.TempDir()})

	routes := admin.GatedRoutesForTest(handler)
	got, want := sortedGatedRoutes(routes), sortedGatedRoutes(expectedGatedRoutes)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("admin.GatedRoutesForTest() = %+v, want exactly %+v", got, want)
	}
	for _, r := range routes {
		if _, ok := gateExpectations[r.Gate]; !ok {
			t.Fatalf("%s %s sits behind gate %q, which gateExpectations does not describe", r.Method, r.Pattern, r.Gate)
		}
	}
	for _, o := range admin.OwnerOnlyRoutesForTest(handler) {
		for _, r := range routes {
			if r.Method == o.Method && r.Pattern == o.Pattern {
				t.Errorf("%s %s is registered as both owner-only and gated", o.Method, o.Pattern)
			}
		}
	}

	narrowMask := permissions.ModerateMembers | permissions.KickMembers | permissions.BanMembers | permissions.MuteMembers
	_, modToken := createRoleUser(t, database, 15, "NarrowMod", narrowMask, 60, "narrowmoduser")
	_, memberToken := createRoleUser(t, database, 17, "Plain", permissions.ReadMessages|permissions.SendMessages|permissions.ViewAuditLog, 40, "plainmemberuser")
	_, adminToken := createRoleUser(t, database, 16, "Administrator", permissions.Administrator, 90, "gateadminuser")
	_, ownerToken := createRoleUser(t, database, permissions.OwnerRoleID, "Owner", permissions.Administrator, 100, "realowneruser")
	holderTokens := map[string]string{} // bit name -> token of a role holding only that bit
	roleID := int64(40)
	for _, exp := range gateExpectations {
		for _, bit := range exp.holders {
			name := permissions.Name(bit)
			if _, done := holderTokens[name]; done {
				continue
			}
			roleID++
			_, holderTokens[name] = createRoleUser(t, database, roleID, "Holder "+name, bit, 50, "holder"+strings.ToLower(name))
		}
	}

	for _, route := range routes {
		exp := gateExpectations[route.Gate]
		path := ownerOnlyRoutePathParam.ReplaceAllString(route.Pattern, "x")
		t.Run(route.Method+" "+route.Pattern, func(t *testing.T) {
			refused := func(who, token string) {
				t.Helper()
				if w := doRequest(t, handler, route.Method, path, token, nil); w.Code != http.StatusForbidden {
					t.Errorf("%s %s (%s) = %d, want 403; body: %s", route.Method, path, who, w.Code, w.Body.String())
				}
			}
			admitted := func(who, token string) {
				t.Helper()
				if w := doRequest(t, handler, route.Method, path, token, nil); w.Code == http.StatusForbidden || w.Code == http.StatusUnauthorized {
					t.Errorf("%s %s (%s) = %d, want admitted; body: %s", route.Method, path, who, w.Code, w.Body.String())
				}
			}
			refused("perimeter role without the bit", modToken)
			refused("plain member", memberToken)
			admitted("owner", ownerToken)
			for _, bit := range exp.holders {
				admitted("holder of "+permissions.Name(bit), holderTokens[permissions.Name(bit)])
			}
			// A holder of a bit that belongs to another gate is refused.
			for name, tok := range holderTokens {
				if !slices.ContainsFunc(exp.holders, func(b int64) bool { return permissions.Name(b) == name }) {
					refused("holder of the unrelated "+name, tok)
				}
			}
			if exp.adminPasses {
				admitted("Administrator without the bit", adminToken)
			} else {
				refused("Administrator without the bit", adminToken)
			}
		})
	}
}

// TestManageBackupsAloneAdmitsToThePerimeter: a role holding only MANAGE_BACKUPS
// reaches the perimeter-level routes (it has to, to reach the backup routes
// at all) and nothing behind a bit it lacks.
func TestManageBackupsAloneAdmitsToThePerimeter(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, token := createRoleUser(t, database, 19, "KeeperOnly", permissions.ManageBackups, 50, "keeperonly")
	if w := doRequest(t, handler, http.MethodGet, "/me", token, nil); w.Code != http.StatusOK {
		t.Fatalf("GET /me (MANAGE_BACKUPS only) = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	for _, path := range []string{"/settings", "/roles", "/audit-log"} {
		if w := doRequest(t, handler, http.MethodGet, path, token, nil); w.Code != http.StatusForbidden {
			t.Errorf("GET %s (MANAGE_BACKUPS only) = %d, want 403", path, w.Code)
		}
	}
}

// TestModerateMembersAloneIsOutsideTheAdminPerimeter pins the half of the
// perimeter rule the test above relies on without asserting it: MODERATE_MEMBERS
// is deliberately NOT in permissions.AdminPerimeter (permissions.go states the
// exclusion and the permissions package locks the constant), so a role holding
// only that bit is refused at the perimeter itself, before any per-route
// requirePerm. GET /me is the probe because it sits behind the perimeter alone.
// The positive control adds one perimeter bit (MUTE_MEMBERS) to the same
// mask and must be admitted, so a perimeter that rejected everyone could not
// pass this test either.
func TestModerateMembersAloneIsOutsideTheAdminPerimeter(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

	_, modOnlyToken := createRoleUser(t, database, 16, "ModOnly", permissions.ModerateMembers, 60, "modonlyuser")
	if w := doRequest(t, handler, http.MethodGet, "/me", modOnlyToken, nil); w.Code != http.StatusForbidden {
		t.Fatalf("GET /me (MODERATE_MEMBERS only) = %d, want 403 — ModerateMembers must stay outside AdminPerimeter; body: %s", w.Code, w.Body.String())
	}

	_, modPlusToken := createRoleUser(t, database, 17, "ModPlusMute", permissions.ModerateMembers|permissions.MuteMembers, 60, "modplusmuteuser")
	if w := doRequest(t, handler, http.MethodGet, "/me", modPlusToken, nil); w.Code == http.StatusForbidden {
		t.Fatalf("GET /me (MODERATE_MEMBERS|MUTE_MEMBERS) = 403, want admitted — MuteMembers is in AdminPerimeter, "+
			"so the refusal above must come from the missing bit, not from a perimeter that rejects everything; body: %s", w.Body.String())
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
		ServerName   string `json:"server_name"`
		Version      string `json:"version"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatalf("unmarshal me: %v", err)
	}
	if me.ServerName != "Test Server" {
		t.Errorf("server_name = %q, want the seeded setting", me.ServerName)
	}
	if me.Version != "1.0.0" {
		t.Errorf("version = %q for a moderator, want the build version", me.Version)
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

func TestGetMe_Unauthenticated(t *testing.T) {
	handler, _, _ := newModeratorHandler(t)

	w := doRequest(t, handler, http.MethodGet, "/me", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if strings.Contains(w.Body.String(), "1.0.0") {
		t.Errorf("unauthenticated body leaks the build version: %s", w.Body.String())
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
		IsOwner bool   `json:"is_owner"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatalf("unmarshal me: %v", err)
	}
	if !me.IsOwner {
		t.Error("is_owner = false for the Owner role")
	}
	if me.Version != "1.0.0" {
		t.Errorf("version = %q for the owner, want the build version", me.Version)
	}
}

// TestVoiceOwnerMovableSetting_OwnerOnly pins WP 8.4a: the switch that lets
// Move Members holders move the owner is the owner's alone. A MANAGE_SERVER
// holder and a non-owner ADMINISTRATOR get 403, the Owner gets 200 and the
// stored value is canonical, and a value that is not a boolean is a 400.
func TestVoiceOwnerMovableSetting_OwnerOnly(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	_, manageToken := createRoleUser(t, database, 20, "ServerAdmin", permissions.ManageServer, 50, "voicemanageuser")
	_, adminToken := createRoleUser(t, database, 21, "Administrator", permissions.Administrator, 90, "voiceadminuser")
	_, ownerToken := createRoleUser(t, database, permissions.OwnerRoleID, "Owner", permissions.Administrator, 100, "voiceowneruser")

	for name, token := range map[string]string{"MANAGE_SERVER non-owner": manageToken, "ADMINISTRATOR non-owner": adminToken} {
		w := doRequest(t, handler, http.MethodPatch, "/settings", token, map[string]string{"voice_owner_movable": "false"})
		if w.Code != http.StatusForbidden {
			t.Errorf("%s PATCH voice_owner_movable = %d, want 403; body: %s", name, w.Code, w.Body.String())
		}
	}
	if w := doRequest(t, handler, http.MethodPatch, "/settings", ownerToken, map[string]string{"voice_owner_movable": "0"}); w.Code != http.StatusOK {
		t.Fatalf("Owner PATCH voice_owner_movable=0 = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if got, err := database.GetSetting(context.Background(), "voice_owner_movable"); err != nil || got != "false" {
		t.Errorf("stored voice_owner_movable = %q, %v; want \"false\"", got, err)
	}
	if w := doRequest(t, handler, http.MethodPatch, "/settings", ownerToken, map[string]string{"voice_owner_movable": "TRUE"}); w.Code != http.StatusOK {
		t.Fatalf("Owner PATCH voice_owner_movable=TRUE = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if got, _ := database.GetSetting(context.Background(), "voice_owner_movable"); got != "true" {
		t.Errorf("stored voice_owner_movable = %q, want \"true\"", got)
	}
	if w := doRequest(t, handler, http.MethodPatch, "/settings", ownerToken, map[string]string{"voice_owner_movable": "maybe"}); w.Code != http.StatusBadRequest {
		t.Errorf("Owner PATCH voice_owner_movable=maybe = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}
