package admin_test

import (
	"context"
	"encoding/json"
	"github.com/J3vb/OwnCord/Server/updater"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
)

// newAdminHarness opens a fresh database, mounts the admin API with the
// default services and a recording hub, and returns an Owner bearer token.
func newAdminHarness(t *testing.T) (*db.DB, http.Handler, string) {
	t.Helper()
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	return database, handler, createAdminUser(t, database)
}

// newAdminHarnessWithHub is newAdminHarness over the caller-visible recording
// hub, for tests that assert on the broadcasts.
func newAdminHarnessWithHub(t *testing.T) (*db.DB, *mockHub, http.Handler, string) {
	t.Helper()
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	return database, hub, handler, createAdminUser(t, database)
}

// newAdminHarnessNoHub is newAdminHarness with no hub wired in.
func newAdminHarnessNoHub(t *testing.T) (*db.DB, http.Handler, string) {
	t.Helper()
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	return database, handler, createAdminUser(t, database)
}

// requireStatus stops the test when the response status differs from want.
func requireStatus(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, want, w.Body.String())
	}
}

// expectStatus records a status mismatch and lets the test keep checking.
func expectStatus(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Errorf("status = %d, want %d; body: %s", w.Code, want, w.Body.String())
	}
}

// decodeBody unmarshals the recorded JSON body into a T.
func decodeBody[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("unmarshal %s: %v", w.Body.String(), err)
	}
	return v
}

// openMigratedDB opens an in-memory database with the full migration set.
func openMigratedDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// newUpdateHarness serves a fake GitHub releases API with release and mounts
// the admin API over an updater pointed at it.
func newUpdateHarness(t *testing.T, release http.HandlerFunc) (*db.DB, http.Handler, string) {
	t.Helper()
	mockGH := httptest.NewServer(release)
	t.Cleanup(mockGH.Close)
	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database))
	return database, handler, createAdminUser(t, database)
}

// mustCreateChannel creates a channel of the given type with no category,
// topic or position, failing the test on error.
func mustCreateChannel(t *testing.T, database *db.DB, name, chanType string) int64 {
	t.Helper()
	id, err := database.CreateChannel(context.Background(), name, chanType, "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(%s): %v", name, err)
	}
	return id
}

// mustCreateUser creates a user with the given password hash and role.
func mustCreateUser(t *testing.T, database *db.DB, username, passwordHash string, roleID int) int64 {
	t.Helper()
	id, err := database.CreateUser(context.Background(), username, passwordHash, roleID)
	if err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	return id
}

// newPermHarness is newAdminHarnessWithHub plus a recording permission
// invalidator wired into the services.
func newPermHarness(t *testing.T) (*db.DB, *mockHub, *mockPermInvalidator, http.Handler, string) {
	t.Helper()
	database := openAdminTestDB(t)
	hub := &mockHub{}
	inv := &mockPermInvalidator{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, inv, newTestServicesFor(database, hub, inv))
	return database, hub, inv, handler, createAdminUser(t, database)
}

// requireAuditAction fails the test unless the audit log holds an entry with
// the given action.
func requireAuditAction(t *testing.T, database *db.DB, action string) {
	t.Helper()
	entries, err := database.GetAuditLog(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	for i := range entries {
		if entries[i].Action == action {
			return
		}
	}
	t.Errorf("expected %s audit entry", action)
}

// channelPerms reads a role's allow/deny override on a channel.
func channelPerms(t *testing.T, database *db.DB, channelID int64, roleID int64) (allow, deny int64) {
	t.Helper()
	allow, deny, err := database.GetChannelPermissions(context.Background(), channelID, roleID)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	return allow, deny
}

// channelUserPerms reads a user's allow/deny override on a channel.
func channelUserPerms(t *testing.T, database *db.DB, channelID, userID int64) (allow, deny int64) {
	t.Helper()
	allow, deny, err := database.GetUserChannelPermissions(context.Background(), channelID, userID)
	if err != nil {
		t.Fatalf("GetUserChannelPermissions: %v", err)
	}
	return allow, deny
}

// releaseJSON answers the GitHub latest-release request with a release tagged
// tag that carries the named assets.
func releaseJSON(tag, notes string, assetNames ...string) http.HandlerFunc {
	assets := make([]map[string]any, 0, len(assetNames))
	for _, name := range assetNames {
		assets = append(assets, map[string]any{
			"name":                 name,
			"browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/" + tag + "/" + name,
		})
	}
	return func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": tag,
			"body":     notes,
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/" + tag,
			"assets":   assets,
		})
	}
}

// doRawJSON serves a request whose JSON-typed body is sent verbatim, for
// payloads that are deliberately malformed.
func doRawJSON(t *testing.T, handler http.Handler, method, path, token, raw string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}
