package config_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/storage"
)

func loadUploadYAML(t *testing.T, body string) (*config.Config, error) {
	t.Helper()
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return config.Load(cfgPath)
}

func TestUploadFileTypes_Defaults(t *testing.T) {
	cfg, err := loadUploadYAML(t, "upload:\n  max_size_mb: 10\n")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !slices.Equal(cfg.Upload.BlockedExtensions, storage.DefaultBlockedExtensions) {
		t.Errorf("blocked_extensions = %q, want the default list", cfg.Upload.BlockedExtensions)
	}
	if len(cfg.Upload.AllowedExtensions) != 0 {
		t.Errorf("allowed_extensions = %q, want empty (allow-only mode off)", cfg.Upload.AllowedExtensions)
	}
}

func TestUploadFileTypes_FileValuesAreNormalized(t *testing.T) {
	cfg, err := loadUploadYAML(t, "upload:\n  blocked_extensions: [\".BAT\", cmd]\n  allowed_extensions: [PNG, .pdf]\n")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if want := []string{"bat", "cmd"}; !slices.Equal(cfg.Upload.BlockedExtensions, want) {
		t.Errorf("blocked_extensions = %q, want %q", cfg.Upload.BlockedExtensions, want)
	}
	if want := []string{"png", "pdf"}; !slices.Equal(cfg.Upload.AllowedExtensions, want) {
		t.Errorf("allowed_extensions = %q, want %q", cfg.Upload.AllowedExtensions, want)
	}
}

func TestUploadFileTypes_EmptyBlockedListIsHonoured(t *testing.T) {
	cfg, err := loadUploadYAML(t, "upload:\n  blocked_extensions: []\n")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.Upload.BlockedExtensions) != 0 {
		t.Errorf("blocked_extensions = %q, want empty", cfg.Upload.BlockedExtensions)
	}
}

func TestUploadFileTypes_InvalidEntryFailsLoad(t *testing.T) {
	_, err := loadUploadYAML(t, "upload:\n  allowed_extensions: [\"tar.gz\"]\n")
	if err == nil || !strings.Contains(err.Error(), "upload.allowed_extensions") {
		t.Fatalf("Load = %v, want an upload.allowed_extensions error", err)
	}
	_, err = loadUploadYAML(t, "upload:\n  blocked_extensions: [bat, cmd, ...]\n")
	if err == nil || !strings.Contains(err.Error(), "upload.blocked_extensions") {
		t.Fatalf("Load = %v, want an upload.blocked_extensions error for ...", err)
	}
}

func TestUploadFileTypes_EnvOverride(t *testing.T) {
	t.Setenv("OWNCORD_UPLOAD_ALLOWED_EXTENSIONS", "png,jpg")
	cfg, err := loadUploadYAML(t, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if want := []string{"png", "jpg"}; !slices.Equal(cfg.Upload.AllowedExtensions, want) {
		t.Errorf("allowed_extensions = %q, want %q", cfg.Upload.AllowedExtensions, want)
	}
}
