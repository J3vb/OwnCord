package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

// wizardRunningCfg mimics the config a fresh server boots with: file defaults
// plus the runtime-generated LiveKit credentials.
func wizardRunningCfg() *config.Config {
	return &config.Config{
		Server: config.ServerConfig{Port: 8443, Name: "OwnCord Server"},
		TLS:    config.TLSConfig{Mode: "self_signed"},
		Upload: config.UploadConfig{MaxSizeMB: 100},
		Voice: config.VoiceConfig{
			LiveKitAPIKey:    "key-generated123",
			LiveKitAPISecret: "generated-secret-0123456789abcdef",
			Quality:          "medium",
		},
	}
}

// wizardHandler builds the admin API with wizard options and a restart stub
// that signals restarted (buffered) instead of respawning the process.
func wizardHandler(t *testing.T, database *db.DB, cfgPath string, restarted chan string) http.Handler {
	t.Helper()
	return admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database),
		admin.SetupOptions{
			ConfigPath: cfgPath,
			RunningCfg: wizardRunningCfg(),
			Restart:    func(reason string) { restarted <- reason },
		})
}

func getSetting(t *testing.T, database *db.DB, key string) string {
	t.Helper()
	v, err := database.GetSetting(context.Background(), key)
	if err != nil {
		t.Fatalf("GetSetting(%q): %v", key, err)
	}
	return v
}

func TestSetupWizard_FullFlow(t *testing.T) {
	database := openAdminTestDB(t)
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	restarted := make(chan string, 1)
	handler := wizardHandler(t, database, cfgPath, restarted)

	rr := doRequest(t, handler, "POST", "/setup", "", map[string]any{
		"username": "owner",
		"password": "SecurePass123!",
		"wizard": map[string]any{
			"server_name":         "My Cool Server",
			"motd":                "Welcome friends!",
			"registration_open":   true,
			"port":                9000,
			"tls_mode":            "off",
			"upload_max_size_mb":  250,
			"voice_quality":       "high",
			"voice_auto_download": true,
		},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /setup = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Token           string   `json:"token"`
		InviteCode      string   `json:"invite_code"`
		RestartRequired bool     `json:"restart_required"`
		RestartURL      string   `json:"restart_url"`
		Warnings        []string `json:"warnings"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Token == "" || resp.InviteCode == "" {
		t.Error("token/invite_code missing — account creation should be unchanged")
	}
	if len(resp.Warnings) != 0 {
		t.Errorf("warnings = %v, want none", resp.Warnings)
	}
	if !resp.RestartRequired {
		t.Fatal("restart_required = false, want true (port and tls changed)")
	}
	// httptest requests carry Host "example.com"; tls off → http scheme.
	if resp.RestartURL != "http://example.com:9000/admin" {
		t.Errorf("restart_url = %q, want %q", resp.RestartURL, "http://example.com:9000/admin")
	}

	select {
	case reason := <-restarted:
		if reason != "setup_wizard" {
			t.Errorf("restart reason = %q, want setup_wizard", reason)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restart hook was never invoked")
	}

	// DB settings the app reads live.
	if got := getSetting(t, database, "server_name"); got != "My Cool Server" {
		t.Errorf("server_name = %q", got)
	}
	if got := getSetting(t, database, "motd"); got != "Welcome friends!" {
		t.Errorf("motd = %q", got)
	}
	if got := getSetting(t, database, "registration_open"); got != "1" {
		t.Errorf("registration_open = %q, want 1", got)
	}
	if got := getSetting(t, database, "max_upload_bytes"); got != "262144000" {
		t.Errorf("max_upload_bytes = %q, want 262144000 (250 MB)", got)
	}
	if got := getSetting(t, database, "voice_quality"); got != "high" {
		t.Errorf("voice_quality = %q, want high", got)
	}

	// config.yaml written with the wizard values + persisted voice creds.
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("loading wizard-written config: %v", err)
	}
	if cfg.Server.Port != 9000 {
		t.Errorf("config port = %d, want 9000", cfg.Server.Port)
	}
	if cfg.Server.Name != "My Cool Server" {
		t.Errorf("config server name = %q", cfg.Server.Name)
	}
	if cfg.TLS.Mode != "off" {
		t.Errorf("config tls mode = %q, want off", cfg.TLS.Mode)
	}
	if cfg.Upload.MaxSizeMB != 250 {
		t.Errorf("config upload max = %d, want 250", cfg.Upload.MaxSizeMB)
	}
	if cfg.Voice.Quality != "high" {
		t.Errorf("config voice quality = %q, want high", cfg.Voice.Quality)
	}
	if cfg.Voice.LiveKitAPIKey != "key-generated123" {
		t.Errorf("LiveKit key = %q — the running credentials were not persisted", cfg.Voice.LiveKitAPIKey)
	}
	if cfg.Voice.LiveKitAPISecret != "generated-secret-0123456789abcdef" {
		t.Errorf("LiveKit secret = %q — the running credentials were not persisted", cfg.Voice.LiveKitAPISecret)
	}
	if !cfg.Voice.AutoDownloadLiveKit {
		t.Error("config voice.auto_download_livekit = false, want true from wizard toggle")
	}
}

func TestSetupWizard_NoRestartWhenValuesMatchRunning(t *testing.T) {
	database := openAdminTestDB(t)
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	restarted := make(chan string, 1)
	handler := wizardHandler(t, database, cfgPath, restarted)

	// Same port/tls/upload/voice as the running config; only live-read
	// values (name, motd) change.
	rr := doRequest(t, handler, "POST", "/setup", "", map[string]any{
		"username": "owner",
		"password": "SecurePass123!",
		"wizard": map[string]any{
			"server_name":        "Renamed Server",
			"motd":               "hi",
			"port":               8443,
			"tls_mode":           "self_signed",
			"upload_max_size_mb": 100,
			"voice_quality":      "medium",
		},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /setup = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}

	var resp struct {
		RestartRequired bool   `json:"restart_required"`
		RestartURL      string `json:"restart_url"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.RestartRequired {
		t.Error("restart_required = true, want false (no startup-only value changed)")
	}
	if resp.RestartURL != "" {
		t.Errorf("restart_url = %q, want empty", resp.RestartURL)
	}
	select {
	case <-restarted:
		t.Error("restart hook invoked though nothing needed a restart")
	case <-time.After(100 * time.Millisecond):
	}

	// Config is still written (server.name changed on disk).
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("loading wizard-written config: %v", err)
	}
	if cfg.Server.Name != "Renamed Server" {
		t.Errorf("config server name = %q, want Renamed Server", cfg.Server.Name)
	}
}

func TestSetupWizard_InvalidValuesRejectBeforeAccountCreation(t *testing.T) {
	cases := map[string]map[string]any{
		"port too low":         {"port": 0},
		"port too high":        {"port": 70000},
		"bad tls mode":         {"tls_mode": "quantum"},
		"acme without domain":  {"tls_mode": "acme"},
		"bad domain chars":     {"tls_mode": "acme", "tls_domain": "not a domain!"},
		"single-label domain":  {"tls_mode": "acme", "tls_domain": "localhost"},
		"upload zero":          {"upload_max_size_mb": 0},
		"upload too large":     {"upload_max_size_mb": 20000},
		"bad voice quality":    {"voice_quality": "ultra"},
		"empty server name":    {"server_name": "   "},
		"tag-only server name": {"server_name": "<b></b>"},
	}

	for name, wizard := range cases {
		t.Run(name, func(t *testing.T) {
			database := openAdminTestDB(t)
			cfgPath := filepath.Join(t.TempDir(), "config.yaml")
			restarted := make(chan string, 1)
			handler := wizardHandler(t, database, cfgPath, restarted)

			rr := doRequest(t, handler, "POST", "/setup", "", map[string]any{
				"username": "owner",
				"password": "SecurePass123!",
				"wizard":   wizard,
			})
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rr.Code, rr.Body.String())
			}
			count, err := database.UserCount(context.Background())
			if err != nil {
				t.Fatalf("UserCount: %v", err)
			}
			if count != 0 {
				t.Errorf("user count = %d, want 0 — invalid wizard payload must reject before account creation", count)
			}
			if _, err := os.Stat(cfgPath); !os.IsNotExist(err) {
				t.Error("config file written despite rejected payload")
			}
		})
	}
}

func TestSetupWizard_ConfigWriteFailureWarnsButCreatesAccount(t *testing.T) {
	database := openAdminTestDB(t)
	// Point at a directory that does not exist so the atomic write fails.
	cfgPath := filepath.Join(t.TempDir(), "missing-dir", "config.yaml")
	restarted := make(chan string, 1)
	handler := wizardHandler(t, database, cfgPath, restarted)

	rr := doRequest(t, handler, "POST", "/setup", "", map[string]any{
		"username": "owner",
		"password": "SecurePass123!",
		"wizard":   map[string]any{"port": 9000},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /setup = %d, want 201 despite config failure; body=%s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Token           string   `json:"token"`
		RestartRequired bool     `json:"restart_required"`
		Warnings        []string `json:"warnings"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Token == "" {
		t.Error("token missing — the account must still be created")
	}
	if len(resp.Warnings) == 0 {
		t.Error("warnings empty, want a config-write warning")
	}
	if resp.RestartRequired {
		t.Error("restart_required = true, but the config was never written — restarting would change nothing")
	}
	select {
	case <-restarted:
		t.Error("restart hook invoked after a failed config write")
	case <-time.After(100 * time.Millisecond):
	}

	count, err := database.UserCount(context.Background())
	if err != nil {
		t.Fatalf("UserCount: %v", err)
	}
	if count != 1 {
		t.Errorf("user count = %d, want 1", count)
	}
}

func TestSetupWizard_LegacyPayloadUnchangedBehaviour(t *testing.T) {
	database := openAdminTestDB(t)
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	restarted := make(chan string, 1)
	handler := wizardHandler(t, database, cfgPath, restarted)

	rr := doRequest(t, handler, "POST", "/setup", "", map[string]string{
		"username": "owner",
		"password": "SecurePass123!",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("legacy POST /setup = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}

	var resp struct {
		RestartRequired bool     `json:"restart_required"`
		Warnings        []string `json:"warnings"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.RestartRequired || len(resp.Warnings) != 0 {
		t.Error("legacy payload must not trigger restarts or warnings")
	}
	if _, err := os.Stat(cfgPath); !os.IsNotExist(err) {
		t.Error("legacy payload must not write config.yaml")
	}
	select {
	case <-restarted:
		t.Error("legacy payload must not restart the server")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestSetupStatus_DefaultsOnlyPreSetupAndSecretFree(t *testing.T) {
	database := openAdminTestDB(t)
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	restarted := make(chan string, 1)
	handler := wizardHandler(t, database, cfgPath, restarted)

	rr := doRequest(t, handler, "GET", "/setup/status", "", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /setup/status = %d, want 200", rr.Code)
	}
	var resp struct {
		NeedsSetup bool `json:"needs_setup"`
		Defaults   *struct {
			ServerName      string `json:"server_name"`
			Motd            string `json:"motd"`
			Port            int    `json:"port"`
			TLSMode         string `json:"tls_mode"`
			UploadMaxSizeMB int    `json:"upload_max_size_mb"`
			VoiceQuality    string `json:"voice_quality"`
		} `json:"defaults"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp.NeedsSetup || resp.Defaults == nil {
		t.Fatalf("pre-setup status should carry defaults; body=%s", rr.Body.String())
	}
	// server_name/motd come from the seeded settings table, the rest from the
	// running config.
	if resp.Defaults.ServerName != "Test Server" {
		t.Errorf("defaults.server_name = %q, want Test Server (DB value)", resp.Defaults.ServerName)
	}
	if resp.Defaults.Motd != "Hello" {
		t.Errorf("defaults.motd = %q, want Hello (DB value)", resp.Defaults.Motd)
	}
	if resp.Defaults.Port != 8443 || resp.Defaults.TLSMode != "self_signed" ||
		resp.Defaults.UploadMaxSizeMB != 100 || resp.Defaults.VoiceQuality != "medium" {
		t.Errorf("config-derived defaults wrong: %+v", resp.Defaults)
	}
	// Never leak credentials through the unauthenticated status endpoint.
	lower := strings.ToLower(rr.Body.String())
	for _, needle := range []string{"livekit", "secret", "api_key", "token", "cidr"} {
		if strings.Contains(lower, needle) {
			t.Errorf("status response leaks %q: %s", needle, rr.Body.String())
		}
	}

	// After setup completes, defaults disappear along with needs_setup.
	rr2 := doRequest(t, handler, "POST", "/setup", "", map[string]string{
		"username": "owner", "password": "SecurePass123!",
	})
	if rr2.Code != http.StatusCreated {
		t.Fatalf("setup = %d, want 201", rr2.Code)
	}
	rr3 := doRequest(t, handler, "GET", "/setup/status", "", nil)
	if !strings.Contains(rr3.Body.String(), `"needs_setup":false`) {
		t.Errorf("post-setup status = %s, want needs_setup false", rr3.Body.String())
	}
	if strings.Contains(rr3.Body.String(), "defaults") {
		t.Errorf("post-setup status still exposes defaults: %s", rr3.Body.String())
	}
}

func TestSetupWizard_ForeignOriginBlocked(t *testing.T) {
	database := openAdminTestDB(t)
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	restarted := make(chan string, 1)
	handler := wizardHandler(t, database, cfgPath, restarted)

	body := map[string]any{
		"username": "owner",
		"password": "SecurePass123!",
		"wizard":   map[string]any{"port": 9000},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest("POST", "/setup", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("wizard POST from foreign origin = %d, want 403", rr.Code)
	}
	if _, err := os.Stat(cfgPath); !os.IsNotExist(err) {
		t.Error("config file written from a cross-origin request")
	}
}
