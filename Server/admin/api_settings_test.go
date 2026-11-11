package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ─── GET /admin/api/settings ──────────────────────────────────────────────────

func TestAdminAPI_GetSettings_OK(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodGet, "/settings", token, nil)

	expectStatus(t, w, http.StatusOK)

	settings := decodeBody[map[string]string](t, w)
	if _, ok := settings["server_name"]; !ok {
		t.Error("response missing 'server_name'")
	}
}

// ─── GET /admin/api/config ────────────────────────────────────────────────────

// The Settings page shows these as read-only facts, so they must be the
// values the server is running with, not the settings rows of the same name.
func TestAdminAPI_GetConfigFacts_ReportsRunningConfig(t *testing.T) {
	database := openAdminTestDB(t)
	cfg := &config.Config{Upload: config.UploadConfig{MaxSizeMB: 64}, Voice: config.VoiceConfig{Quality: "low"}}
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{RunningCfg: cfg})
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/config", token, nil)
	requireStatus(t, w, http.StatusOK)
	got := decodeBody[map[string]any](t, w)
	if got["upload_max_size_mb"] != float64(64) || got["voice_quality"] != "low" {
		t.Errorf("config facts = %v, want upload_max_size_mb 64 and voice_quality low", got)
	}
}

// The running-config card (SRE-07) shows the effective settings an operator
// otherwise has to read config.yaml for — and never a secret. The GIF API key
// and GitHub token must be a boolean "configured", not their value.
func TestAdminAPI_GetConfigFacts_EffectiveConfigMasksSecrets(t *testing.T) {
	database := openAdminTestDB(t)
	cfg := &config.Config{
		Server:     config.ServerConfig{Port: 8443, MinFreeDiskMB: 256, MaxWSConnections: 1000},
		Upload:     config.UploadConfig{MaxSizeMB: 100, UserQuotaMB: 50},
		Voice:      config.VoiceConfig{Quality: "medium", LiveKitURL: "wss://voice.example", LiveKitAPIKey: "key", LiveKitAPISecret: "secret"},
		TLS:        config.TLSConfig{Mode: "acme", Domain: "chat.example"},
		Backup:     config.BackupConfig{Dir: "/var/backups"},
		Logging:    config.LoggingConfig{Level: "warn"},
		GIF:        config.GIFConfig{APIKey: "klipy-secret"},
		GitHub:     config.GitHubConfig{Token: "ghp_secret"},
		Moderation: config.ModerationConfig{ReportRetentionDays: 30, ActionRetentionDays: 90},
	}
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{RunningCfg: cfg})
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/config", token, nil)
	requireStatus(t, w, http.StatusOK)
	body := w.Body.String()
	for _, secret := range []string{"klipy-secret", "ghp_secret", "secret", `"key"`} {
		if strings.Contains(body, secret) {
			t.Fatalf("config facts leak %q: %s", secret, body)
		}
	}
	got := decodeBody[map[string]any](t, w)
	if got["server_port"] != float64(8443) || got["tls_mode"] != "acme" || got["tls_domain"] != "chat.example" {
		t.Errorf("config facts = %v", got)
	}
	if got["gif_configured"] != true || got["github_configured"] != true {
		t.Errorf("configured flags = gif:%v github:%v, want both true", got["gif_configured"], got["github_configured"])
	}
	if got["logging_level"] != "warn" || got["voice_url"] != "wss://voice.example" {
		t.Errorf("config facts = %v", got)
	}
}

// The host path and endpoints are for an ADMINISTRATOR or the owner only; a
// MANAGE_SERVER-only caller reads the rest of the card without them.
func TestAdminAPI_GetConfigFacts_PathsAndURLsAdminOnly(t *testing.T) {
	database := openAdminTestDB(t)
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		Voice:  config.VoiceConfig{LiveKitURL: "ws://localhost:7880"},
		TLS:    config.TLSConfig{Mode: "acme", Domain: "chat.example"},
		Backup: config.BackupConfig{Dir: "/var/backups"},
	}
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{RunningCfg: cfg})
	_, managerToken := createRoleUser(t, database, 12, "Manager", permissions.ManageServer, 50, "manageruser")
	adminToken := createAdminUser(t, database)
	hidden := []string{"backup_dir", "voice_url", "tls_domain"}

	for _, tc := range []struct {
		name     string
		token    string
		wantShow bool
	}{
		{"manage server only", managerToken, false},
		{"owner", adminToken, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := doRequest(t, handler, http.MethodGet, "/config", tc.token, nil)
			requireStatus(t, w, http.StatusOK)
			got := decodeBody[map[string]any](t, w)
			if got["server_port"] != float64(8443) || got["tls_mode"] != "acme" {
				t.Errorf("config facts = %v, want the non-sensitive rows", got)
			}
			for _, key := range hidden {
				if _, ok := got[key]; ok != tc.wantShow {
					t.Errorf("%s present = %v, want %v; body: %s", key, ok, tc.wantShow, w.Body.String())
				}
			}
			if tc.wantShow && (got["backup_dir"] != "/var/backups" || got["voice_url"] != "ws://localhost:7880" || got["tls_domain"] != "chat.example") {
				t.Errorf("config facts = %v", got)
			}
		})
	}
}

// The card reports the level the server runs, not the raw config string: boot
// reads logging.level case-insensitively and falls back to info for a value
// it does not know. An empty value stays empty so the card reads "Not set".
func TestAdminAPI_GetConfigFacts_ReportsRunningLogLevel(t *testing.T) {
	for _, tc := range []struct{ configured, want string }{
		{"verbose", "info"},
		{"WARNING", "warn"},
		{"Debug", "debug"},
		{"", ""},
	} {
		t.Run(tc.configured, func(t *testing.T) {
			database := openAdminTestDB(t)
			cfg := &config.Config{Logging: config.LoggingConfig{Level: tc.configured}}
			handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{RunningCfg: cfg})
			token := createAdminUser(t, database)

			w := doRequest(t, handler, http.MethodGet, "/config", token, nil)
			requireStatus(t, w, http.StatusOK)
			got := decodeBody[map[string]any](t, w)
			if got["logging_level"] != tc.want {
				t.Errorf("logging_level = %v, want %q", got["logging_level"], tc.want)
			}
		})
	}
}

func TestAdminAPI_GetConfigFacts_WithoutRunningConfig(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	if w := doRequest(t, handler, http.MethodGet, "/config", token, nil); w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503; body: %s", w.Code, w.Body.String())
	}
}

// ─── GET/PATCH /admin/api/logs/level ─────────────────────────────────────────

// The runtime log-level card (SRE-07): reading reports the level in force, and
// a PATCH applies a timed boost the controller itself reverts. The handler is
// only a thin adapter — the revert timing is the controller's own test.
func TestAdminAPI_LogLevel_ReadAndSet(t *testing.T) {
	database := openAdminTestDB(t)
	var lv slog.LevelVar
	lv.Set(slog.LevelInfo)
	lvl := admin.NewLogLevelController(&lv, slog.LevelInfo)
	t.Cleanup(lvl.Close)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{LogLevel: lvl})
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/logs/level", token, nil)
	requireStatus(t, w, http.StatusOK)
	got := decodeBody[map[string]any](t, w)
	if got["level"] != "info" || got["base_level"] != "info" {
		t.Errorf("GET = %v, want level and base_level info", got)
	}
	if _, ok := got["reverts_at"]; ok {
		t.Errorf("GET reverts_at present with no boost: %v", got["reverts_at"])
	}

	w = doRequest(t, handler, http.MethodPatch, "/logs/level", token, map[string]any{"level": "debug", "duration_seconds": 900})
	requireStatus(t, w, http.StatusOK)
	if lv.Level() != slog.LevelDebug {
		t.Fatalf("level = %v after PATCH, want debug", lv.Level())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["level"] != "debug" || got["reverts_at"] == "" {
		t.Errorf("PATCH response = %v, want debug with reverts_at", got)
	}
}

func TestAdminAPI_LogLevel_RefusesBadRequests(t *testing.T) {
	database := openAdminTestDB(t)
	var lv slog.LevelVar
	lv.Set(slog.LevelInfo)
	lvl := admin.NewLogLevelController(&lv, slog.LevelInfo)
	t.Cleanup(lvl.Close)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{LogLevel: lvl})
	token := createAdminUser(t, database)

	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"unknown level", map[string]any{"level": "loud", "duration_seconds": 900}},
		{"quieter level", map[string]any{"level": "error", "duration_seconds": 900}},
		{"zero window", map[string]any{"level": "debug", "duration_seconds": 0}},
		{"other window", map[string]any{"level": "debug", "duration_seconds": 60}},
		{"window too long", map[string]any{"level": "debug", "duration_seconds": 86400}},
		{"overflowing window", map[string]any{"level": "debug", "duration_seconds": 900 + (1 << 55)}},
		{"missing level", map[string]any{"duration_seconds": 900}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if w := doRequest(t, handler, http.MethodPatch, "/logs/level", token, tc.body); w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body.String())
			}
		})
	}
	if lv.Level() != slog.LevelInfo {
		t.Fatalf("level = %v after refusals, want info unchanged", lv.Level())
	}
}

// DELETE reverts a boost to the base level at once.
func TestAdminAPI_LogLevel_DeleteRevertsToBase(t *testing.T) {
	database := openAdminTestDB(t)
	var lv slog.LevelVar
	lv.Set(slog.LevelWarn)
	lvl := admin.NewLogLevelController(&lv, slog.LevelWarn)
	t.Cleanup(lvl.Close)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{LogLevel: lvl})
	token := createAdminUser(t, database)

	if w := doRequest(t, handler, http.MethodPatch, "/logs/level", token, map[string]any{"level": "debug", "duration_seconds": 900}); w.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d; body: %s", w.Code, w.Body.String())
	}
	w := doRequest(t, handler, http.MethodDelete, "/logs/level", token, nil)
	requireStatus(t, w, http.StatusOK)
	if lv.Level() != slog.LevelWarn {
		t.Fatalf("level = %v after DELETE, want the base warn", lv.Level())
	}
	got := decodeBody[map[string]any](t, w)
	if got["level"] != "warn" || got["base_level"] != "warn" {
		t.Errorf("DELETE response = %v, want level and base_level warn", got)
	}
	if _, ok := got["reverts_at"]; ok {
		t.Errorf("DELETE response has reverts_at after a revert: %v", got)
	}
}

func TestAdminAPI_LogLevel_WithoutController(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	if w := doRequest(t, handler, http.MethodGet, "/logs/level", token, nil); w.Code != http.StatusServiceUnavailable {
		t.Errorf("GET status = %d, want 503", w.Code)
	}
	if w := doRequest(t, handler, http.MethodPatch, "/logs/level", token, map[string]any{"level": "debug", "duration_seconds": 900}); w.Code != http.StatusServiceUnavailable {
		t.Errorf("PATCH status = %d, want 503", w.Code)
	}
	if w := doRequest(t, handler, http.MethodDelete, "/logs/level", token, nil); w.Code != http.StatusServiceUnavailable {
		t.Errorf("DELETE status = %d, want 503", w.Code)
	}
}

// ─── PATCH /admin/api/settings ────────────────────────────────────────────────

func TestAdminAPI_PatchSettings_OK(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	body := map[string]string{
		"server_name": "Updated Server",
		"motd":        "New MOTD",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	expectStatus(t, w, http.StatusOK)

	// Verify the change was persisted
	val, err := database.GetSetting(context.Background(), "server_name")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	if val != "Updated Server" {
		t.Errorf("server_name = %q, want 'Updated Server'", val)
	}
}

func TestAdminAPI_PatchSettings_InvalidBody(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	req := httptest.NewRequest(http.MethodPatch, "/settings", bytes.NewReader([]byte("not-json")))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	expectStatus(t, w, http.StatusBadRequest)
}

// ─── Task 0.6: Settings key whitelist ────────────────────────────────────────

// TestAdminAPI_PatchSettings_RejectsUnknownKey verifies that an unknown key
// returns 400 without writing anything to the database.
func TestAdminAPI_PatchSettings_RejectsUnknownKey(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	body := map[string]string{
		"unknown_key": "should be rejected",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	expectStatus(t, w, http.StatusBadRequest)

	resp := decodeBody[map[string]string](t, w)
	// The error message must name the offending key so the caller knows what to fix.
	if msg, ok := resp["message"]; !ok || msg == "" {
		t.Error("response should include a non-empty 'message' field")
	}
}

// TestAdminAPI_PatchSettings_RejectsMixedKeys verifies that a payload
// containing both valid and invalid keys is rejected entirely (no partial write).
func TestAdminAPI_PatchSettings_RejectsMixedKeys(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	body := map[string]string{
		"server_name":  "valid",
		"injected_key": "should block the whole request",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	expectStatus(t, w, http.StatusBadRequest)

	// The valid key must NOT have been written because the request was rejected.
	val, err := database.GetSetting(context.Background(), "server_name")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	if val == "valid" {
		t.Error("server_name was updated despite invalid key in payload — partial write occurred")
	}
}

// TestAdminAPI_PatchSettings_AcceptsAllWhitelistedKeys iterates over every key
// in the whitelist and confirms each one is individually accepted.
func TestAdminAPI_PatchSettings_AcceptsAllWhitelistedKeys(t *testing.T) {
	whitelistedKeys := []string{
		"server_name",
		"server_icon",
		"motd",
		"require_2fa",
		"registration_mode",
		"backup_schedule",
		"backup_retention",
	}

	// Boolean-typed settings require valid boolean values; others accept any
	// string, except the enumerated/validated keys which need a valid value.
	validValues := map[string]string{
		"require_2fa":       "0",
		"registration_mode": "closed",
		"backup_schedule":   "daily",
		"backup_retention":  "30",
	}

	for _, key := range whitelistedKeys {
		t.Run(key, func(t *testing.T) {
			database := openAdminTestDB(t)
			handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
			token := createAdminUser(t, database)

			value := "testvalue"
			if valid, ok := validValues[key]; ok {
				value = valid
			}
			body := map[string]string{key: value}
			w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

			if w.Code != http.StatusOK {
				t.Errorf("key %q: status = %d, want 200; body: %s", key, w.Code, w.Body.String())
			}
		})
	}
}

// TestAdminAPI_PatchSettings_EmptyPayloadIsOK verifies that an empty map
// (no-op update) is accepted and returns the current settings.
func TestAdminAPI_PatchSettings_EmptyPayloadIsOK(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	body := map[string]string{}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	expectStatus(t, w, http.StatusOK)
}

func TestAdminAPI_PatchSettings_RejectsRequire2FAWhenUsersNotEnrolled(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	body := map[string]string{
		"registration_mode": "closed",
		"require_2fa":       "true",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	requireStatus(t, w, http.StatusBadRequest)
}

func TestAdminAPI_PatchSettings_AllowsRequire2FAWhenAllUsersEnrolledAndRegistrationClosed(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	if _, err := database.ExecContext(context.Background(), `UPDATE users SET totp_secret = ? WHERE id = 1`, "JBSWY3DPEHPK3PXP"); err != nil {
		t.Fatalf("enroll admin user: %v", err)
	}

	body := map[string]string{
		"registration_mode": "closed",
		"require_2fa":       "true",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	requireStatus(t, w, http.StatusOK)
}

func TestAdminAPI_PatchSettings_RejectsInvalidBooleanValue(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	body := map[string]string{
		"require_2fa": "banana",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, body)

	requireStatus(t, w, http.StatusBadRequest)
}

// TestAdminAPI_PatchSettings_UnrelatedKeyNotBlockedByRequire2FAGate verifies
// that the 2FA-enrollment precondition only applies to requests that actually
// change require_2fa. Once require_2fa is already on, a later PATCH that
// leaves it untouched (e.g. only motd) must not be rejected just because some
// user without TOTP now exists (targetBoolSetting falls back to the stored
// value, which is still "true", so validateRequire2FAUpdate must not
// re-run the enrollment count for a key nobody asked to change).
func TestAdminAPI_PatchSettings_UnrelatedKeyNotBlockedByRequire2FAGate(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	// Enroll the admin so the initial require_2fa enable succeeds.
	if _, err := database.ExecContext(context.Background(), `UPDATE users SET totp_secret = ? WHERE id = 1`, "JBSWY3DPEHPK3PXP"); err != nil {
		t.Fatalf("enroll admin user: %v", err)
	}

	enableBody := map[string]string{
		"registration_mode": "closed",
		"require_2fa":       "true",
	}
	w := doRequest(t, handler, http.MethodPatch, "/settings", token, enableBody)
	requireStatus(t, w, http.StatusOK)

	// A user without TOTP now exists (e.g. created after the gate closed, or
	// unbanned once a temporary ban lapsed) — CountUsersWithoutTOTP is now > 0.
	if _, err := database.CreateUser(context.Background(), "no-totp-user", "hash", 3); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	// An unrelated settings PATCH that never mentions require_2fa must still
	// succeed and actually write the change.
	motdBody := map[string]string{"motd": "Back online"}
	w = doRequest(t, handler, http.MethodPatch, "/settings", token, motdBody)
	requireStatus(t, w, http.StatusOK)

	val, err := database.GetSetting(context.Background(), "motd")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	if val != "Back online" {
		t.Errorf("motd = %q, want %q (unrelated PATCH must not be blocked by the require_2fa enrollment gate)", val, "Back online")
	}
}
