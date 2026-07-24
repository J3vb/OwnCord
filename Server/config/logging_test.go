package config

import (
	"log/slog"
	"path/filepath"
	"testing"
)

func TestParseLevel(t *testing.T) {
	cases := []struct {
		in   string
		want slog.Level
		ok   bool
	}{
		{"debug", slog.LevelDebug, true},
		{"info", slog.LevelInfo, true},
		{"", slog.LevelInfo, true},
		{"WARN", slog.LevelWarn, true},
		{"warning", slog.LevelWarn, true},
		{"error", slog.LevelError, true},
		{"  Debug  ", slog.LevelDebug, true},
		{"bogus", slog.LevelInfo, false},
	}
	for _, c := range cases {
		got, ok := ParseLevel(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("ParseLevel(%q) = %v,%v want %v,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

// TestLoggingLevelFromEnv verifies the end-to-end wiring: OWNCORD_LOGGING_LEVEL
// overrides config.yaml via koanf's existing env layer.
func TestLoggingLevelFromEnv(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	t.Setenv("OWNCORD_LOGGING_LEVEL", "debug")

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Logging.Level != "debug" {
		t.Errorf("expected level %q from env, got %q", "debug", cfg.Logging.Level)
	}
	if lvl, ok := ParseLevel(cfg.Logging.Level); !ok || lvl != slog.LevelDebug {
		t.Errorf("ParseLevel(%q) = %v,%v", cfg.Logging.Level, lvl, ok)
	}
}
