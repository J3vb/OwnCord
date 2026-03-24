// Package config provides configuration loading for the OwnCord server.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
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
	Server   ServerConfig   `koanf:"server"`
	Database DatabaseConfig `koanf:"database"`
	TLS      TLSConfig      `koanf:"tls"`
	Upload   UploadConfig   `koanf:"upload"`
	Voice    VoiceConfig    `koanf:"voice"`
	GitHub   GitHubConfig   `koanf:"github"`
}

// GitHubConfig holds GitHub API settings for update checking.
type GitHubConfig struct {
	Token string `koanf:"token"`
}

// VoiceConfig holds LiveKit server connection and voice quality settings.
type VoiceConfig struct {
	LiveKitAPIKey    string `koanf:"livekit_api_key"`    // LiveKit API key
	LiveKitAPISecret string `koanf:"livekit_api_secret"` // LiveKit API secret
	LiveKitURL       string `koanf:"livekit_url"`        // LiveKit server WebSocket URL (e.g. ws://localhost:7880)
	LiveKitBinaryPath string `koanf:"livekit_binary"`    // path to livekit-server binary; empty = don't auto-start
	Quality          string `koanf:"quality"`            // low | medium | high
}

// ServerConfig holds HTTP server settings.
type ServerConfig struct {
	Port              int      `koanf:"port"`
	Name              string   `koanf:"name"`
	DataDir           string   `koanf:"data_dir"`
	AllowedOrigins    []string `koanf:"allowed_origins"`
	TrustedProxies    []string `koanf:"trusted_proxies"`
	AdminAllowedCIDRs []string `koanf:"admin_allowed_cidrs"`
}

// DatabaseConfig holds database settings.
type DatabaseConfig struct {
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
			AllowedOrigins: []string{"*"},
			TrustedProxies: []string{},
			AdminAllowedCIDRs: []string{
				"127.0.0.0/8",     // localhost IPv4
				"::1/128",         // localhost IPv6
				"10.0.0.0/8",      // private class A
				"172.16.0.0/12",   // private class B
				"192.168.0.0/16",  // private class C
				"fc00::/7",        // IPv6 unique local
			},
		},
		Database: DatabaseConfig{
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
		GitHub: GitHubConfig{},
	}
}

// defaultYAML is the content written when no config file is present.
const defaultYAML = `# OwnCord Server Configuration
server:
  port: 8443
  name: "OwnCord Server"
  data_dir: "data"
  # allowed_origins: ["*"]   # restrict WebSocket origins, e.g. ["https://example.com"]
  # trusted_proxies: []       # CIDRs of trusted reverse proxies, e.g. ["10.0.0.0/8"]
  # admin_allowed_cidrs:      # CIDRs allowed to access /admin (default: private networks only)
  #   - "127.0.0.0/8"
  #   - "::1/128"
  #   - "10.0.0.0/8"
  #   - "172.16.0.0/12"
  #   - "192.168.0.0/16"

database:
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
  # quality: "medium"              # low | medium | high

# github:
#   token: ""  # optional: GitHub API token for higher rate limits (5000 req/hr vs 60)
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
	applyVoiceDefaults(&cfg.Voice)

	// Warn if using default dev credentials — these are public and insecure.
	// Clear credentials so downstream consumers (e.g. NewLiveKitClient) see
	// empty values and refuse to start voice.
	if IsDefaultVoiceCredentials(&cfg.Voice) {
		slog.Warn("using default LiveKit dev credentials — voice will be disabled; set voice.livekit_api_key and voice.livekit_api_secret in config.yaml")
		cfg.Voice.LiveKitAPIKey = ""
		cfg.Voice.LiveKitAPISecret = ""
	}

	return &cfg, nil
}

// defaultLiveKitAPIKey and defaultLiveKitAPISecret are the well-known dev
// credentials that ship in the default config. They must never be used in
// production — NewLiveKitClient rejects them.
const (
	DefaultLiveKitAPIKey    = "devkey"
	DefaultLiveKitAPISecret = "owncord-dev-secret-key-min-32chars"
)

// IsDefaultVoiceCredentials returns true when the voice config still uses
// the well-known default dev credentials shipped in the source code.
func IsDefaultVoiceCredentials(v *VoiceConfig) bool {
	return v.LiveKitAPIKey == DefaultLiveKitAPIKey ||
		v.LiveKitAPISecret == DefaultLiveKitAPISecret
}

// generateRandomKey returns a crypto-random hex string of the given byte length.
func generateRandomKey(byteLen int) string {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// applyVoiceDefaults fills in zero-value voice fields with sensible defaults.
// This guards against the koanf merge behaviour where an empty YAML section
// overwrites struct defaults with Go zero values.
// When API key/secret are empty, unique random credentials are generated
// so voice works out of the box without shipping known-public defaults.
func applyVoiceDefaults(v *VoiceConfig) {
	if v.LiveKitAPIKey == "" {
		v.LiveKitAPIKey = "key-" + generateRandomKey(8)
		slog.Info("generated random LiveKit API key (no key configured)")
	}
	if v.LiveKitAPISecret == "" {
		v.LiveKitAPISecret = generateRandomKey(32) // 64 hex chars, well above 32-char minimum
		slog.Info("generated random LiveKit API secret (no secret configured)")
	}
	if v.LiveKitURL == "" {
		v.LiveKitURL = "ws://localhost:7880"
	}
	if v.Quality == "" {
		v.Quality = "medium"
	}
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
	idx := strings.Index(s, "_")
	if idx < 0 {
		return s
	}
	return s[:idx] + "." + s[idx+1:]
}
