// Package config provides configuration loading for the OwnCord server.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strings"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/env"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/providers/structs"
	"github.com/knadh/koanf/v2"
	goyaml "go.yaml.in/yaml/v3"
)

// Config holds the full server configuration.
type Config struct {
	Server           ServerConfig           `koanf:"server"`
	Database         DatabaseConfig         `koanf:"database"`
	TLS              TLSConfig              `koanf:"tls"`
	Upload           UploadConfig           `koanf:"upload"`
	Voice            VoiceConfig            `koanf:"voice"`
	GitHub           GitHubConfig           `koanf:"github"`
	EventPersistence EventPersistenceConfig `koanf:"event_persistence"`
	Telemetry        TelemetryConfig        `koanf:"telemetry"`
	Plugins          PluginsConfig          `koanf:"plugins"`
	GIF              GIFConfig              `koanf:"gif"`
	Logging          LoggingConfig          `koanf:"logging"`
}

// LoggingConfig controls server log verbosity. The in-memory ring buffer that
// backs the admin panel's live log view always captures DEBUG regardless of
// this setting — Level only gates what is written to stdout.
type LoggingConfig struct {
	// Level is the minimum level written to stdout: "debug" | "info" | "warn" |
	// "error". Override at runtime without editing config.yaml via the
	// OWNCORD_LOGGING_LEVEL environment variable.
	Level string `koanf:"level"`
}

// ParseLevel maps a config log-level string to a slog.Level. It is
// case-insensitive and treats "" as info. The bool is false for an
// unrecognised value (in which case slog.LevelInfo is returned and the caller
// should warn) so a typo doesn't silently disable logging.
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

// GIFConfig holds the credentials for the server-side GIF (Klipy) proxy.
//
// The API key is deliberately server-only: the client never receives it and
// never talks to api.klipy.com directly, it calls /api/v1/gif/* on its own
// server instead. An empty APIKey means the feature is OFF — the proxy
// endpoints answer 503 GIF_DISABLED and the client hides the picker.
type GIFConfig struct {
	APIKey string `koanf:"api_key"`
}

// EventPersistenceConfig (Phase B Step 7) controls the tiered event log used
// for WebSocket reconnection replay.
type EventPersistenceConfig struct {
	// Enabled toggles cold-storage persistence. When false the server falls
	// back to ring-buffer-only behaviour (Phase A semantics).
	Enabled bool `koanf:"enabled"`
	// RetentionHours is how long persisted events are kept before pruning.
	RetentionHours int `koanf:"retention_hours"`
	// BatchSize is the maximum number of events per persister flush.
	BatchSize int `koanf:"batch_size"`
	// BatchFlushMs is the maximum delay between persister flushes.
	BatchFlushMs int `koanf:"batch_flush_ms"`
	// PrunerIntervalMinutes is how often the pruner goroutine wakes up.
	PrunerIntervalMinutes int `koanf:"pruner_interval_minutes"`
}

// TelemetryConfig (Phase B Step 8) controls the OpenTelemetry exporter.
type TelemetryConfig struct {
	// Enabled toggles the OTel SDK. When false the server uses no-op
	// tracer/meter providers and the legacy /metrics endpoint stays the
	// only metrics surface.
	Enabled bool `koanf:"enabled"`
	// Exporter is "none" | "prometheus" | "otlp".
	Exporter string `koanf:"exporter"`
	// OTLPEndpoint is the gRPC endpoint when Exporter == "otlp".
	OTLPEndpoint string `koanf:"otlp_endpoint"`
	// OTLPInsecure disables TLS for the OTLP gRPC connection. Only set
	// true in development / private-network deployments. Defaults to false
	// (TLS required) to avoid transmitting trace/metric data in plaintext.
	OTLPInsecure bool `koanf:"otlp_insecure"`
	// ServiceName is the resource service.name attribute.
	ServiceName string `koanf:"service_name"`
}

// PluginsConfig (Phase C Step 9) controls the Wazero plugin runtime.
type PluginsConfig struct {
	// Enabled toggles plugin loading at startup.
	Enabled bool `koanf:"enabled"`
	// Directory is the on-disk directory scanned for plugin packages.
	Directory string `koanf:"directory"`
	// MaxMemoryMB caps a single plugin's WASM linear memory.
	MaxMemoryMB int `koanf:"max_memory_mb"`
	// CPUBudgetMs caps a single plugin invocation's CPU time.
	CPUBudgetMs int `koanf:"cpu_budget_ms"`
	// HTTPAllowlist enumerates host suffixes plugins may reach via host_http.
	HTTPAllowlist []string `koanf:"http_allowlist"`
}

// GitHubConfig holds GitHub API settings for update checking.
//
// Owner/Repo point at the public releases repository. Server and client
// update checks fetch release assets from this repo, so it must stay
// publicly readable even when the source repository is private.
type GitHubConfig struct {
	Token string `koanf:"token"`
	Owner string `koanf:"owner"`
	Repo  string `koanf:"repo"`
}

// VoiceConfig holds LiveKit server connection and voice quality settings.
type VoiceConfig struct {
	LiveKitAPIKey     string `koanf:"livekit_api_key"`    // LiveKit API key
	LiveKitAPISecret  string `koanf:"livekit_api_secret"` // LiveKit API secret
	LiveKitURL        string `koanf:"livekit_url"`        // LiveKit server WebSocket URL (e.g. ws://localhost:7880)
	LiveKitBinaryPath string `koanf:"livekit_binary"`     // path to livekit-server binary; empty = don't auto-start
	NodeIP            string `koanf:"node_ip"`            // public IP for WebRTC ICE candidates; empty = auto-detect
	// AdvertiseInternalIP makes LiveKit advertise internal (LAN) host candidates
	// in addition to the external node_ip mapping, so clients on the local
	// network can connect while remote clients use the public IP.
	AdvertiseInternalIP bool   `koanf:"advertise_internal_ip"`
	Quality             string `koanf:"quality"` // low | medium | high
}

// ServerConfig holds HTTP server settings.
type ServerConfig struct {
	Port              int      `koanf:"port"`
	Name              string   `koanf:"name"`
	DataDir           string   `koanf:"data_dir"`
	AllowedOrigins    []string `koanf:"allowed_origins"`
	TrustedProxies    []string `koanf:"trusted_proxies"`
	AdminAllowedCIDRs []string `koanf:"admin_allowed_cidrs"`
	WAFEnabled        bool     `koanf:"waf_enabled"`        // Enable Coraza WAF (default: false)
	WAFParanoiaLevel  int      `koanf:"waf_paranoia_level"` // OWASP CRS paranoia level 1-4 (default: 2)
}

// DatabaseConfig holds database settings.
//
// Type selects the backend: "sqlite" (default, zero-config) or "postgres"
// (community-hub scale, requires a running PostgreSQL server). The Path field
// is only used by sqlite. The remaining fields apply to postgres only.
//
// PostgreSQL support is currently scaffolding-only: the schema, config plumbing,
// and migrations are in place, but the store query layer is gated on the
// in-progress sqlc adoption (Phase A Step 2). Setting Type to "postgres" will
// cause the server to refuse to start with a clear error pointing at the
// follow-up work — see Server/main.go.
type DatabaseConfig struct {
	// Type selects the database backend. "sqlite" (or empty, which defaults
	// to it) is the only supported value.
	Type string `koanf:"type"`

	// Path is the SQLite database file path.
	Path string `koanf:"path"`
}

// TLSConfig holds TLS/certificate settings.
type TLSConfig struct {
	Mode         string `koanf:"mode"`
	CertFile     string `koanf:"cert_file"`
	KeyFile      string `koanf:"key_file"`
	Domain       string `koanf:"domain"`
	AcmeCacheDir string `koanf:"acme_cache_dir"`
}

// UploadConfig holds file upload settings.
type UploadConfig struct {
	MaxSizeMB  int    `koanf:"max_size_mb"`
	StorageDir string `koanf:"storage_dir"`
}

// defaults returns the default configuration.
func defaults() Config {
	return Config{
		Server: ServerConfig{
			Port:           8443,
			Name:           "OwnCord Server",
			DataDir:        "data",
			AllowedOrigins: []string{},
			TrustedProxies: []string{},
			AdminAllowedCIDRs: []string{
				"127.0.0.0/8",    // localhost IPv4
				"::1/128",        // localhost IPv6
				"10.0.0.0/8",     // private class A
				"172.16.0.0/12",  // private class B
				"192.168.0.0/16", // private class C
				"fc00::/7",       // IPv6 unique local
			},
		},
		Database: DatabaseConfig{
			Type: "sqlite",
			Path: "data/chatserver.db",
		},
		TLS: TLSConfig{
			Mode:         "self_signed",
			CertFile:     "data/cert.pem",
			KeyFile:      "data/key.pem",
			AcmeCacheDir: "data/acme_certs",
		},
		Upload: UploadConfig{
			MaxSizeMB:  100,
			StorageDir: "data/uploads",
		},
		Voice: VoiceConfig{
			LiveKitURL: "ws://localhost:7880",
			Quality:    "medium",
		},
		GitHub: GitHubConfig{
			Owner: "J3vb",
			Repo:  "OwnCord-releases",
		},
		EventPersistence: EventPersistenceConfig{
			Enabled:               true,
			RetentionHours:        24,
			BatchSize:             50,
			BatchFlushMs:          100,
			PrunerIntervalMinutes: 60,
		},
		Telemetry: TelemetryConfig{
			Enabled:     false,
			Exporter:    "none",
			ServiceName: "owncord-server",
		},
		Plugins: PluginsConfig{
			Enabled:       false,
			Directory:     "data/plugins",
			MaxMemoryMB:   64,
			CPUBudgetMs:   100,
			HTTPAllowlist: []string{},
		},
		Logging: LoggingConfig{
			Level: "info",
		},
	}
}

// defaultYAML is the content written when no config file is present.
const defaultYAML = `# OwnCord Server Configuration
server:
  port: 8443
  name: "OwnCord Server"
  data_dir: "data"
  # allowed_origins: []       # empty = deny cross-origin; set to ["*"] for dev or specific origins for prod
  # trusted_proxies: []       # CIDRs of the reverse-proxy HOPS only (e.g. ["10.0.0.2/32"]).
  #                           # Never list client networks here: a range that covers
  #                           # clients degrades per-client rate limiting and lets
  #                           # covered clients influence their own rate-limit key.
  # admin_allowed_cidrs:      # CIDRs allowed to access /admin (default: private networks only)
  #   - "127.0.0.0/8"
  #   - "::1/128"
  #   - "10.0.0.0/8"
  #   - "172.16.0.0/12"
  #   - "192.168.0.0/16"

database:
  type: "sqlite"          # "sqlite" is the only supported backend
  path: "data/chatserver.db"

tls:
  mode: "self_signed"  # self_signed, acme, manual, off
  cert_file: "data/cert.pem"
  key_file: "data/key.pem"
  domain: ""              # required for acme mode (e.g. "chat.example.com")
  acme_cache_dir: "data/acme_certs"  # where Let's Encrypt certs are cached

upload:
  max_size_mb: 100
  storage_dir: "data/uploads"

voice:
  # livekit_api_key: ""       # LiveKit API key (REQUIRED for voice — generate a unique key)
  # livekit_api_secret: ""    # LiveKit API secret (REQUIRED, min 32 chars — generate a unique secret)
  livekit_url: "ws://localhost:7880"  # LiveKit server WebSocket URL
  # livekit_binary: ""             # path to livekit-server binary; empty = don't auto-start
  # node_ip: ""                    # public IP for WebRTC media (required for remote users behind NAT)
  # advertise_internal_ip: false   # also advertise LAN IPs so local-network clients can connect
  # quality: "medium"              # low | medium | high

# github:
#   token: ""  # optional: GitHub API token for higher rate limits (5000 req/hr vs 60)

# Phase B Step 7 — cold-tier event log used by the WebSocket reconnect path.
# When the in-memory ring buffer can't cover a client's last_seq the server
# falls back to these rows before forcing a full re-sync. Rows older than
# retention_hours are pruned by a background goroutine.
# event_persistence:
#   enabled: true             # set false to disable cold-tier replay entirely
#   retention_hours: 24       # how long to keep persisted broadcast events
#   batch_size: 50            # flush after this many events buffered
#   batch_flush_ms: 100       # OR after this many milliseconds, whichever first
#   pruner_interval_minutes: 60  # how often the retention pruner runs

# Phase B Step 8 — OpenTelemetry exporter. The default build ships a no-op
# provider; building with -tags otel enables the real SDK.
# telemetry:
#   enabled: false            # master switch
#   exporter: "none"          # none | prometheus | otlp
#   otlp_endpoint: ""         # required when exporter == "otlp" (host:port of collector)
#   otlp_insecure: false      # set true only for dev/private networks (disables TLS)
#   service_name: "owncord-server"

# Phase C Step 9 — Wazero plugin runtime. Disabled by default so existing
# operators are unaffected. Plugins live in subdirectories of the configured
# directory; see Server/plugin/examples/hello for the manifest format.
# plugins:
#   enabled: false
#   directory: "data/plugins"
#   max_memory_mb: 64         # per-plugin memory cap
#   cpu_budget_ms: 100        # per-invocation CPU budget
#   http_allowlist: []        # hostnames plugins may reach via the http capability

# GIF picker (Klipy). Disabled by default: with no api_key the /api/v1/gif/*
# endpoints answer 503 GIF_DISABLED and the client hides its GIF button. The
# key stays on the server — it is never sent to clients.
# Get a key at https://partner.klipy.com
# gif:
#   api_key: ""

# Logging. "level" gates what is written to stdout; the admin panel's live log
# view always captures debug regardless. Override without editing this file via
# the OWNCORD_LOGGING_LEVEL environment variable.
# logging:
#   level: "info"             # debug | info | warn | error
`

// Load reads configuration from the given YAML file path, merging with
// defaults and environment variable overrides. If the file does not exist,
// a default config.yaml is written and defaults are returned.
func Load(cfgPath string) (*Config, error) {
	k := koanf.New(".")

	// Layer 1: built-in defaults via struct provider.
	def := defaults()
	if err := k.Load(structs.Provider(def, "koanf"), nil); err != nil {
		return nil, fmt.Errorf("loading defaults: %w", err)
	}

	// Layer 2: YAML file (create default if missing).
	if _, err := os.Stat(cfgPath); os.IsNotExist(err) {
		if writeErr := os.WriteFile(cfgPath, []byte(defaultYAML), 0o600); writeErr != nil {
			return nil, fmt.Errorf("writing default config: %w", writeErr)
		}
	} else {
		// Read the file and try to parse it ourselves to detect invalid YAML.
		raw, readErr := os.ReadFile(cfgPath)
		if readErr != nil {
			return nil, fmt.Errorf("reading config file %s: %w", cfgPath, readErr)
		}
		if parseErr := validateYAML(raw); parseErr != nil {
			return nil, fmt.Errorf("loading config file %s: %w", cfgPath, parseErr)
		}
		if err := k.Load(file.Provider(cfgPath), yaml.Parser()); err != nil {
			return nil, fmt.Errorf("loading config file %s: %w", cfgPath, err)
		}
	}

	// Layer 3: environment variable overrides.
	// OWNCORD_SERVER_PORT -> server.port, OWNCORD_TLS_MODE -> tls.mode, etc.
	envProvider := env.Provider("OWNCORD_", ".", func(s string) string {
		// Strip prefix, lowercase, replace _ with . except within a key segment.
		// OWNCORD_SERVER_PORT -> server.port
		// OWNCORD_DATABASE_PATH -> database.path
		// OWNCORD_UPLOAD_MAX_SIZE_MB -> upload.max_size_mb
		s = strings.TrimPrefix(s, "OWNCORD_")
		s = strings.ToLower(s)
		// Split into at most 2 parts on the first underscore to get
		// section.key. We need smarter splitting because keys can have
		// underscores (e.g. max_size_mb, data_dir, storage_dir).
		return envKeyToKoanf(s)
	})
	if err := k.Load(envProvider, nil); err != nil {
		return nil, fmt.Errorf("loading env vars: %w", err)
	}

	var cfg Config
	if err := k.Unmarshal("", &cfg); err != nil {
		return nil, fmt.Errorf("unmarshalling config: %w", err)
	}

	// Apply voice defaults for zero-value fields (koanf loses defaults when
	// the YAML section is present but fields are commented out / omitted).
	if err := applyVoiceDefaults(&cfg.Voice); err != nil {
		return nil, fmt.Errorf("applying voice defaults: %w", err)
	}

	// Warn if using default dev credentials — these are public and insecure.
	// Clear credentials so downstream consumers (e.g. NewLiveKitClient) see
	// empty values and refuse to start voice.
	if IsDefaultVoiceCredentials(&cfg.Voice) {
		slog.Warn("using default LiveKit dev credentials — voice will be disabled; set voice.livekit_api_key and voice.livekit_api_secret in config.yaml")
		cfg.Voice.LiveKitAPIKey = ""
		cfg.Voice.LiveKitAPISecret = ""
	}

	// Invalid CIDR entries are skipped at request time (they must not crash
	// handling), which silently un-trusts a misconfigured proxy — warn once
	// at startup instead. Common mistake: a bare IP without the /32 mask.
	warnInvalidCIDRs("server.trusted_proxies", cfg.Server.TrustedProxies)
	warnInvalidCIDRs("server.admin_allowed_cidrs", cfg.Server.AdminAllowedCIDRs)

	return &cfg, nil
}

// warnInvalidCIDRs logs a startup warning for each list entry that is not
// valid CIDR notation.
func warnInvalidCIDRs(key string, cidrs []string) {
	for _, c := range cidrs {
		if _, _, err := net.ParseCIDR(c); err != nil {
			slog.Warn("config: ignoring invalid CIDR entry (use address/prefix notation, e.g. 10.0.0.1/32)",
				"key", key, "entry", c)
		}
	}
}

// defaultLiveKitAPIKey and defaultLiveKitAPISecret are the well-known dev
// credentials that ship in the default config. They must never be used in
// production — NewLiveKitClient rejects them.
const (
	DefaultLiveKitAPIKey    = "devkey"
	DefaultLiveKitAPISecret = "owncord-dev-secret-key-min-32chars" //nolint:gosec // G101: false positive — config key name, not a credential
)

// IsDefaultVoiceCredentials returns true when the voice config still uses
// the well-known default dev credentials shipped in the source code.
func IsDefaultVoiceCredentials(v *VoiceConfig) bool {
	return v.LiveKitAPIKey == DefaultLiveKitAPIKey ||
		v.LiveKitAPISecret == DefaultLiveKitAPISecret
}

// generateRandomKey returns a crypto-random hex string of the given byte length.
func generateRandomKey(byteLen int) (string, error) {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("crypto/rand: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// applyVoiceDefaults fills in zero-value voice fields with sensible defaults.
// This guards against the koanf merge behaviour where an empty YAML section
// overwrites struct defaults with Go zero values.
// When API key/secret are empty, unique random credentials are generated
// so voice works out of the box without shipping known-public defaults.
func applyVoiceDefaults(v *VoiceConfig) error {
	if v.LiveKitAPIKey == "" {
		key, err := generateRandomKey(8)
		if err != nil {
			return fmt.Errorf("generating LiveKit API key: %w", err)
		}
		v.LiveKitAPIKey = "key-" + key
		slog.Warn("generated random LiveKit API key — voice tokens will break on restart; set voice.livekit_api_key in config.yaml for stable operation")
	}
	if v.LiveKitAPISecret == "" {
		secret, err := generateRandomKey(32)
		if err != nil {
			return fmt.Errorf("generating LiveKit API secret: %w", err)
		}
		v.LiveKitAPISecret = secret
		slog.Warn("generated random LiveKit API secret — set voice.livekit_api_secret in config.yaml for stable operation")
	}
	if v.LiveKitURL == "" {
		v.LiveKitURL = "ws://localhost:7880"
	}
	if v.Quality == "" {
		v.Quality = "medium"
	}
	return nil
}

// validateYAML checks that raw bytes are valid YAML.
func validateYAML(raw []byte) error {
	var v any
	return goyaml.Unmarshal(raw, &v)
}

// envKeyToKoanf converts a lower-case env key (without OWNCORD_ prefix) to a
// koanf dotted path. The first segment (up to the first underscore) is the
// section; the remainder is the key (with underscores preserved).
//
// Examples:
//
//	server_port        -> server.port
//	server_name        -> server.name
//	server_data_dir    -> server.data_dir
//	database_path      -> database.path
//	tls_mode           -> tls.mode
//	tls_cert_file      -> tls.cert_file
//	upload_max_size_mb -> upload.max_size_mb
func envKeyToKoanf(s string) string {
	before, after, ok := strings.Cut(s, "_")
	if !ok {
		return s
	}
	return before + "." + after
}
