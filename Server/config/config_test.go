package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/owncord/server/config"
)

func TestLoadDefaults(t *testing.T) {
	// When no config file exists, Load should return defaults.
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load() with missing file returned error: %v", err)
	}

	tests := []struct {
		name string
		got  any
		want any
	}{
		{"Server.Port", cfg.Server.Port, 8443},
		{"Server.Name", cfg.Server.Name, "OwnCord Server"},
		{"Server.DataDir", cfg.Server.DataDir, "data"},
		{"Database.Path", cfg.Database.Path, "data/chatserver.db"},
		{"TLS.Mode", cfg.TLS.Mode, "self_signed"},
		{"Upload.MaxSizeMB", cfg.Upload.MaxSizeMB, 100},
		{"Upload.StorageDir", cfg.Upload.StorageDir, "data/uploads"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Errorf("got %v, want %v", tc.got, tc.want)
			}
		})
	}
}

func TestLoadGeneratesDefaultFile(t *testing.T) {
	// When no config file exists, Load should write a default config.yaml.
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	_, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}

	if _, statErr := os.Stat(cfgPath); os.IsNotExist(statErr) {
		t.Error("Load() did not generate default config.yaml")
	}
}

func TestLoadMergesYAML(t *testing.T) {
	// When a YAML file exists with overrides, they should be merged with defaults.
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	yaml := `
server:
  port: 9000
  name: "My Custom Server"
database:
  path: "custom/path.db"
`
	if err := os.WriteFile(cfgPath, []byte(yaml), 0o644); err != nil {
		t.Fatalf("failed to write yaml: %v", err)
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}

	if cfg.Server.Port != 9000 {
		t.Errorf("Server.Port = %d, want 9000", cfg.Server.Port)
	}
	if cfg.Server.Name != "My Custom Server" {
		t.Errorf("Server.Name = %q, want 'My Custom Server'", cfg.Server.Name)
	}
	if cfg.Database.Path != "custom/path.db" {
		t.Errorf("Database.Path = %q, want 'custom/path.db'", cfg.Database.Path)
	}
	// Non-overridden defaults should still be present.
	if cfg.Server.DataDir != "data" {
		t.Errorf("Server.DataDir = %q, want 'data'", cfg.Server.DataDir)
	}
	if cfg.Upload.MaxSizeMB != 100 {
		t.Errorf("Upload.MaxSizeMB = %d, want 100", cfg.Upload.MaxSizeMB)
	}
}

func TestLoadEnvironmentVariableOverrides(t *testing.T) {
	// Environment variables with OWNCORD_ prefix should override config values.
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	t.Setenv("OWNCORD_SERVER_PORT", "7777")
	t.Setenv("OWNCORD_SERVER_NAME", "Env Server")
	t.Setenv("OWNCORD_DATABASE_PATH", "env/path.db")
	t.Setenv("OWNCORD_TLS_MODE", "manual")

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}

	if cfg.Server.Port != 7777 {
		t.Errorf("Server.Port = %d, want 7777", cfg.Server.Port)
	}
	if cfg.Server.Name != "Env Server" {
		t.Errorf("Server.Name = %q, want 'Env Server'", cfg.Server.Name)
	}
	if cfg.Database.Path != "env/path.db" {
		t.Errorf("Database.Path = %q, want 'env/path.db'", cfg.Database.Path)
	}
	if cfg.TLS.Mode != "manual" {
		t.Errorf("TLS.Mode = %q, want 'manual'", cfg.TLS.Mode)
	}
}

func TestLoadInvalidYAML(t *testing.T) {
	// Malformed YAML (bad indentation/tab mix) should return an error.
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	// Tabs in YAML indentation are illegal per the YAML spec.
	invalidYAML := "server:\n\tport: 9000\n"
	if err := os.WriteFile(cfgPath, []byte(invalidYAML), 0o644); err != nil {
		t.Fatalf("failed to write yaml: %v", err)
	}

	_, err := config.Load(cfgPath)
	if err == nil {
		t.Error("Load() with invalid YAML should return error, got nil")
	}
}

func TestLoadTLSModeValues(t *testing.T) {
	// Test that all valid TLS modes are accepted.
	validModes := []string{"self_signed", "acme", "manual", "off"}

	for _, mode := range validModes {
		t.Run(mode, func(t *testing.T) {
			tmpDir := t.TempDir()
			cfgPath := filepath.Join(tmpDir, "config.yaml")

			yaml := "tls:\n  mode: " + mode + "\n"
			if err := os.WriteFile(cfgPath, []byte(yaml), 0o644); err != nil {
				t.Fatalf("failed to write yaml: %v", err)
			}

			cfg, err := config.Load(cfgPath)
			if err != nil {
				t.Fatalf("Load() returned error: %v", err)
			}
			if cfg.TLS.Mode != mode {
				t.Errorf("TLS.Mode = %q, want %q", cfg.TLS.Mode, mode)
			}
		})
	}
}

func TestLoadEnvVarNoUnderscore(t *testing.T) {
	// Test an env var that maps to a top-level key (no section separator).
	// OWNCORD_PORT (no second underscore) — should not crash, just map to "port".
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	t.Setenv("OWNCORD_PORT", "1234")

	// Load should succeed without panicking.
	_, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
}

func TestLoadEnvVarStorageDir(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	t.Setenv("OWNCORD_UPLOAD_STORAGE_DIR", "/mnt/data/uploads")

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
	if cfg.Upload.StorageDir != "/mnt/data/uploads" {
		t.Errorf("Upload.StorageDir = %q, want '/mnt/data/uploads'", cfg.Upload.StorageDir)
	}
}

func TestLoadTLSCertAndKeyFields(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	yaml := `
tls:
  mode: "manual"
  cert_file: "/etc/ssl/cert.pem"
  key_file: "/etc/ssl/key.pem"
  domain: "example.com"
`
	if err := os.WriteFile(cfgPath, []byte(yaml), 0o644); err != nil {
		t.Fatalf("failed to write yaml: %v", err)
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
	if cfg.TLS.CertFile != "/etc/ssl/cert.pem" {
		t.Errorf("TLS.CertFile = %q, want '/etc/ssl/cert.pem'", cfg.TLS.CertFile)
	}
	if cfg.TLS.KeyFile != "/etc/ssl/key.pem" {
		t.Errorf("TLS.KeyFile = %q, want '/etc/ssl/key.pem'", cfg.TLS.KeyFile)
	}
	if cfg.TLS.Domain != "example.com" {
		t.Errorf("TLS.Domain = %q, want 'example.com'", cfg.TLS.Domain)
	}
}

func TestLoadVoiceConfigDefaults(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}

	if cfg.Voice.Quality != "medium" {
		t.Errorf("Voice.Quality = %q, want 'medium'", cfg.Voice.Quality)
	}
	if cfg.Voice.LiveKitURL != "ws://localhost:7880" {
		t.Errorf("Voice.LiveKitURL = %q, want 'ws://localhost:7880'", cfg.Voice.LiveKitURL)
	}
	// Key and secret should be auto-generated (non-empty, not the old defaults).
	if cfg.Voice.LiveKitAPIKey == "" {
		t.Error("Voice.LiveKitAPIKey should be auto-generated, got empty")
	}
	if cfg.Voice.LiveKitAPIKey == config.DefaultLiveKitAPIKey {
		t.Error("Voice.LiveKitAPIKey should not be the well-known default")
	}
	if cfg.Voice.LiveKitAPISecret == "" {
		t.Error("Voice.LiveKitAPISecret should be auto-generated, got empty")
	}
	if cfg.Voice.LiveKitAPISecret == config.DefaultLiveKitAPISecret {
		t.Error("Voice.LiveKitAPISecret should not be the well-known default")
	}
}

func TestLoadVoiceConfigFromYAML(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	yaml := `
voice:
  quality: high
  livekit_api_key: "mykey"
  livekit_api_secret: "mysecret"
  livekit_url: "ws://lk.example.com:7880"
`
	if err := os.WriteFile(cfgPath, []byte(yaml), 0o644); err != nil {
		t.Fatalf("failed to write yaml: %v", err)
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}

	if cfg.Voice.Quality != "high" {
		t.Errorf("Voice.Quality = %q, want 'high'", cfg.Voice.Quality)
	}
	if cfg.Voice.LiveKitAPIKey != "mykey" {
		t.Errorf("Voice.LiveKitAPIKey = %q, want 'mykey'", cfg.Voice.LiveKitAPIKey)
	}
	if cfg.Voice.LiveKitAPISecret != "mysecret" {
		t.Errorf("Voice.LiveKitAPISecret = %q, want 'mysecret'", cfg.Voice.LiveKitAPISecret)
	}
	if cfg.Voice.LiveKitURL != "ws://lk.example.com:7880" {
		t.Errorf("Voice.LiveKitURL = %q, want 'ws://lk.example.com:7880'", cfg.Voice.LiveKitURL)
	}
}

func TestLoadUploadBoundaryValues(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	yaml := "upload:\n  max_size_mb: 0\n"
	if err := os.WriteFile(cfgPath, []byte(yaml), 0o644); err != nil {
		t.Fatalf("failed to write yaml: %v", err)
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
	if cfg.Upload.MaxSizeMB != 0 {
		t.Errorf("Upload.MaxSizeMB = %d, want 0", cfg.Upload.MaxSizeMB)
	}
}
