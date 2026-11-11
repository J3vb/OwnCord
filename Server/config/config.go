// Package config provides configuration loading for the OwnCord server.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	goyaml "go.yaml.in/yaml/v3"

	"github.com/J3vb/OwnCord/Server/clientip"
	"github.com/J3vb/OwnCord/Server/storage"
)

// Config holds the full server configuration.
type Config struct {
	Server           ServerConfig           `yaml:"server"`
	Database         DatabaseConfig         `yaml:"database"`
	Backup           BackupConfig           `yaml:"backup"`
	Security         SecurityConfig         `yaml:"security"`
	TLS              TLSConfig              `yaml:"tls"`
	Upload           UploadConfig           `yaml:"upload"`
	Voice            VoiceConfig            `yaml:"voice"`
	GitHub           GitHubConfig           `yaml:"github"`
	EventPersistence EventPersistenceConfig `yaml:"event_persistence"`
	Telemetry        TelemetryConfig        `yaml:"telemetry"`
	Plugins          PluginsConfig          `yaml:"plugins"`
	GIF              GIFConfig              `yaml:"gif"`
	Logging          LoggingConfig          `yaml:"logging"`
	Moderation       ModerationConfig       `yaml:"moderation"`
	Push             PushConfig             `yaml:"push"`
	Attention        AttentionConfig        `yaml:"attention"`
}

// LogHistoryDir is where saved log files go, or "" when history is off.
func (c *Config) LogHistoryDir() string {
	if c.Logging.HistoryDays <= 0 {
		return ""
	}
	return filepath.Join(c.Server.DataDir, "logs")
}

// ParseLevel maps a log-level string to a slog.Level, case-insensitively, "" as info. The bool is false for
// an unrecognised value (slog.LevelInfo is returned) so the caller can warn.
func ParseLevel(s string) (slog.Level, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug, true
	case "", "info":
		return slog.LevelInfo, true
	case "warn", "warning":
		return slog.LevelWarn, true
	case "error":
		return slog.LevelError, true
	default:
		return slog.LevelInfo, false
	}
}

// Load reads the YAML file, merging defaults and environment overrides; a missing file is written as the
// default config.yaml.
func Load(cfgPath string) (*Config, error) {
	// Load the freshly written file like any other so first boot runs the configuration the file documents
	// (the template enables options, such as voice.auto_download_livekit, that defaults leave off).
	if _, err := os.Stat(cfgPath); os.IsNotExist(err) {
		if writeErr := os.WriteFile(cfgPath, []byte(defaultYAML), 0o600); writeErr != nil {
			return nil, fmt.Errorf("writing default config: %w", writeErr)
		}
	}
	raw, readErr := os.ReadFile(cfgPath) //nolint:gosec // G304: path from trusted wiring
	if readErr != nil {
		return nil, fmt.Errorf("reading config file %s: %w", cfgPath, readErr)
	}

	cfg, err := loadBytes(raw, cfgPath)
	if err != nil {
		return nil, err
	}

	// Warn, never fail (a newer server must tolerate an older config), about file keys the struct cannot
	// absorb; otherwise a typo like `admin_alowed_cidrs` silently keeps the default.
	var tree map[string]any
	if err := goyaml.Unmarshal(raw, &tree); err != nil {
		return nil, fmt.Errorf("loading config file %s: %w", cfgPath, err)
	}
	for _, key := range unknownKeys(tree) {
		slog.Warn("config: unknown key ignored — value has NO effect (typo?)",
			"key", key, "file", cfgPath)
	}

	// Warn on default dev or .env.example placeholder credentials (public and insecure) and clear them so
	// downstream consumers refuse to start voice.
	if IsDefaultVoiceCredentials(&cfg.Voice) {
		slog.Warn("using default or placeholder LiveKit credentials — voice will be disabled; set voice.livekit_api_key and voice.livekit_api_secret in config.yaml (or LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env under Docker)")
		cfg.Voice.LiveKitAPIKey = ""
		cfg.Voice.LiveKitAPISecret = ""
	}

	// Invalid CIDR entries are skipped at request time, which silently un-trusts a misconfigured proxy; warn
	// once at startup. Common mistake: a bare IP without the /32 mask.
	warnInvalidCIDRs("server.trusted_proxies", cfg.Server.TrustedProxies)
	warnInvalidCIDRs("server.admin_allowed_cidrs", cfg.Server.AdminAllowedCIDRs)
	warnInvalidCIDRs("server.metrics_allowed_cidrs", cfg.Server.MetricsAllowedCIDRs)
	warnInvalidCIDRs("server.livekit_webhook_allowed_cidrs", cfg.Server.LiveKitWebhookAllowedCIDRs)

	// An EMPTY admin_allowed_cidrs switches the /admin IP perimeter off (api.AdminIPRestrict allows every
	// address; session auth still applies). Warn, don't fail: a panel behind a VPN or authenticating proxy is
	// real.
	if len(cfg.Server.AdminAllowedCIDRs) == 0 {
		slog.Warn("config: admin_allowed_cidrs is empty — the /admin IP perimeter is disabled, " +
			"so AdminIPRestrict admits every address; set server.admin_allowed_cidrs to the " +
			"addresses that should reach the admin panel")
	}

	return cfg, nil
}

// loadBytes builds a Config from raw YAML: defaults, the file, the admin-panel overrides, then the
// OWNCORD_* environment. Unmarshal overwrites only keys a document names, so an empty section keeps its
// defaults. The environment layer goes through the same YAML path as the file, never spliced into text, so
// a value containing YAML syntax stays one scalar. Save's verifyLoadable gate runs this whole function.
func loadBytes(raw []byte, cfgPath string) (*Config, error) {
	cfg, err := loadBytesWith(raw, cfgPath, nil)
	if err != nil {
		return nil, err
	}
	if err := ensureVoiceCredentials(&cfg.Voice); err != nil {
		return nil, fmt.Errorf("applying voice defaults: %w", err)
	}
	return cfg, nil
}

// loadBytesWith builds a Config with the overrides layer injected and no generation side effects; a nil
// overrides map reads the overrides file, Preview passes the file merged with pending changes.
func loadBytesWith(raw []byte, cfgPath string, overrides map[string]any) (*Config, error) {
	cfg := defaults()
	if err := goyaml.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("loading config file %s: %w", cfgPath, err)
	}
	// The admin panel's overrides sit between the file and the environment.
	if overrides == nil {
		if err := applyOverrideLayer(&cfg); err != nil {
			return nil, err
		}
	} else if err := applyOverrides(&cfg, overrides); err != nil {
		return nil, err
	}
	env, err := envOverrides()
	if err != nil {
		// Attribute the error to the failing layer here; a single wrap in Load would blame the YAML file for
		// a bad OWNCORD_* value.
		return nil, fmt.Errorf("loading env vars: %w", err)
	}
	if len(env) > 0 {
		envYAML, err := goyaml.Marshal(env)
		if err != nil {
			return nil, fmt.Errorf("encoding env overrides: %w", err)
		}
		if err := goyaml.Unmarshal(envYAML, &cfg); err != nil {
			return nil, fmt.Errorf("applying env overrides: %w", err)
		}
	}
	applyBounds(&cfg)
	if err := normalizeUploadExtensions(&cfg.Upload); err != nil {
		return nil, err
	}
	if err := checkTrustedProxies(cfg.Server.TrustedProxies); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// ErrCatchAllTrustedProxy marks a trusted_proxies entry covering every address. The load fails rather than
// skipping it: skipping would fold every client into one rate-limit bucket, keeping it lets each client
// choose the address it is limited by.
var ErrCatchAllTrustedProxy = errors.New("server.trusted_proxies must list only proxy hops")

func checkTrustedProxies(cidrs []string) error {
	if entry, found := clientip.FirstCatchAll(cidrs); found {
		return fmt.Errorf("%w: entry %q covers every address; list each proxy's own address instead (e.g. 10.0.0.2/32)",
			ErrCatchAllTrustedProxy, entry)
	}
	return nil
}

// normalizeUploadExtensions fails the load on a bad entry: skipping it could
// empty an allow-only list, and so switch allow-only mode off.
func normalizeUploadExtensions(u *UploadConfig) (err error) {
	if u.BlockedExtensions, err = storage.NormalizeExtensions(u.BlockedExtensions); err != nil {
		return fmt.Errorf("upload.blocked_extensions: %w", err)
	}
	if u.AllowedExtensions, err = storage.NormalizeExtensions(u.AllowedExtensions); err != nil {
		return fmt.Errorf("upload.allowed_extensions: %w", err)
	}
	return nil
}

// ValidMetricsURL reports whether raw is an absolute http or https URL; Load keeps what the operator wrote.
func ValidMetricsURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

func warnInvalidCIDRs(key string, cidrs []string) {
	for _, c := range cidrs {
		if _, _, err := net.ParseCIDR(c); err != nil {
			slog.Warn("config: ignoring invalid CIDR entry (use address/prefix notation, e.g. 10.0.0.1/32)",
				"key", key, "entry", c)
		}
	}
}
