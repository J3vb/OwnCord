package config_test

import (
	"bytes"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

// Secrets are write-only from the panel: GET reports only whether one is
// configured, and no response, log line or audit row carries the value.
var panelSecretKeys = []string{
	"gif.api_key", "github.token", "voice.livekit_api_key", "voice.livekit_api_secret",
}

// Keys whose wrong value can lock the owner out of the panel, move the data
// the server runs on, or make it execute a host file. A PATCH must name each
// of them in X-OwnCord-Confirm, and the admin handler runs host-state guards.
var panelConfirmKeys = []string{
	"backup.dir", "database.path", "plugins.directory",
	"server.admin_allowed_cidrs", "server.port", "server.restart_mode", "server.trusted_proxies",
	"tls.acme_cache_dir", "tls.cert_file", "tls.domain", "tls.key_file", "tls.mode",
	"upload.storage_dir", "voice.livekit_binary",
}

func TestIsSecret_ExactSet(t *testing.T) {
	for _, key := range config.EditableKeys() {
		if got, want := config.IsSecret(key), slices.Contains(panelSecretKeys, key); got != want {
			t.Errorf("IsSecret(%q) = %v, want %v", key, got, want)
		}
	}
	for _, key := range panelSecretKeys {
		if !config.IsEditable(key) {
			t.Errorf("secret %q is not editable; secrets are write-only fields, not excluded", key)
		}
	}
}

// A secret may be cleared to the empty string only where its rule accepts one:
// gif.api_key and github.token can be blanked, while the LiveKit credentials
// must keep a value. The classification asks the rule, so it cannot drift.
func TestSecretAllowsEmpty_ExactSet(t *testing.T) {
	clearable := []string{"gif.api_key", "github.token"}
	for _, key := range config.EditableKeys() {
		if got, want := config.SecretAllowsEmpty(key), slices.Contains(clearable, key); got != want {
			t.Errorf("SecretAllowsEmpty(%q) = %v, want %v", key, got, want)
		}
	}
}

func TestRequiresConfirmation_ExactSet(t *testing.T) {
	for _, key := range config.EditableKeys() {
		if got, want := config.RequiresConfirmation(key), slices.Contains(panelConfirmKeys, key); got != want {
			t.Errorf("RequiresConfirmation(%q) = %v, want %v", key, got, want)
		}
	}
}

func TestSaveOverrides_ValidatesSensitiveValues(t *testing.T) {
	bad := []struct {
		key   string
		value any
	}{
		{"gif.api_key", "has a space"},
		{"github.token", "line\nbreak"},
		{"voice.livekit_api_key", ""},                                // empty regenerates a random key each boot
		{"voice.livekit_api_key", config.DefaultLiveKitAPIKey},       // public dev key, Load would clear it
		{"voice.livekit_api_secret", "short-secret"},                 // LiveKit needs >= 32 characters
		{"voice.livekit_api_secret", config.DefaultLiveKitAPISecret}, // public dev secret
		{"github.owner", "-leading-hyphen"},
		{"github.owner", "a/b"},
		{"github.repo", ".."},
		{"github.repo", "a/b"},
		{"server.port", float64(0)},
		{"server.port", float64(70000)},
		{"server.port", float64(7880)}, // LiveKit's API port
		{"server.restart_mode", "reboot"},
		{"database.type", "postgres"},
		{"tls.mode", "plain"},
		{"tls.domain", "https://chat.example.com"},
		{"tls.domain", "chat.example.com:443"},
		{"tls.domain", "-bad.example.com"},
		{"tls.domain", "192.0.2.1"},                       // an IP literal is not a hostname; auth.loadACME rejects it
		{"server.admin_allowed_cidrs", []any{"10.0.0.1"}}, // bare IP
		{"server.trusted_proxies", []any{"0.0.0.0/0"}},    // trusting everyone lets any client forge X-Forwarded-For
		{"server.trusted_proxies", []any{"::/0"}},
		{"database.path", ""},
		{"database.path", "a\x00b"},
		{"upload.storage_dir", ""},
		{"voice.livekit_binary", "relative/livekit-server"}, // must be absolute
		{"voice.livekit_binary", "/bin/sh"},                 // not a livekit binary
		{"server.pprof_block_profile_rate", float64(-1)},
		{"server.pprof_mutex_profile_fraction", float64(-1)},
		{"server.pprof_enabled", "true"},
	}
	for _, tc := range bad {
		path := config.OverridesPath(t.TempDir())
		err := config.SaveOverrides(path, map[string]any{tc.key: tc.value})
		if !errors.Is(err, config.ErrInvalidValue) {
			t.Errorf("SaveOverrides(%s=%#v) error = %v, want ErrInvalidValue", tc.key, tc.value, err)
			continue
		}
		if !strings.Contains(err.Error(), tc.key) {
			t.Errorf("SaveOverrides(%s) error %q does not name the key", tc.key, err)
		}
		if s, ok := tc.value.(string); ok && config.IsSecret(tc.key) && len(s) > 3 && strings.Contains(err.Error(), s) {
			t.Errorf("SaveOverrides(%s) error %q echoes the secret value", tc.key, err)
		}
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Errorf("SaveOverrides(%s=%#v) wrote a file despite the invalid value", tc.key, tc.value)
		}
	}

	good := map[string]any{
		"gif.api_key":                         "", // clearing turns the GIF picker off
		"github.token":                        "ghp_examplevalue",
		"voice.livekit_api_key":               "APIexamplekey",
		"voice.livekit_api_secret":            "0123456789abcdef0123456789abcdef",
		"github.owner":                        "J3vb",
		"github.repo":                         "OwnCord",
		"server.port":                         float64(9443),
		"server.restart_mode":                 "supervised",
		"database.type":                       "sqlite",
		"tls.mode":                            "acme",
		"tls.domain":                          "chat.example.com",
		"server.admin_allowed_cidrs":          []any{"192.168.0.0/16", "127.0.0.0/8"},
		"server.trusted_proxies":              []any{"10.0.0.1/32"},
		"database.path":                       "data/other.db",
		"backup.dir":                          "data/backups2",
		"upload.storage_dir":                  "data/uploads2",
		"plugins.directory":                   "data/plugins2",
		"tls.cert_file":                       "data/cert2.pem",
		"tls.key_file":                        "data/key2.pem",
		"tls.acme_cache_dir":                  "data/acme2",
		"voice.livekit_binary":                filepath.Join(t.TempDir(), "livekit-server"),
		"server.pprof_enabled":                true,
		"server.pprof_block_profile_rate":     float64(0),
		"server.pprof_mutex_profile_fraction": float64(10),
	}
	if err := config.SaveOverrides(config.OverridesPath(t.TempDir()), good); err != nil {
		t.Errorf("SaveOverrides(valid sensitive values) error = %v, want nil", err)
	}
	// An empty livekit_binary means "do not start a companion process".
	if err := config.SaveOverrides(config.OverridesPath(t.TempDir()), map[string]any{"voice.livekit_binary": ""}); err != nil {
		t.Errorf("SaveOverrides(voice.livekit_binary=\"\") error = %v, want nil", err)
	}
}

// A secret saved from the panel takes effect at boot and the loader's
// "override in effect" line names the key, never the value.
func TestLoad_SecretOverrideAppliedButNotLogged(t *testing.T) {
	const secret = "klipy-panel-secret-value-789"
	dataDir := t.TempDir()
	cfgPath := writeYAML(t, dataDir, "")
	writeOverrides(t, dataDir, `{"gif.api_key": "`+secret+`"}`)

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.GIF.APIKey != secret {
		t.Errorf("gif.api_key = %q, want the panel value", cfg.GIF.APIKey)
	}
	if !strings.Contains(buf.String(), "gif.api_key") {
		t.Errorf("no override log line names gif.api_key:\n%s", buf.String())
	}
	if strings.Contains(buf.String(), secret) {
		t.Errorf("a log line carries the secret value:\n%s", buf.String())
	}
}

// Preview builds the configuration the NEXT boot would run with if changes
// were saved: config.yaml, the current overrides file with changes merged
// (nil = reset), then the environment. Guards judge this, so a reset that
// falls back to a narrower config.yaml perimeter is caught too.
func TestPreview_ReflectsNextBoot(t *testing.T) {
	dataDir := t.TempDir()
	cfgPath := writeYAML(t, dataDir, "  admin_allowed_cidrs: [\"10.0.0.0/8\"]\n")
	writeOverrides(t, dataDir, `{"server.admin_allowed_cidrs": ["192.0.2.0/24"]}`)
	ovPath := config.OverridesPath(dataDir)
	before, err := os.ReadFile(ovPath)
	if err != nil {
		t.Fatalf("read overrides: %v", err)
	}

	next, err := config.Preview(cfgPath, ovPath, map[string]any{"server.max_ws_connections": float64(5)})
	if err != nil {
		t.Fatalf("Preview: %v", err)
	}
	if !slices.Equal(next.Server.AdminAllowedCIDRs, []string{"192.0.2.0/24"}) || next.Server.MaxWSConnections != 5 {
		t.Errorf("Preview = admin %v, max_ws %d; want the saved override kept and the change applied",
			next.Server.AdminAllowedCIDRs, next.Server.MaxWSConnections)
	}

	next, err = config.Preview(cfgPath, ovPath, map[string]any{"server.admin_allowed_cidrs": nil})
	if err != nil {
		t.Fatalf("Preview(reset): %v", err)
	}
	if !slices.Equal(next.Server.AdminAllowedCIDRs, []string{"10.0.0.0/8"}) {
		t.Errorf("Preview(reset) admin = %v, want config.yaml's [10.0.0.0/8]", next.Server.AdminAllowedCIDRs)
	}

	t.Setenv("OWNCORD_SERVER_MAX_WS_CONNECTIONS", "30")
	next, err = config.Preview(cfgPath, ovPath, nil)
	if err != nil {
		t.Fatalf("Preview(env): %v", err)
	}
	if next.Server.MaxWSConnections != 30 {
		t.Errorf("Preview max_ws = %d, want the environment's 30", next.Server.MaxWSConnections)
	}

	after, _ := os.ReadFile(ovPath)
	if !bytes.Equal(before, after) {
		t.Errorf("Preview changed the overrides file:\nbefore %s\nafter  %s", before, after)
	}

	// A missing config.yaml previews as defaults and is NOT created (Load's
	// first-boot write must not happen from a preview).
	missing := cfgPath + ".absent"
	if _, err := config.Preview(missing, ovPath, nil); err != nil {
		t.Fatalf("Preview(missing yaml): %v", err)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Errorf("Preview created %s", missing)
	}
}

// Preview is a read path: it must not run the boot's LiveKit credential
// generation, which would burn a fresh random pair and log the restart
// warnings on every panel load. Load still generates them.
func TestPreview_DoesNotGenerateVoiceCredentials(t *testing.T) {
	dataDir := t.TempDir()
	cfgPath := writeYAML(t, dataDir, "")

	next, err := config.Preview(cfgPath, config.OverridesPath(dataDir), nil)
	if err != nil {
		t.Fatalf("Preview: %v", err)
	}
	if next.Voice.LiveKitAPIKey != "" || next.Voice.LiveKitAPISecret != "" {
		t.Error("Preview generated LiveKit credentials; a preview must be side-effect free")
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Voice.LiveKitAPIKey == "" || cfg.Voice.LiveKitAPISecret == "" {
		t.Error("Load must still generate LiveKit credentials")
	}
}
