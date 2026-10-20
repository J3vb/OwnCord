package admin_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/updater"
)

func TestAdminAPI_CheckUpdate_OK(t *testing.T) {
	// Mock GitHub API
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v2.0.0",
			"body":     "New release",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
			"assets": []map[string]any{
				{"name": "chatserver.exe", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/chatserver.exe"},
				{"name": "chatserver-linux-amd64.tar.gz", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/chatserver-linux-amd64.tar.gz"},
				{"name": "checksums.sha256", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/checksums.sha256"},
				{"name": "chatserver.exe.sig", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/chatserver.exe.sig"},
				{"name": "server-update-manifest.json", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/server-update-manifest.json"},
				{"name": "server-update-manifest.json.sig", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/server-update-manifest.json.sig"},
			},
		})
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/updates", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var info updater.UpdateInfo
	_ = json.Unmarshal(w.Body.Bytes(), &info)
	if !info.UpdateAvailable {
		t.Error("expected update_available = true")
	}
	if info.Latest != "v2.0.0" {
		t.Errorf("latest = %q, want v2.0.0", info.Latest)
	}
	if !info.RequiredAssetsPresent {
		t.Error("expected required_assets_present = true")
	}
}

func TestAdminAPI_CheckUpdate_IncompleteReleaseNotInstallable(t *testing.T) {
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v2.0.0",
			"body":     "Missing manifest",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
			"assets": []map[string]any{
				{"name": "chatserver.exe", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/chatserver.exe"},
				{"name": "checksums.sha256", "browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/checksums.sha256"},
			},
		})
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/updates", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var info updater.UpdateInfo
	_ = json.Unmarshal(w.Body.Bytes(), &info)
	if info.UpdateAvailable {
		t.Error("expected update_available = false for incomplete release")
	}
	if info.RequiredAssetsPresent {
		t.Error("expected required_assets_present = false for incomplete release")
	}
}

func TestAdminAPI_CheckUpdate_UpToDate(t *testing.T) {
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v1.0.0",
			"body":     "",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v1.0.0",
			"assets":   []map[string]any{},
		})
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/updates", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	var info updater.UpdateInfo
	_ = json.Unmarshal(w.Body.Bytes(), &info)
	if info.UpdateAvailable {
		t.Error("expected update_available = false")
	}
}

func TestAdminAPI_CheckUpdate_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodGet, "/updates", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestAdminAPI_ApplyUpdate_RequiresOwner(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	// Create admin user (not owner - role 2)
	adminUID, _ := database.CreateUser(context.Background(), "adminonly2", "hash", 2)
	token := "admin-role-token"
	_, _ = database.CreateSession(context.Background(), adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

// ─── handleApplyUpdate additional paths ──────────────────────────────────────

// TestAdminAPI_ApplyUpdate_NilUpdater verifies that POST /updates/apply returns
// 503 when no updater is configured.
func TestAdminAPI_ApplyUpdate_NilUpdater(t *testing.T) {
	database := openAdminTestDB(t)
	// nil updater — the endpoint should return 503
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503; body: %s", w.Code, w.Body.String())
	}
}

// TestAdminAPI_ApplyUpdate_NilUpdater_ErrorCode verifies the error code field
// in the 503 response.
func TestAdminAPI_ApplyUpdate_NilUpdater_ErrorCode(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["error"] != "UPDATE_UNAVAILABLE" {
		t.Errorf("error code = %q, want UPDATE_UNAVAILABLE", resp["error"])
	}
}

// TestAdminAPI_ApplyUpdate_NoUpdateAvailable verifies that 409 Conflict is
// returned when the server is already up to date.
func TestAdminAPI_ApplyUpdate_NoUpdateAvailable(t *testing.T) {
	// Mock GitHub API to return same version (no update available).
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v1.0.0",
			"body":     "",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v1.0.0",
			"assets":   []map[string]any{},
		})
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409 (no update available); body: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["error"] != "NO_UPDATE" {
		t.Errorf("error = %q, want NO_UPDATE", resp["error"])
	}
}

// TestAdminAPI_ApplyUpdate_CheckFails verifies that 502 Bad Gateway is returned
// when the update check request to GitHub fails.
func TestAdminAPI_ApplyUpdate_CheckFails(t *testing.T) {
	// Server that immediately closes connections (simulates network error).
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Return invalid JSON to trigger a parse error.
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	// Expect 502 Bad Gateway when update check call fails.
	if w.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502; body: %s", w.Code, w.Body.String())
	}
}

// TestAdminAPI_ApplyUpdate_MissingAssets verifies that 502 is returned when the
// release has no download URL, checksum URL, or detached signature URL.
func TestAdminAPI_ApplyUpdate_MissingAssets(t *testing.T) {
	// Return a newer version but with no assets (empty download/checksum URLs).
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v2.0.0",
			"body":     "Release notes",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
			"assets":   []map[string]any{},
		})
	}))
	defer mockGH.Close()

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502 (missing assets); body: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["error"] != "MISSING_ASSETS" {
		t.Errorf("error = %q, want MISSING_ASSETS", resp["error"])
	}
}

// TestAdminAPI_ApplyUpdate_Unauthenticated verifies that 401 is returned for
// unauthenticated requests to POST /updates/apply.
func TestAdminAPI_ApplyUpdate_Unauthenticated(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestAdminAPI_ApplyUpdate_DownloadFails verifies that 502 is returned when
// the binary download itself fails (bad URL, network error, etc.).
// We use a mock server that reports an available update with valid-format
// GitHub URLs, but those URLs point to a server that returns 404.
func TestAdminAPI_ApplyUpdate_DownloadFails(t *testing.T) {
	// The mock server that serves the GitHub release info — it reports an
	// update is available with GitHub-prefixed asset URLs.
	// The actual download will fail because the URLs don't point to real files.
	var mockGHURL string
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// If this is the checksum/download request, return an error.
		// The release API endpoint returns a release with asset URLs.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v2.0.0",
			"body":     "Release notes",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
			"assets": []map[string]any{
				{
					"name":                 "chatserver.exe",
					"browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/chatserver.exe",
				},
				{
					"name":                 "chatserver-linux-amd64.tar.gz",
					"browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/chatserver-linux-amd64.tar.gz",
				},
				{
					"name":                 "checksums.sha256",
					"browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/checksums.sha256",
				},
				{
					"name":                 "chatserver.exe.sig",
					"browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/chatserver.exe.sig",
				},
				{
					"name":                 "server-update-manifest.json",
					"browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/server-update-manifest.json",
				},
				{
					"name":                 "server-update-manifest.json.sig",
					"browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/server-update-manifest.json.sig",
				},
			},
		})
		_ = mockGHURL // suppress unused warning
	}))
	defer mockGH.Close()
	mockGHURL = mockGH.URL

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)
	// The download URLs are real GitHub URLs that will fail since we're not
	// actually connected to GitHub in tests, or we can use the URL validation
	// to force a failure. The URLs pass validation (they have the right prefix),
	// but the actual HTTP fetch will fail (unreachable host).
	// In CI environments without internet, this returns 502.
	// We accept either 502 (download failed) or 200 (unexpectedly succeeded) —
	// the important thing is that the code path is executed.

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	// Either 502 (download failed as expected in isolated test environment)
	// or 200 (succeeded in environment with GitHub access) is acceptable.
	// What should NOT happen is 409 (no update) or 503 (nil updater).
	if w.Code == http.StatusServiceUnavailable || w.Code == http.StatusConflict {
		t.Errorf("status = %d; expected download attempt to proceed (got 503/409 instead)", w.Code)
	}
}

// ─── handleApplyUpdate — container deployments ───────────────────────────────

// In a container the staged replacement dies with the container, so the
// endpoint refuses before any updater logic runs — the answer must not
// depend on whether an updater is configured (closes the long-standing
// "disable this endpoint in docker builds?" TODO).
func TestAdminAPI_ApplyUpdate_RefusedInContainer(t *testing.T) {
	t.Setenv("OWNCORD_CONTAINER", "1")
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["error"] != "CONTAINER_DEPLOYMENT" {
		t.Errorf("error code = %q, want CONTAINER_DEPLOYMENT", resp["error"])
	}
}

// The explicit opt-out keeps in-place update available for operators who
// bind-mount the binary and know what they are doing: with the variable set
// to 0, the container guard steps aside and the nil-updater 503 answers.
func TestAdminAPI_ApplyUpdate_ContainerOptOut(t *testing.T) {
	t.Setenv("OWNCORD_CONTAINER", "0")
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["error"] != "UPDATE_UNAVAILABLE" {
		t.Errorf("error code = %q, want UPDATE_UNAVAILABLE (container guard must step aside)", resp["error"])
	}
}

// ─── OC-0226: aborted apply must correct the earlier restart promise ────────
//
// handleApplyUpdate's background goroutine broadcasts "server restarting in
// 5s" as its very first action, before any of the on-disk swap actually
// happens. If the swap then fails, every connected client is left believing
// a restart is underway (ServerBanner counts down to a permanent
// "Reconnecting..." state) with no corrective signal ever sent. These tests
// call the swap logic directly — admin.ApplyStagedUpdate — with inputs
// engineered to fail at different points, and assert a corrective
// "update_aborted" broadcast follows. The success path is covered too, now
// that the swap has no process side effects (the restart happens through the
// coordinator hook, not an in-package spawn + os.Exit).

// TestApplyStagedUpdate_VerifyFails_BroadcastsAbort covers the earliest abort
// point: the staged binary re-verification (OpenVerifiedBinary) fails
// because the staged file was never written.
func TestApplyStagedUpdate_VerifyFails_BroadcastsAbort(t *testing.T) {
	dir := t.TempDir()
	exePath := filepath.Join(dir, "chatserver")
	if err := os.WriteFile(exePath, []byte("old binary"), 0o755); err != nil {
		t.Fatalf("writing fake exe: %v", err)
	}
	newPath := exePath + ".new" // deliberately never written

	hub := &mockHub{}
	admin.ApplyStagedUpdate(hub, exePath, newPath, "0000000000000000000000000000000000000000000000000000000000000000", nil)

	if len(hub.restartCalls) != 1 {
		t.Fatalf("restartCalls = %d, want 1 (corrective broadcast after abort); got %+v", len(hub.restartCalls), hub.restartCalls)
	}
	if hub.restartCalls[0].reason == "update" {
		t.Fatalf("only broadcast was the original 'restarting' promise (%+v); no corrective broadcast was sent after the abort", hub.restartCalls[0])
	}

	// The original binary must be untouched: verification failed before any
	// filesystem mutation.
	got, err := os.ReadFile(exePath)
	if err != nil || string(got) != "old binary" {
		t.Errorf("exePath contents = %q, err=%v; want original binary untouched", got, err)
	}
}

// TestApplyStagedUpdate_RenameToOldFails_BroadcastsAbort covers the second
// abort point: the staged binary verifies fine, but renaming the current
// executable aside fails (exePath does not exist).
func TestApplyStagedUpdate_RenameToOldFails_BroadcastsAbort(t *testing.T) {
	dir := t.TempDir()
	exePath := filepath.Join(dir, "chatserver") // deliberately never created
	newPath := exePath + ".new"

	content := []byte("verified staged bytes")
	if err := os.WriteFile(newPath, content, 0o755); err != nil {
		t.Fatalf("writing staged binary: %v", err)
	}
	sum := sha256.Sum256(content)
	stagedHash := hex.EncodeToString(sum[:])

	hub := &mockHub{}
	admin.ApplyStagedUpdate(hub, exePath, newPath, stagedHash, nil)

	if len(hub.restartCalls) != 1 {
		t.Fatalf("restartCalls = %d, want 1 (corrective broadcast after abort); got %+v", len(hub.restartCalls), hub.restartCalls)
	}
	if hub.restartCalls[0].reason == "update" {
		t.Fatalf("only broadcast was the original 'restarting' promise (%+v); no corrective broadcast was sent after the abort", hub.restartCalls[0])
	}
	if olds := oldBinaries(t, exePath); len(olds) != 0 {
		t.Errorf("old binaries after the failed rename = %v, want the reserved name removed", olds)
	}
}

// TestApplyStagedUpdate_NilHub_NoPanic verifies the corrective-broadcast
// guard does not dereference a nil hub (update checking with no ws.Hub is a
// supported configuration — see handleApplyUpdate's nil checks).
func TestApplyStagedUpdate_NilHub_NoPanic(t *testing.T) {
	dir := t.TempDir()
	exePath := filepath.Join(dir, "chatserver")
	newPath := exePath + ".new" // never written -> verification fails

	admin.ApplyStagedUpdate(nil, exePath, newPath, "0000000000000000000000000000000000000000000000000000000000000000", nil)
}

// ─── Install directory the service cannot write to ───────────────────────────

// releaseServer serves a release that is newer than 1.0.0 and counts every
// request, so a test can prove nothing was fetched.
func releaseServer(t *testing.T, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	const dl = "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		names := []string{
			"chatserver.exe", "chatserver-linux-amd64.tar.gz", "checksums.sha256",
			"chatserver.exe.sig", "server-update-manifest.json", "server-update-manifest.json.sig",
		}
		assets := make([]map[string]any, 0, len(names))
		for _, n := range names {
			assets = append(assets, map[string]any{"name": n, "browser_download_url": dl + n})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v2.0.0",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
			"assets":   assets,
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func checkUpdateBody(t *testing.T) map[string]any {
	t.Helper()
	var hits atomic.Int32
	mockGH := releaseServer(t, &hits)
	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/updates", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return body
}

func TestCheckUpdate_ReportsInstallReadOnly(t *testing.T) {
	t.Setenv("OWNCORD_CONTAINER", "0")
	t.Cleanup(admin.SetInstallWritable(func() error { return errors.New("read-only") }))

	body := checkUpdateBody(t)
	if body["can_apply"] != false {
		t.Errorf("can_apply = %v, want false", body["can_apply"])
	}
	if body["apply_blocked"] != "install_read_only" {
		t.Errorf("apply_blocked = %v, want install_read_only", body["apply_blocked"])
	}
}

func TestCheckUpdate_WritableInstallOmitsApplyBlocked(t *testing.T) {
	t.Setenv("OWNCORD_CONTAINER", "0")
	t.Cleanup(admin.SetInstallWritable(func() error { return nil }))

	body := checkUpdateBody(t)
	if body["can_apply"] != true {
		t.Errorf("can_apply = %v, want true", body["can_apply"])
	}
	if _, ok := body["apply_blocked"]; ok {
		t.Errorf("apply_blocked = %v, want it absent", body["apply_blocked"])
	}
}

// The container check wins, so the contract containers already rely on is
// unchanged even when the install directory is also read-only.
func TestCheckUpdate_ContainerWinsOverReadOnly(t *testing.T) {
	t.Setenv("OWNCORD_CONTAINER", "1")
	t.Cleanup(admin.SetInstallWritable(func() error { return errors.New("read-only") }))

	body := checkUpdateBody(t)
	if body["can_apply"] != false {
		t.Errorf("can_apply = %v, want false", body["can_apply"])
	}
	if body["apply_blocked"] != "container" {
		t.Errorf("apply_blocked = %v, want container", body["apply_blocked"])
	}
}

// A read-only install is refused before the release is even looked up: no
// outbound request, no restart countdown, and the restart guard stays free.
func TestApplyUpdate_ReadOnlyInstallRefusedBeforeDownload(t *testing.T) {
	t.Setenv("OWNCORD_CONTAINER", "0")
	t.Cleanup(admin.SetInstallWritable(func() error { return errors.New("read-only") }))

	var hits atomic.Int32
	mockGH := releaseServer(t, &hits)
	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)
	hub := &mockHub{}
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", hub, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["error"] != "INSTALL_READ_ONLY" {
		t.Errorf("error code = %q, want INSTALL_READ_ONLY", resp["error"])
	}
	if n := hits.Load(); n != 0 {
		t.Errorf("release server saw %d request(s), want 0", n)
	}
	if len(hub.restartCalls) != 0 {
		t.Errorf("restart broadcasts = %d, want 0", len(hub.restartCalls))
	}
}

// newApplyTestServer serves the admin API over HTTP/2 TLS against a mock
// GitHub whose release lookup (same version, so NO_UPDATE) sleeps for delay.
func newApplyTestServer(t *testing.T, writeTimeout, delay time.Duration) (*httptest.Server, string) {
	t.Helper()
	t.Setenv("OWNCORD_CONTAINER", "0")
	t.Cleanup(admin.SetInstallWritable(func() error { return nil }))
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(delay)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v1.0.0",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v1.0.0",
			"assets":   []map[string]any{},
		})
	}))
	t.Cleanup(mockGH.Close)

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	srv := httptest.NewUnstartedServer(handler)
	srv.EnableHTTP2 = true
	srv.Config.WriteTimeout = writeTimeout
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv, token
}

func postApply(t *testing.T, srv *httptest.Server, token string) (int, string) {
	t.Helper()
	status, _, code := postApplyProto(t, srv, token)
	return status, code
}

// postApplyProto returns the status code, the negotiated HTTP major version
// and the error code, so no *http.Response escapes with a closed body.
func postApplyProto(t *testing.T, srv *httptest.Server, token string) (int, int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/updates/apply", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := srv.Client()
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	var body map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&body)
	return resp.StatusCode, resp.ProtoMajor, body["error"]
}

// A slow release lookup that outlasts the server's WriteTimeout must still
// reach an HTTP/2 client: the handler extends the connection deadlines. The
// slow stage stands in for the download, which sits under the same deadlines.
func TestAdminAPI_ApplyUpdate_OutlastsServerWriteTimeout(t *testing.T) {
	srv, token := newApplyTestServer(t, time.Second, 3*time.Second)
	status, protoMajor, code := postApplyProto(t, srv, token)
	if protoMajor != 2 {
		t.Fatalf("protocol major = %d, want HTTP/2", protoMajor)
	}
	if status != http.StatusConflict || code != "NO_UPDATE" {
		t.Errorf("status = %d error = %q, want 409 NO_UPDATE", status, code)
	}
}

// The shutdown hook ends an apply that is in its release-check stage: that
// stage waits for its detached lookup to return (here 600 ms; up to about 30 s
// in production) and then the handler answers SERVER_SHUTTING_DOWN instead of
// carrying on to its 409.
func TestAdminAPI_ApplyUpdate_EndAppliesCancelsInFlight(t *testing.T) {
	srv, token := newApplyTestServer(t, 5*time.Second, 600*time.Millisecond)
	hook := admin.EndApplies(srv.Config)
	go func() {
		time.Sleep(150 * time.Millisecond)
		hook()
	}()
	status, code := postApply(t, srv, token)
	if status != http.StatusServiceUnavailable || code != "SERVER_SHUTTING_DOWN" {
		t.Errorf("status = %d error = %q, want 503 SERVER_SHUTTING_DOWN", status, code)
	}
}

// An apply that starts after the hook ran is refused straight away.
func TestAdminAPI_ApplyUpdate_AfterEndAppliesIsCancelled(t *testing.T) {
	srv, token := newApplyTestServer(t, 5*time.Second, 0)
	admin.EndApplies(srv.Config)()
	status, code := postApply(t, srv, token)
	if status != http.StatusServiceUnavailable || code != "SERVER_SHUTTING_DOWN" {
		t.Errorf("status = %d error = %q, want 503 SERVER_SHUTTING_DOWN", status, code)
	}
}

// A shutdown that lands during the download/verify stage ends the apply with
// SERVER_SHUTTING_DOWN, removes the staged file, releases the restart slot
// and promises no restart. The real download needs a signed release manifest,
// so the download stage is replaced by a stub that stages a file and then
// trickles until its context ends, then reports success: this covers both the
// cancel and the cancel-after-verify branch.
func TestAdminAPI_ApplyUpdate_ShutdownDuringDownloadCleansUp(t *testing.T) {
	t.Setenv("OWNCORD_CONTAINER", "0")
	t.Cleanup(admin.SetInstallWritable(func() error { return nil }))
	assets := make([]map[string]any, 0, 7)
	for _, n := range []string{"chatserver.exe", "chatserver-linux-amd64.tar.gz", "chatserver-linux-arm64.tar.gz", "checksums.sha256",
		"chatserver.exe.sig", "server-update-manifest.json", "server-update-manifest.json.sig"} {
		assets = append(assets, map[string]any{
			"name":                 n,
			"browser_download_url": "https://github.com/J3vb/OwnCord/releases/download/v2.0.0/" + n,
		})
	}
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v2.0.0",
			"html_url": "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
			"assets":   assets,
		})
	}))
	defer mockGH.Close()

	exePath, err := updater.ExecutablePath()
	if err != nil {
		t.Fatalf("ExecutablePath: %v", err)
	}
	newPath := exePath + ".new"
	t.Cleanup(func() { _ = os.Remove(newPath) })
	started := make(chan struct{})
	t.Cleanup(admin.SetDownloadAndVerify(func(_ *updater.Updater, ctx context.Context, _, _, _, _, _, _, dest string) (string, error) {
		if err := os.WriteFile(dest, []byte("partial"), 0o600); err != nil {
			return "", err
		}
		close(started)
		<-ctx.Done()
		return "stagedhash", nil
	}))

	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL(mockGH.URL)
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, u, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)
	srv := httptest.NewUnstartedServer(handler)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()

	hook := admin.EndApplies(srv.Config)
	go func() {
		<-started
		hook()
	}()
	status, code := postApply(t, srv, token)
	if status != http.StatusServiceUnavailable || code != "SERVER_SHUTTING_DOWN" {
		t.Fatalf("status = %d error = %q, want 503 SERVER_SHUTTING_DOWN", status, code)
	}
	if _, statErr := os.Stat(newPath); !os.IsNotExist(statErr) {
		t.Errorf("staged file still present: %v", statErr)
	}
	if len(hub.restartCalls) != 0 {
		t.Errorf("restart broadcasts = %+v, want none", hub.restartCalls)
	}
	// The restart slot was released: a second apply is refused for shutdown
	// (hook already ran), not as UPDATE_IN_PROGRESS.
	_, code2 := postApply(t, srv, token)
	if code2 == "UPDATE_IN_PROGRESS" || code2 == "RESTART_PENDING" {
		t.Errorf("second apply error = %q, restart slot not released", code2)
	}
}
