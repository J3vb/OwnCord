package config_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

// loadNoEnv loads cfgPath ensuring no OWNCORD_ env overrides leak in from the
// test environment.
func loadNoEnv(t *testing.T, cfgPath string) *config.Config {
	t.Helper()
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
	return cfg
}

func TestSavePatchesGeneratedDefaultFile(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	// Generate the default file the way first startup does.
	loadNoEnv(t, cfgPath)

	err := config.Save(cfgPath, config.Patch{
		ServerPort:      new(9000),
		ServerName:      new("My Cool Server"),
		TLSMode:         new("off"),
		UploadMaxSizeMB: new(250),
		VoiceQuality:    new("high"),
	})
	if err != nil {
		t.Fatalf("Save() returned error: %v", err)
	}

	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("reading patched file: %v", err)
	}
	text := string(raw)

	// Documentation comments must survive the round-trip.
	for _, want := range []string{
		"# OwnCord Server Configuration",
		"self_signed, acme, manual, off",
		"# telemetry:",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("patched file lost comment %q", want)
		}
	}

	cfg := loadNoEnv(t, cfgPath)
	if cfg.Server.Port != 9000 {
		t.Errorf("Server.Port = %d, want 9000", cfg.Server.Port)
	}
	if cfg.Server.Name != "My Cool Server" {
		t.Errorf("Server.Name = %q, want 'My Cool Server'", cfg.Server.Name)
	}
	if cfg.TLS.Mode != "off" {
		t.Errorf("TLS.Mode = %q, want 'off'", cfg.TLS.Mode)
	}
	if cfg.Upload.MaxSizeMB != 250 {
		t.Errorf("Upload.MaxSizeMB = %d, want 250", cfg.Upload.MaxSizeMB)
	}
	if cfg.Voice.Quality != "high" {
		t.Errorf("Voice.Quality = %q, want 'high'", cfg.Voice.Quality)
	}
	// Untouched values keep their file defaults.
	if cfg.Database.Path != "data/chatserver.db" {
		t.Errorf("Database.Path = %q, want default", cfg.Database.Path)
	}
}

func TestSavePreservesHandEdits(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	handEdited := `# my important operator note
server:
  port: 8443
  name: "Old Name"
  trusted_proxies: ["10.0.0.2/32"]

gif:
  api_key: "klipy-secret"

custom_section:
  custom_key: 42
`
	if err := os.WriteFile(cfgPath, []byte(handEdited), 0o600); err != nil {
		t.Fatalf("writing hand-edited file: %v", err)
	}

	if err := config.Save(cfgPath, config.Patch{ServerName: new("New Name")}); err != nil {
		t.Fatalf("Save() returned error: %v", err)
	}

	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("reading patched file: %v", err)
	}
	text := string(raw)
	for _, want := range []string{
		"# my important operator note",
		"10.0.0.2/32",
		"klipy-secret",
		"custom_key: 42",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("patched file lost hand-edited content %q", want)
		}
	}

	cfg := loadNoEnv(t, cfgPath)
	if cfg.Server.Name != "New Name" {
		t.Errorf("Server.Name = %q, want 'New Name'", cfg.Server.Name)
	}
	if cfg.Server.Port != 8443 {
		t.Errorf("Server.Port = %d, want 8443 (untouched)", cfg.Server.Port)
	}
	if cfg.GIF.APIKey != "klipy-secret" {
		t.Errorf("GIF.APIKey = %q, want preserved", cfg.GIF.APIKey)
	}
}

func TestSaveCreatesMissingFileFromTemplate(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	if err := config.Save(cfgPath, config.Patch{ServerPort: new(9999)}); err != nil {
		t.Fatalf("Save() returned error: %v", err)
	}

	info, err := os.Stat(cfgPath)
	if err != nil {
		t.Fatalf("stat patched file: %v", err)
	}
	if runtime.GOOS != "windows" {
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("file mode = %o, want 0600", perm)
		}
	}

	raw, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(raw), "# OwnCord Server Configuration") {
		t.Error("file created from template lost the documentation header")
	}

	cfg := loadNoEnv(t, cfgPath)
	if cfg.Server.Port != 9999 {
		t.Errorf("Server.Port = %d, want 9999", cfg.Server.Port)
	}
}

func TestSaveVoiceCredentialsOnlyWhenEmpty(t *testing.T) {
	t.Run("written when absent", func(t *testing.T) {
		tmpDir := t.TempDir()
		cfgPath := filepath.Join(tmpDir, "config.yaml")
		loadNoEnv(t, cfgPath) // default file: livekit creds commented out

		err := config.Save(cfgPath, config.Patch{
			VoiceAPIKey:    new("key-abc123"),
			VoiceAPISecret: new("0123456789abcdef0123456789abcdef"),
		})
		if err != nil {
			t.Fatalf("Save() returned error: %v", err)
		}

		cfg := loadNoEnv(t, cfgPath)
		if cfg.Voice.LiveKitAPIKey != "key-abc123" {
			t.Errorf("LiveKitAPIKey = %q, want persisted key", cfg.Voice.LiveKitAPIKey)
		}
		if cfg.Voice.LiveKitAPISecret != "0123456789abcdef0123456789abcdef" {
			t.Errorf("LiveKitAPISecret = %q, want persisted secret", cfg.Voice.LiveKitAPISecret)
		}
	})

	t.Run("never overwritten when set", func(t *testing.T) {
		tmpDir := t.TempDir()
		cfgPath := filepath.Join(tmpDir, "config.yaml")
		existing := `voice:
  livekit_api_key: "operator-key"
  livekit_api_secret: "operator-secret-thats-32-chars-x"
`
		if err := os.WriteFile(cfgPath, []byte(existing), 0o600); err != nil {
			t.Fatalf("writing file: %v", err)
		}

		err := config.Save(cfgPath, config.Patch{
			VoiceAPIKey:    new("key-should-not-win"),
			VoiceAPISecret: new("secret-should-not-win-9876543210"),
		})
		if err != nil {
			t.Fatalf("Save() returned error: %v", err)
		}

		cfg := loadNoEnv(t, cfgPath)
		if cfg.Voice.LiveKitAPIKey != "operator-key" {
			t.Errorf("LiveKitAPIKey = %q, operator value was clobbered", cfg.Voice.LiveKitAPIKey)
		}
		if cfg.Voice.LiveKitAPISecret != "operator-secret-thats-32-chars-x" {
			t.Errorf("LiveKitAPISecret = %q, operator value was clobbered", cfg.Voice.LiveKitAPISecret)
		}
	})
}

func TestSaveVoiceAutoDownloadBool(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")
	loadNoEnv(t, cfgPath) // generated default file has auto_download_livekit: true

	if err := config.Save(cfgPath, config.Patch{VoiceAutoDownload: new(false)}); err != nil {
		t.Fatalf("Save() returned error: %v", err)
	}
	cfg := loadNoEnv(t, cfgPath)
	if cfg.Voice.AutoDownloadLiveKit {
		t.Error("Voice.AutoDownloadLiveKit = true, want false after patch")
	}

	if err := config.Save(cfgPath, config.Patch{VoiceAutoDownload: new(true)}); err != nil {
		t.Fatalf("Save() returned error: %v", err)
	}
	cfg = loadNoEnv(t, cfgPath)
	if !cfg.Voice.AutoDownloadLiveKit {
		t.Error("Voice.AutoDownloadLiveKit = false, want true after re-patch")
	}
}

func TestSaveYAMLInjectionIsInert(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")
	loadNoEnv(t, cfgPath)

	hostile := "x\nserver:\n  port: 1 # pwned"
	if err := config.Save(cfgPath, config.Patch{ServerName: new(hostile)}); err != nil {
		t.Fatalf("Save() returned error: %v", err)
	}

	cfg := loadNoEnv(t, cfgPath)
	if cfg.Server.Name != hostile {
		t.Errorf("Server.Name = %q, want the hostile string as one inert scalar", cfg.Server.Name)
	}
	if cfg.Server.Port != 8443 {
		t.Errorf("Server.Port = %d, want 8443 — injection changed a sibling key", cfg.Server.Port)
	}
}

func TestSaveLeavesUnparseableFileIntact(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")

	for name, content := range map[string]string{
		"invalid yaml":     "\tserver: [",
		"root not mapping": "just a scalar\n",
	} {
		t.Run(name, func(t *testing.T) {
			if err := os.WriteFile(cfgPath, []byte(content), 0o600); err != nil {
				t.Fatalf("writing file: %v", err)
			}
			if err := config.Save(cfgPath, config.Patch{ServerPort: new(9000)}); err == nil {
				t.Fatal("Save() succeeded on a file it cannot safely patch")
			}
			raw, err := os.ReadFile(cfgPath)
			if err != nil {
				t.Fatalf("reading file: %v", err)
			}
			if string(raw) != content {
				t.Error("failed Save() modified the original file")
			}
		})
	}
}
