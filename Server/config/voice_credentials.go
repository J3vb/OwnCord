package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strings"
)

// DefaultLiveKitAPIKey and DefaultLiveKitAPISecret are the public dev credentials; NewLiveKitClient rejects
// them.
const (
	DefaultLiveKitAPIKey    = "devkey"
	DefaultLiveKitAPISecret = "owncord-dev-secret-key-min-32chars" //nolint:gosec // G101: false positive — config key name, not a credential
)

// placeholderCredentialPrefix starts the LiveKit key and secret in Server/.env.example; those values are
// public, so an unedited copy is treated like the dev defaults.
const placeholderCredentialPrefix = "change-me"

// IsDefaultVoiceCredentials reports whether the voice config still uses the
// well-known dev credentials or the Server/.env.example placeholders.
func IsDefaultVoiceCredentials(v *VoiceConfig) bool {
	return v.LiveKitAPIKey == DefaultLiveKitAPIKey ||
		v.LiveKitAPISecret == DefaultLiveKitAPISecret ||
		strings.HasPrefix(v.LiveKitAPIKey, placeholderCredentialPrefix) ||
		strings.HasPrefix(v.LiveKitAPISecret, placeholderCredentialPrefix)
}

func generateRandomKey(byteLen int) (string, error) {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("crypto/rand: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// ensureVoiceCredentials generates random LiveKit credentials when key/secret are empty. It also refills URL
// and quality: an explicit `livekit_url: ""` overwrites the default, and an empty URL disables voice.
func ensureVoiceCredentials(v *VoiceConfig) error {
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
