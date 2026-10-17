package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

const containerYAML = "# owner-edited, read-only in a container\nserver:\n  port: 8443\n"

// containerWizard wires the setup wizard the way a container runs it:
// OWNCORD_CONTAINER=1, a read-only-in-spirit config.yaml, and a data volume.
type containerWizard struct {
	handler   http.Handler
	database  *db.DB
	cfgPath   string
	dataDir   string
	overrides string
	restarted chan string
}

func newContainerWizard(t *testing.T, dataDir string) *containerWizard {
	t.Helper()
	t.Setenv("OWNCORD_CONTAINER", "1")
	t.Cleanup(admin.ResetRestartState)
	database := openAdminTestDB(t)
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(cfgPath, []byte(containerYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	if dataDir == "" {
		dataDir = t.TempDir()
	}
	running := wizardRunningCfg()
	running.Server.DataDir = dataDir
	restarted := make(chan string, 1)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{
			ConfigPath: cfgPath,
			RunningCfg: running,
			Restart:    func(reason string) { restarted <- reason },
		})
	return &containerWizard{handler, database, cfgPath, dataDir, config.OverridesPath(dataDir), restarted}
}

type containerSetupResp struct {
	Token           string   `json:"token"`
	RestartRequired bool     `json:"restart_required"`
	Warnings        []string `json:"warnings"`
}

func (c *containerWizard) post(t *testing.T, wizard map[string]any) (int, containerSetupResp) {
	t.Helper()
	rr := doRequest(t, c.handler, "POST", "/setup", "", map[string]any{
		"username": "owner", "password": "SecurePass123!", "wizard": wizard,
	})
	var resp containerSetupResp
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	return rr.Code, resp
}

func (c *containerWizard) overridesMap(t *testing.T) map[string]any {
	t.Helper()
	got, err := config.ReadOverrides(c.overrides)
	if err != nil {
		t.Fatalf("ReadOverrides: %v", err)
	}
	return got
}

func (c *containerWizard) configBytes(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(c.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSetupWizard_ContainerWritesOverridesNotConfigYAML(t *testing.T) {
	c := newContainerWizard(t, "")
	code, resp := c.post(t, map[string]any{"tls_mode": "off", "upload_max_size_mb": 250})
	if code != http.StatusCreated {
		t.Fatalf("POST /setup = %d", code)
	}
	if !bytes.Equal(c.configBytes(t), []byte(containerYAML)) {
		t.Error("config.yaml was modified in a container")
	}
	got := c.overridesMap(t)
	if got["tls.mode"] != "off" || got["upload.max_size_mb"] != 250 {
		t.Errorf("overrides = %v, want tls.mode=off and upload.max_size_mb=250", got)
	}
	if !resp.RestartRequired {
		t.Error("restart_required = false, want true")
	}
	if len(resp.Warnings) != 0 {
		t.Errorf("warnings = %v", resp.Warnings)
	}
	select {
	case <-c.restarted:
	case <-time.After(5 * time.Second):
		t.Fatal("restart hook was never invoked")
	}
}

func TestSetupWizard_ContainerSkipsUnchangedAndEnvPinnedKeys(t *testing.T) {
	t.Setenv("OWNCORD_VOICE_QUALITY", "medium")
	c := newContainerWizard(t, "")
	code, _ := c.post(t, map[string]any{
		"port": 8443, "tls_mode": "self_signed", "voice_quality": "high",
		"voice_auto_download": true, "upload_max_size_mb": 250,
	})
	if code != http.StatusCreated {
		t.Fatalf("POST /setup = %d", code)
	}
	got := c.overridesMap(t)
	for _, key := range []string{"server.port", "tls.mode", "voice.quality"} {
		if _, ok := got[key]; ok {
			t.Errorf("overrides carry %s: unchanged and env-pinned keys must be left out", key)
		}
	}
	if got["upload.max_size_mb"] != 250 || got["voice.auto_download_livekit"] != true {
		t.Errorf("overrides = %v, want the two changed keys", got)
	}
}

func TestSetupWizard_ContainerPersistsGeneratedLiveKitCredentialsOnlyWhenUnset(t *testing.T) {
	t.Run("unset below", func(t *testing.T) {
		c := newContainerWizard(t, "")
		if code, _ := c.post(t, map[string]any{"upload_max_size_mb": 250}); code != http.StatusCreated {
			t.Fatalf("POST /setup = %d", code)
		}
		got := c.overridesMap(t)
		if got["voice.livekit_api_key"] != "key-generated123" || got["voice.livekit_api_secret"] != "generated-secret-0123456789abcdef" {
			t.Errorf("generated credentials not persisted: keys=%d", len(got))
		}
	})
	t.Run("pinned by environment", func(t *testing.T) {
		t.Setenv("OWNCORD_VOICE_LIVEKIT_API_KEY", "env-pinned-key")
		c := newContainerWizard(t, "")
		if code, _ := c.post(t, map[string]any{"upload_max_size_mb": 250}); code != http.StatusCreated {
			t.Fatalf("POST /setup = %d", code)
		}
		got := c.overridesMap(t)
		for _, key := range []string{"voice.livekit_api_key", "voice.livekit_api_secret"} {
			if _, ok := got[key]; ok {
				t.Errorf("overrides carry %s although the environment supplies the credentials", key)
			}
		}
	})
}

func TestSetupWizard_ContainerRefusesPortChangeBeforeAccount(t *testing.T) {
	c := newContainerWizard(t, "")
	code, _ := c.post(t, map[string]any{"port": 9000})
	if code != http.StatusBadRequest {
		t.Fatalf("POST /setup = %d, want 400", code)
	}
	n, err := c.database.UserCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("user count = %d, want 0", n)
	}
	if _, err := os.Stat(c.overrides); !os.IsNotExist(err) {
		t.Error("overrides file written for a refused request")
	}
	// The unchanged port is accepted.
	if code, _ := c.post(t, map[string]any{"port": 8443}); code != http.StatusCreated {
		t.Errorf("same port: POST /setup = %d, want 201", code)
	}
}

func TestSetupWizard_ContainerSaveFailureIsWarningNoRestart(t *testing.T) {
	c := newContainerWizard(t, filepath.Join(t.TempDir(), "missing-volume"))
	code, resp := c.post(t, map[string]any{"tls_mode": "off"})
	if code != http.StatusCreated {
		t.Fatalf("POST /setup = %d, want 201", code)
	}
	if resp.Token == "" || len(resp.Warnings) == 0 {
		t.Errorf("token=%q warnings=%v, want a token and a warning", resp.Token, resp.Warnings)
	}
	if resp.RestartRequired {
		t.Error("restart_required = true after a failed save")
	}
	select {
	case <-c.restarted:
		t.Error("restart hook invoked after a failed save")
	case <-time.After(100 * time.Millisecond):
	}
	n, err := c.database.UserCount(context.Background())
	if err != nil || n != 1 {
		t.Errorf("user count = %d, err = %v, want 1", n, err)
	}
}

func TestSetupWizard_BareMetalStillWritesConfigYAML(t *testing.T) {
	database := openAdminTestDB(t)
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	t.Setenv("OWNCORD_CONTAINER", "0")
	handler := wizardHandler(t, database, cfgPath, make(chan string, 1))
	rr := doRequest(t, handler, "POST", "/setup", "", map[string]any{
		"username": "owner", "password": "SecurePass123!",
		"wizard": map[string]any{"port": 9000, "upload_max_size_mb": 250},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /setup = %d; body=%s", rr.Code, rr.Body.String())
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 9000 || cfg.Upload.MaxSizeMB != 250 {
		t.Errorf("config.yaml port=%d upload=%d, want 9000 and 250", cfg.Server.Port, cfg.Upload.MaxSizeMB)
	}
}

func TestSetupStatus_DefaultsReportPortLockedInContainer(t *testing.T) {
	locked := func(t *testing.T, container string) (present bool, value bool) {
		t.Helper()
		t.Setenv("OWNCORD_CONTAINER", container)
		database := openAdminTestDB(t)
		handler := wizardHandler(t, database, filepath.Join(t.TempDir(), "config.yaml"), make(chan string, 1))
		rr := doRequest(t, handler, "GET", "/setup/status", "", nil)
		var resp struct {
			Defaults map[string]any `json:"defaults"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		v, ok := resp.Defaults["port_locked"].(bool)
		return ok, v
	}
	if present, v := locked(t, "1"); !present || !v {
		t.Error("port_locked missing or false in a container")
	}
	if present, _ := locked(t, "0"); present {
		t.Error("port_locked present outside a container")
	}
}
