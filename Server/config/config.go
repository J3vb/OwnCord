// Package config provides configuration loading for the OwnCord server.
package config

import (
	"fmt"
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

// VoiceConfig holds STUN/TURN server settings for WebRTC signaling.
type VoiceConfig struct {
	TURNSecret  string `koanf:"turn_secret"`  // HMAC-SHA1 secret; auto-generated if empty
	STUNPort    int    `koanf:"stun_port"`    // default 3478
	TURNPort    int    `koanf:"turn_port"`    // default 3478
	TURNEnabled bool   `koanf:"turn_enabled"` // default true
}

// ServerConfig holds HTTP server settings.
type ServerConfig struct {
	Port    int    `koanf:"port"`
	Name    string `koanf:"name"`
	DataDir string `koanf:"data_dir"`
}

// DatabaseConfig holds database settings.
type DatabaseConfig struct {
	Path string `koanf:"path"`
}

// TLSConfig holds TLS/certificate settings.
type TLSConfig struct {
	Mode     string `koanf:"mode"`
	CertFile string `koanf:"cert_file"`
	KeyFile  string `koanf:"key_file"`
	Domain   string `koanf:"domain"`
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
			Port:    8443,
			Name:    "OwnCord Server",
			DataDir: "data",
		},
		Database: DatabaseConfig{
			Path: "data/chatserver.db",
		},
		TLS: TLSConfig{
			Mode: "self_signed",
		},
		Upload: UploadConfig{
			MaxSizeMB:  100,
			StorageDir: "data/uploads",
		},
		Voice: VoiceConfig{
			STUNPort:    3478,
			TURNPort:    3478,
			TURNEnabled: true,
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

database:
  path: "data/chatserver.db"

tls:
  mode: "self_signed"  # self_signed, acme, manual, off
  cert_file: ""
  key_file: ""
  domain: ""

upload:
  max_size_mb: 100
  storage_dir: "data/uploads"

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
		if writeErr := os.WriteFile(cfgPath, []byte(defaultYAML), 0o644); writeErr != nil {
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

	return &cfg, nil
}

// validateYAML checks that raw bytes are valid YAML.
func validateYAML(raw []byte) error {
	var v interface{}
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
