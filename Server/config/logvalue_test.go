package config

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// TestSecretConfigsRedactedInLogs is the security guard for config redaction:
// no matter whether the whole Config or a single section is logged, the
// LiveKit key/secret, GitHub token, and Klipy key must never reach the output.
func TestSecretConfigsRedactedInLogs(t *testing.T) {
	const (
		lkKey    = "LIVEKIT_KEY_should_not_appear"
		lkSecret = "LIVEKIT_SECRET_should_not_appear"
		ghToken  = "ghp_token_should_not_appear"
		gifKey   = "klipy_key_should_not_appear"
	)
	cfg := Config{
		Voice:  VoiceConfig{LiveKitAPIKey: lkKey, LiveKitAPISecret: lkSecret, Quality: "high"},
		GitHub: GitHubConfig{Token: ghToken, Owner: "acme"},
		GIF:    GIFConfig{APIKey: gifKey},
	}

	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	log.Info("whole", "config", cfg) // whole-config path (delegating LogValue)
	log.Info("voice", "voice", cfg.Voice)
	log.Info("github", "github", cfg.GitHub)
	log.Info("gif", "gif", cfg.GIF)

	out := buf.String()
	for _, secret := range []string{lkKey, lkSecret, ghToken, gifKey} {
		if strings.Contains(out, secret) {
			t.Errorf("secret leaked into log output: %q\n%s", secret, out)
		}
	}
	if !strings.Contains(out, "high") || !strings.Contains(out, "acme") {
		t.Errorf("expected non-secret fields in output:\n%s", out)
	}
	if !strings.Contains(out, "[REDACTED]") {
		t.Errorf("expected redaction marker in output:\n%s", out)
	}
}
