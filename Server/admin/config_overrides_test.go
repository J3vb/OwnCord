package admin_test

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Secret values the running config holds; none may ever leave the server
// through the config-overrides endpoints.
const (
	cfgOvGIFKey      = "klipy-secret-value-123"
	cfgOvGitHubToken = "ghp_secret_value_456"
	cfgOvLKSecret    = "livekit-secret-value-0123456789abcdef"
)

type configOverridesFixture struct {
	handler  http.Handler
	database *db.DB
	dataDir  string
	cfg      *config.Config
	restarts chan string
}

func newConfigOverridesFixture(t *testing.T) configOverridesFixture {
	t.Helper()
	t.Cleanup(admin.ResetRestartState)
	database := openAdminTestDB(t)
	dataDir := t.TempDir()
	cfg := &config.Config{}
	cfg.Server.DataDir = dataDir
	cfg.Server.MaxWSConnections = 100
	cfg.Logging.Level = "info"
	cfg.Database.Path = filepath.Join(dataDir, "chatserver.db")
	cfg.GIF.APIKey = cfgOvGIFKey
	cfg.GitHub.Token = cfgOvGitHubToken
	cfg.Voice.LiveKitAPISecret = cfgOvLKSecret
	restarts := make(chan string, 4)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{
			ConfigPath: filepath.Join(t.TempDir(), "config.yaml"),
			RunningCfg: cfg,
			Restart:    func(reason string) { restarts <- reason },
		})
	return configOverridesFixture{handler: handler, database: database, dataDir: dataDir, cfg: cfg, restarts: restarts}
}

type configOverridesResponse struct {
	Settings []struct {
		Key       string   `json:"key"`
		Type      string   `json:"type"`
		Value     any      `json:"value"`
		Override  any      `json:"override"`
		EnvLocked bool     `json:"env_locked"`
		Options   []string `json:"options"`
	} `json:"settings"`
	RestartPending bool `json:"restart_pending"`
}

func decodeConfigOverrides(t *testing.T, body []byte) configOverridesResponse {
	t.Helper()
	var resp configOverridesResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal %s: %v", body, err)
	}
	return resp
}

func (r configOverridesResponse) find(key string) (int, bool) {
	for i, s := range r.Settings {
		if s.Key == key {
			return i, true
		}
	}
	return -1, false
}

func TestConfigOverrides_GetListsEditableKeysOnly(t *testing.T) {
	f := newConfigOverridesFixture(t)
	token := createAdminUser(t, f.database)

	w := doRequest(t, f.handler, http.MethodGet, "/config/settings", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /config/settings = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	for _, secret := range []string{cfgOvGIFKey, cfgOvGitHubToken, cfgOvLKSecret} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatalf("GET /config/settings leaked a secret value: %s", w.Body.String())
		}
	}
	resp := decodeConfigOverrides(t, w.Body.Bytes())
	if got, want := len(resp.Settings), len(config.EditableKeys()); got != want {
		t.Errorf("settings rows = %d, want one per editable key (%d)", got, want)
	}
	for _, key := range []string{"gif.api_key", "github.token", "voice.livekit_api_secret", "database.path", "server.admin_allowed_cidrs"} {
		if _, ok := resp.find(key); ok {
			t.Errorf("GET /config/settings lists protected key %q", key)
		}
	}
	i, ok := resp.find("logging.level")
	if !ok {
		t.Fatal("GET /config/settings has no logging.level row")
	}
	row := resp.Settings[i]
	if row.Type != "string" || row.Value != "info" || row.Override != nil || row.EnvLocked {
		t.Errorf("logging.level row = %+v, want type string, value info, no override, not env-locked", row)
	}
	if !slices.Equal(row.Options, []string{"debug", "info", "warn", "error"}) {
		t.Errorf("logging.level options = %v, want [debug info warn error]", row.Options)
	}
	if i, ok := resp.find("server.max_ws_connections"); !ok || resp.Settings[i].Type != "int" || resp.Settings[i].Value != float64(100) {
		t.Errorf("server.max_ws_connections row = %+v, want type int, value 100", resp.Settings)
	}
	if resp.RestartPending {
		t.Error("restart_pending = true before any change")
	}
}

func TestConfigOverrides_OwnerOnly(t *testing.T) {
	f := newConfigOverridesFixture(t)
	_, manageToken := createRoleUser(t, f.database, 20, "ServerAdmin", permissions.ManageServer, 50, "cfgovmanage")
	_, adminToken := createRoleUser(t, f.database, 21, "Administrator", permissions.Administrator, 90, "cfgovadmin")

	for _, tok := range []string{manageToken, adminToken} {
		for _, req := range []struct {
			method, path string
			body         any
		}{
			{http.MethodGet, "/config/settings", nil},
			{http.MethodPatch, "/config/settings", map[string]any{"logging.level": "debug"}},
			{http.MethodPost, "/restart", nil},
		} {
			if w := doRequest(t, f.handler, req.method, req.path, tok, req.body); w.Code != http.StatusForbidden {
				t.Errorf("non-owner %s %s = %d, want 403; body: %s", req.method, req.path, w.Code, w.Body.String())
			}
		}
	}
	overrides, err := config.ReadOverrides(config.OverridesPath(f.dataDir))
	if err != nil || len(overrides) != 0 {
		t.Errorf("a refused PATCH wrote overrides: %v, %v", overrides, err)
	}
	select {
	case reason := <-f.restarts:
		t.Errorf("a refused POST /restart restarted the server (reason %q)", reason)
	default:
	}
}

func TestConfigOverrides_PatchSavesAndMarksRestartPending(t *testing.T) {
	f := newConfigOverridesFixture(t)
	token := createAdminUser(t, f.database)

	w := doRequest(t, f.handler, http.MethodPatch, "/config/settings", token,
		map[string]any{"logging.level": "debug", "server.max_ws_connections": 250})
	if w.Code != http.StatusOK {
		t.Fatalf("PATCH = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	resp := decodeConfigOverrides(t, w.Body.Bytes())
	if !resp.RestartPending {
		t.Error("restart_pending = false after a saved change")
	}
	i, _ := resp.find("logging.level")
	if i < 0 || resp.Settings[i].Override != "debug" || resp.Settings[i].Value != "info" {
		t.Errorf("logging.level row after PATCH = %+v, want override debug and running value still info (restart required)", resp.Settings)
	}

	saved, err := config.ReadOverrides(config.OverridesPath(f.dataDir))
	if err != nil {
		t.Fatalf("ReadOverrides: %v", err)
	}
	if saved["logging.level"] != "debug" {
		t.Errorf("overrides file = %v, want logging.level debug", saved)
	}

	// GET reflects the same state; nothing was applied to the running config.
	w = doRequest(t, f.handler, http.MethodGet, "/config/settings", token, nil)
	if got := decodeConfigOverrides(t, w.Body.Bytes()); !got.RestartPending {
		t.Error("GET restart_pending = false after a saved change")
	}
	if f.cfg.Logging.Level != "info" {
		t.Errorf("running cfg logging.level = %q, want unchanged info", f.cfg.Logging.Level)
	}

	// null resets the key to its config.yaml value.
	w = doRequest(t, f.handler, http.MethodPatch, "/config/settings", token, map[string]any{"logging.level": nil})
	if w.Code != http.StatusOK {
		t.Fatalf("PATCH reset = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	saved, _ = config.ReadOverrides(config.OverridesPath(f.dataDir))
	if _, ok := saved["logging.level"]; ok {
		t.Errorf("overrides file still has logging.level after a null PATCH: %v", saved)
	}
}

func TestConfigOverrides_PatchRejectsBadInput(t *testing.T) {
	f := newConfigOverridesFixture(t)
	token := createAdminUser(t, f.database)

	for _, body := range []map[string]any{
		{},
		{"database.path": "/elsewhere.db"},
		{"gif.api_key": "x"},
		{"server.nope": 1},
		{"logging.level": "loud"},
		{"voice.udp_port": 70000},
		{"logging.level": "debug", "server.waf_paranoia_level": 9},
	} {
		w := doRequest(t, f.handler, http.MethodPatch, "/config/settings", token, body)
		if w.Code != http.StatusBadRequest {
			t.Errorf("PATCH %v = %d, want 400; body: %s", body, w.Code, w.Body.String())
			continue
		}
		named := len(body) == 0
		for key := range body {
			named = named || strings.Contains(w.Body.String(), key)
		}
		if !named {
			t.Errorf("PATCH %v 400 body %s names none of the keys", body, w.Body.String())
		}
	}
	saved, err := config.ReadOverrides(config.OverridesPath(f.dataDir))
	if err != nil || len(saved) != 0 {
		t.Errorf("refused PATCHes wrote overrides: %v, %v", saved, err)
	}
}

// A key pinned by OWNCORD_* would be saved and then silently lose to the
// environment at the next boot; the panel refuses it instead.
func TestConfigOverrides_PatchRefusesEnvLockedKey(t *testing.T) {
	t.Setenv("OWNCORD_LOGGING_LEVEL", "warn")
	f := newConfigOverridesFixture(t)
	token := createAdminUser(t, f.database)

	w := doRequest(t, f.handler, http.MethodGet, "/config/settings", token, nil)
	resp := decodeConfigOverrides(t, w.Body.Bytes())
	if i, ok := resp.find("logging.level"); !ok || !resp.Settings[i].EnvLocked {
		t.Errorf("logging.level env_locked = false with OWNCORD_LOGGING_LEVEL set")
	}

	w = doRequest(t, f.handler, http.MethodPatch, "/config/settings", token, map[string]any{"logging.level": "debug"})
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "ENV_OVERRIDDEN") {
		t.Errorf("PATCH env-locked key = %d %s, want 409 ENV_OVERRIDDEN", w.Code, w.Body.String())
	}
	saved, _ := config.ReadOverrides(config.OverridesPath(f.dataDir))
	if len(saved) != 0 {
		t.Errorf("env-locked PATCH wrote overrides: %v", saved)
	}
}

func TestConfigOverrides_PatchIsAuditedWithoutValues(t *testing.T) {
	f := newConfigOverridesFixture(t)
	token := createAdminUser(t, f.database)
	rec := audittest.Install(t, f.database)

	const contact = "ops-person@example.com"
	w := doRequest(t, f.handler, http.MethodPatch, "/config/settings", token, map[string]any{"push.contact": contact})
	if w.Code != http.StatusOK {
		t.Fatalf("PATCH = %d; body: %s", w.Code, w.Body.String())
	}
	entry := rec.Wait(t, "config_override_change")
	if !strings.Contains(entry.Detail, "push.contact") {
		t.Errorf("audit detail %q does not name the key", entry.Detail)
	}
	audittest.AssertSafeDetails(t, rec.Entries(), contact, token)
}

func TestConfigOverrides_RestartNow(t *testing.T) {
	f := newConfigOverridesFixture(t)
	token := createAdminUser(t, f.database)
	rec := audittest.Install(t, f.database)

	w := doRequest(t, f.handler, http.MethodPost, "/restart", token, nil)
	if w.Code != http.StatusAccepted {
		t.Fatalf("POST /restart = %d, want 202; body: %s", w.Code, w.Body.String())
	}
	if reason := <-f.restarts; reason != "config_change" {
		t.Errorf("restart reason = %q, want config_change", reason)
	}
	rec.Wait(t, "server_restart_requested")

	// The process is now committed to restarting: a second request loses.
	w = doRequest(t, f.handler, http.MethodPost, "/restart", token, nil)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "RESTART_PENDING") {
		t.Errorf("second POST /restart = %d %s, want 409 RESTART_PENDING", w.Code, w.Body.String())
	}
}
