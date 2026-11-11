package config_test

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

// An allowed web origin pasted with a trailing slash is stored and loaded as
// scheme://host[:port], the only form a browser's Origin header ever matches,
// and a wildcard is left alone.
func TestAllowedOrigins_TrailingSlashIsDropped(t *testing.T) {
	dir := t.TempDir()
	mustDo(t, "SaveOverrides", config.SaveOverrides(config.OverridesPath(dir), map[string]any{
		"server.allowed_origins": []any{"https://chat.example/", "http://localhost:3000"},
	}))
	saved, err := config.ReadOverrides(config.OverridesPath(dir))
	mustDo(t, "ReadOverrides", err)
	want := []string{"https://chat.example", "http://localhost:3000"}
	if got, ok := saved["server.allowed_origins"].([]string); !ok || !slices.Equal(got, want) {
		t.Errorf("saved override = %#v, want %v", saved["server.allowed_origins"], want)
	}

	cfgPath := filepath.Join(dir, "config.yaml")
	yaml := "server:\n  data_dir: " + filepath.ToSlash(dir) + "\n  allowed_origins:\n    - \"https://hand.example/\"\n    - \"*\"\n"
	mustDo(t, "write config", os.WriteFile(cfgPath, []byte(yaml), 0o600))
	t.Setenv("OWNCORD_SERVER_DATA_DIR", "")
	cfg, err := config.Load(cfgPath)
	mustDo(t, "Load", err)
	// The override layer replaces the file's list; both forms must come out clean.
	if !slices.Equal(cfg.Server.AllowedOrigins, want) {
		t.Errorf("loaded override origins = %v, want %v", cfg.Server.AllowedOrigins, want)
	}
	mustDo(t, "remove override", config.SaveOverrides(config.OverridesPath(dir), map[string]any{"server.allowed_origins": nil}))
	cfg, err = config.Load(cfgPath)
	mustDo(t, "Load file only", err)
	if want := []string{"https://hand.example", "*"}; !slices.Equal(cfg.Server.AllowedOrigins, want) {
		t.Errorf("loaded file origins = %v, want %v", cfg.Server.AllowedOrigins, want)
	}
}
