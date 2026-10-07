package config_test

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

// panelEditableKeys is the exact set of config.yaml keys the owner may change
// from the admin panel through the overrides file. The sensitive ones carry
// extra rules: secrets are write-only (panelSecretKeys) and lock-out-capable
// keys need a typed confirmation and pass server-side guards
// (panelConfirmKeys). Only panelExcludedKeys stay out.
var panelEditableKeys = []string{
	"attention.delivery_drops_per_min",
	"attention.disk_warn_free_mb",
	"attention.reconnects_per_min",
	"attention.writer_wait_ms_per_min",
	"backup.dir",
	"database.max_readers",
	"database.path",
	"database.type",
	"event_persistence.batch_flush_ms",
	"event_persistence.batch_size",
	"event_persistence.enabled",
	"event_persistence.pruner_interval_minutes",
	"event_persistence.replay_cold_limit",
	"event_persistence.replay_ring_size",
	"event_persistence.retention_hours",
	"gif.api_key",
	"github.owner",
	"github.repo",
	"github.token",
	"logging.level",
	"moderation.action_retention_days",
	"moderation.report_retention_days",
	"plugins.cpu_budget_ms",
	"plugins.directory",
	"plugins.enabled",
	"plugins.http_allowlist",
	"plugins.max_memory_mb",
	"push.contact",
	"push.dispatch_enabled",
	"push.enabled",
	"push.subscription_ttl_days",
	"security.auth_rate_limit_multiplier",
	"security.expensive_auth_concurrency",
	"server.admin_allowed_cidrs",
	"server.allowed_origins",
	"server.browser_client_enabled",
	"server.livekit_webhook_allowed_cidrs",
	"server.max_ws_connections",
	"server.metrics_allowed_cidrs",
	"server.min_free_disk_mb",
	"server.port",
	"server.pprof_block_profile_rate",
	"server.pprof_enabled",
	"server.pprof_mutex_profile_fraction",
	"server.reachability_report_enabled",
	"server.restart_mode",
	"server.trusted_proxies",
	"server.waf_crs_mode",
	"server.waf_enabled",
	"server.waf_paranoia_level",
	"telemetry.enabled",
	"telemetry.exporter",
	"telemetry.otlp_endpoint",
	"telemetry.otlp_insecure",
	"telemetry.service_name",
	"tls.acme_cache_dir",
	"tls.cert_file",
	"tls.domain",
	"tls.key_file",
	"tls.mode",
	"upload.max_size_mb",
	"upload.storage_dir",
	"upload.user_quota_mb",
	"voice.advertise_internal_ip",
	"voice.auto_download_livekit",
	"voice.livekit_api_key",
	"voice.livekit_api_secret",
	"voice.livekit_binary",
	"voice.livekit_url",
	"voice.livekit_version",
	"voice.node_ip",
	"voice.quality",
	"voice.udp_port",
}

// panelExcludedKeys never go through the overrides file.
var panelExcludedKeys = []string{
	// The overrides file, totp.key, erasure and VAPID keys all live in
	// data_dir: an override would move the server away from its own keys and
	// from the file that holds the override. Shown read-only in the panel.
	"server.data_dir",
	// Already editable live on the Settings page through their own rows,
	// which replace config.yaml; a second panel value would be a third source.
	"upload.blocked_extensions", "upload.allowed_extensions", "server.name",
}

func TestEditableKeys_ExactInventory(t *testing.T) {
	got := config.EditableKeys()
	want := slices.Clone(panelEditableKeys)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("EditableKeys() =\n%v\nwant exactly\n%v", got, want)
	}
	if !slices.IsSorted(got) {
		t.Errorf("EditableKeys() is not sorted: %v", got)
	}
	for _, key := range panelEditableKeys {
		if !config.IsEditable(key) {
			t.Errorf("IsEditable(%q) = false, want true", key)
		}
	}
}

func TestEditableKeys_ProtectedKeysStayOut(t *testing.T) {
	for _, key := range panelExcludedKeys {
		if config.IsEditable(key) {
			t.Errorf("IsEditable(%q) = true; data_dir and the live upload-type lists must stay out of the overrides file", key)
		}
	}
	for _, key := range []string{"", "server", "server.nope", "SERVER.NAME"} {
		if config.IsEditable(key) {
			t.Errorf("IsEditable(%q) = true for a key that is not a config leaf", key)
		}
	}
	// Every config key is classified exactly once (parity_test pins 77).
	if n := len(panelEditableKeys) + len(panelExcludedKeys); n != 77 {
		t.Errorf("editable %d + excluded %d = %d keys, want all 77 classified",
			len(panelEditableKeys), len(panelExcludedKeys), n)
	}
}

func TestOverridesPath_IsInDataDir(t *testing.T) {
	dir := t.TempDir()
	if got, want := config.OverridesPath(dir), filepath.Join(dir, config.OverridesFileName); got != want {
		t.Errorf("OverridesPath(%q) = %q, want %q", dir, got, want)
	}
	if filepath.Ext(config.OverridesFileName) != ".json" {
		t.Errorf("OverridesFileName = %q, want a .json file", config.OverridesFileName)
	}
}

func TestReadOverrides_MissingFileIsEmpty(t *testing.T) {
	got, err := config.ReadOverrides(filepath.Join(t.TempDir(), config.OverridesFileName))
	if err != nil {
		t.Fatalf("ReadOverrides(missing) error = %v, want nil", err)
	}
	if len(got) != 0 {
		t.Errorf("ReadOverrides(missing) = %v, want empty", got)
	}
}

func TestSaveOverrides_RoundTripAndRemove(t *testing.T) {
	path := config.OverridesPath(t.TempDir())
	if err := config.SaveOverrides(path, map[string]any{
		"logging.level":                       "debug",
		"push.enabled":                        true,
		"server.max_ws_connections":           float64(500), // JSON numbers decode as float64
		"server.allowed_origins":              []any{"https://chat.example"},
		"security.auth_rate_limit_multiplier": 2.5,
	}); err != nil {
		t.Fatalf("SaveOverrides: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat overrides file: %v", err)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 && os.PathSeparator == '/' {
		t.Errorf("overrides file mode = %v, want owner-only (0600)", perm)
	}
	got, err := config.ReadOverrides(path)
	if err != nil {
		t.Fatalf("ReadOverrides: %v", err)
	}
	if got["logging.level"] != "debug" || got["push.enabled"] != true {
		t.Errorf("ReadOverrides = %v, want logging.level=debug and push.enabled=true", got)
	}
	if _, ok := got["server.max_ws_connections"]; !ok {
		t.Errorf("ReadOverrides = %v, want server.max_ws_connections kept", got)
	}

	// A nil value removes the key: the setting falls back to config.yaml.
	if err := config.SaveOverrides(path, map[string]any{"logging.level": nil}); err != nil {
		t.Fatalf("SaveOverrides(remove): %v", err)
	}
	got, err = config.ReadOverrides(path)
	if err != nil {
		t.Fatalf("ReadOverrides after remove: %v", err)
	}
	if _, ok := got["logging.level"]; ok {
		t.Errorf("logging.level still present after a nil save: %v", got)
	}
	if got["push.enabled"] != true {
		t.Errorf("an unrelated key was lost by the remove: %v", got)
	}
}

func TestSaveOverrides_RejectsProtectedAndUnknownKeys(t *testing.T) {
	for _, key := range []string{"server.data_dir", "upload.blocked_extensions", "server.nope"} {
		path := config.OverridesPath(t.TempDir())
		err := config.SaveOverrides(path, map[string]any{key: "x"})
		if !errors.Is(err, config.ErrNotEditable) {
			t.Errorf("SaveOverrides(%q) error = %v, want ErrNotEditable", key, err)
		}
		if err != nil && !strings.Contains(err.Error(), key) {
			t.Errorf("SaveOverrides(%q) error %q does not name the key", key, err)
		}
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Errorf("SaveOverrides(%q) wrote a file despite refusing the key", key)
		}
	}
}

func TestSaveOverrides_ValidatesValues(t *testing.T) {
	bad := []struct {
		key   string
		value any
	}{
		{"server.max_ws_connections", "abc"},
		{"server.max_ws_connections", 1.5},
		{"server.max_ws_connections", float64(-1)},
		{"voice.udp_port", float64(70000)},
		{"push.subscription_ttl_days", float64(0)},
		{"server.waf_paranoia_level", float64(5)},
		{"security.auth_rate_limit_multiplier", float64(1000)},
		{"logging.level", "loud"},
		{"server.waf_crs_mode", "panic"},
		{"voice.quality", "ultra"},
		{"telemetry.exporter", "zipkin"},
		{"server.metrics_allowed_cidrs", []any{"10.0.0.1"}}, // bare IP, not CIDR
		{"server.allowed_origins", []any{float64(1)}},
		{"push.enabled", "yes"},
	}
	for _, tc := range bad {
		path := config.OverridesPath(t.TempDir())
		err := config.SaveOverrides(path, map[string]any{tc.key: tc.value})
		if !errors.Is(err, config.ErrInvalidValue) {
			t.Errorf("SaveOverrides(%s=%#v) error = %v, want ErrInvalidValue", tc.key, tc.value, err)
			continue
		}
		if !strings.Contains(err.Error(), tc.key) {
			t.Errorf("SaveOverrides(%s=%#v) error %q does not name the key", tc.key, tc.value, err)
		}
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Errorf("SaveOverrides(%s=%#v) wrote a file despite the invalid value", tc.key, tc.value)
		}
	}

	good := map[string]any{
		"logging.level":                       "warn",
		"voice.udp_port":                      float64(7882),
		"server.metrics_allowed_cidrs":        []any{"10.0.0.0/8"},
		"server.max_ws_connections":           float64(0),
		"server.waf_paranoia_level":           float64(4),
		"security.auth_rate_limit_multiplier": 0.5,
		"server.waf_crs_mode":                 "block",
		"telemetry.exporter":                  "otlp",
		"voice.quality":                       "high",
	}
	if err := config.SaveOverrides(config.OverridesPath(t.TempDir()), good); err != nil {
		t.Errorf("SaveOverrides(valid values) error = %v, want nil", err)
	}
}

// One bad key refuses the whole batch: the file keeps its previous content.
func TestSaveOverrides_AllOrNothing(t *testing.T) {
	path := config.OverridesPath(t.TempDir())
	if err := config.SaveOverrides(path, map[string]any{"logging.level": "warn"}); err != nil {
		t.Fatalf("seed SaveOverrides: %v", err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}
	err = config.SaveOverrides(path, map[string]any{"logging.level": "debug", "voice.udp_port": float64(-5)})
	if !errors.Is(err, config.ErrInvalidValue) {
		t.Fatalf("SaveOverrides(mixed batch) error = %v, want ErrInvalidValue", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if !slices.Equal(before, after) {
		t.Errorf("a refused batch changed the file:\nbefore %s\nafter  %s", before, after)
	}
}

// writeYAML writes a config.yaml whose data_dir is dataDir and returns its path.
func writeYAML(t *testing.T, dataDir, extra string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	body := "server:\n  data_dir: \"" + filepath.ToSlash(dataDir) + "\"\n  max_ws_connections: 10\n" + extra
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write config.yaml: %v", err)
	}
	return path
}

func writeOverrides(t *testing.T, dataDir, body string) {
	t.Helper()
	if err := os.WriteFile(config.OverridesPath(dataDir), []byte(body), 0o600); err != nil {
		t.Fatalf("write overrides: %v", err)
	}
}

// Precedence: defaults < config.yaml < admin-panel overrides < OWNCORD_* env.
func TestLoad_OverridesLayerBetweenYAMLAndEnv(t *testing.T) {
	dataDir := t.TempDir()
	cfgPath := writeYAML(t, dataDir, "logging:\n  level: \"info\"\n")
	writeOverrides(t, dataDir, `{"server.max_ws_connections": 20, "logging.level": "debug"}`)

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server.MaxWSConnections != 20 {
		t.Errorf("max_ws_connections = %d, want 20 (panel override beats config.yaml's 10)", cfg.Server.MaxWSConnections)
	}
	if cfg.Logging.Level != "debug" {
		t.Errorf("logging.level = %q, want debug (panel override)", cfg.Logging.Level)
	}

	t.Setenv("OWNCORD_SERVER_MAX_WS_CONNECTIONS", "30")
	cfg, err = config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load with env: %v", err)
	}
	if cfg.Server.MaxWSConnections != 30 {
		t.Errorf("max_ws_connections = %d, want 30 (environment beats the panel override)", cfg.Server.MaxWSConnections)
	}
}

func TestLoad_NoOverridesFileKeepsYAML(t *testing.T) {
	dataDir := t.TempDir()
	cfg, err := config.Load(writeYAML(t, dataDir, ""))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server.MaxWSConnections != 10 {
		t.Errorf("max_ws_connections = %d, want config.yaml's 10", cfg.Server.MaxWSConnections)
	}
}

// A hand-edited overrides file cannot reach a protected key. data_dir is the
// anchor the overrides file is read from, so it can never move itself.
func TestLoad_OverridesIgnoreProtectedKeys(t *testing.T) {
	dataDir := t.TempDir()
	cfgPath := writeYAML(t, dataDir, "")
	writeOverrides(t, dataDir, `{"server.data_dir": "/elsewhere", "server.max_ws_connections": 20}`)

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server.DataDir != filepath.ToSlash(dataDir) && cfg.Server.DataDir != dataDir {
		t.Errorf("server.data_dir = %q, want config.yaml's %q (not panel-editable)", cfg.Server.DataDir, dataDir)
	}
	if cfg.Server.MaxWSConnections != 20 {
		t.Errorf("max_ws_connections = %d, want 20: an ignored key must not drop the valid ones", cfg.Server.MaxWSConnections)
	}
}

// A hand-edited overrides file with an editable key holding the wrong type
// used to reach the boot YAML unmarshal and refuse to start. The read boundary
// now drops the bad value; the valid keys in the same file still apply.
func TestLoad_OverridesIgnoreWrongTypedValue(t *testing.T) {
	dataDir := t.TempDir()
	cfgPath := writeYAML(t, dataDir, "")
	writeOverrides(t, dataDir, `{"logging.level": 5, "server.max_ws_connections": "10", "push.enabled": true}`)

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load with a wrong-typed override: %v", err)
	}
	if cfg.Logging.Level != "info" {
		t.Errorf("logging.level = %q, want the default info (wrong-typed override dropped)", cfg.Logging.Level)
	}
	if cfg.Server.MaxWSConnections != 10 {
		t.Errorf("max_ws_connections = %d, want config.yaml's 10 (wrong-typed override dropped)", cfg.Server.MaxWSConnections)
	}
	if !cfg.Push.Enabled {
		t.Error("push.enabled = false, want true: dropping a bad key must not drop the valid ones")
	}
}

func TestLoad_CorruptOverridesFails(t *testing.T) {
	dataDir := t.TempDir()
	cfgPath := writeYAML(t, dataDir, "")
	writeOverrides(t, dataDir, `{"server.max_ws_connections": `)

	_, err := config.Load(cfgPath)
	if err == nil {
		t.Fatal("Load with a corrupt overrides file succeeded, want an error")
	}
	if !strings.Contains(err.Error(), config.OverridesFileName) {
		t.Errorf("Load error %q does not name the overrides file", err)
	}
}

func TestLookup_ReadsRunningValueByKey(t *testing.T) {
	cfg := &config.Config{}
	cfg.Server.MaxWSConnections = 42
	cfg.Logging.Level = "warn"
	cfg.Push.Enabled = true
	cfg.Server.AllowedOrigins = []string{"https://a.example"}
	for key, want := range map[string]any{
		"server.max_ws_connections": 42,
		"logging.level":             "warn",
		"push.enabled":              true,
	} {
		got, ok := config.Lookup(cfg, key)
		if !ok || got != want {
			t.Errorf("Lookup(%q) = %#v, %v; want %#v, true", key, got, ok, want)
		}
	}
	if got, ok := config.Lookup(cfg, "server.allowed_origins"); !ok || !slices.Equal(got.([]string), cfg.Server.AllowedOrigins) {
		t.Errorf("Lookup(server.allowed_origins) = %#v, %v", got, ok)
	}
	if _, ok := config.Lookup(cfg, "server.nope"); ok {
		t.Error("Lookup(unknown key) ok = true, want false")
	}
}

func TestEnvOverridden(t *testing.T) {
	t.Setenv("OWNCORD_LOGGING_LEVEL", "warn")
	t.Setenv("OWNCORD_EVENT_PERSISTENCE_BATCH_SIZE", "10")
	if !config.EnvOverridden("logging.level") {
		t.Error("EnvOverridden(logging.level) = false with OWNCORD_LOGGING_LEVEL set")
	}
	if !config.EnvOverridden("event_persistence.batch_size") {
		t.Error("EnvOverridden(event_persistence.batch_size) = false with OWNCORD_EVENT_PERSISTENCE_BATCH_SIZE set")
	}
	if config.EnvOverridden("push.enabled") {
		t.Error("EnvOverridden(push.enabled) = true with no OWNCORD_PUSH_ENABLED set")
	}
}
