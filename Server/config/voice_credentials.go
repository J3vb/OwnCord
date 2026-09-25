package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strings"
)

// DefaultLiveKitAPIKey and DefaultLiveKitAPISecret are the well-known dev
// credentials that ship in the default config. They must never be used in
// production — NewLiveKitClient rejects them.
const (
	DefaultLiveKitAPIKey    = "devkey"
	DefaultLiveKitAPISecret = "owncord-dev-secret-key-min-32chars" //nolint:gosec // G101: false positive — config key name, not a credential
)

// placeholderCredentialPrefix starts the LiveKit key and secret shipped in
// Server/.env.example. Those values are public in this repository, so an
// install that copied the file without editing it must be treated exactly
// like one still on the dev defaults.
const placeholderCredentialPrefix = "change-me"

// IsDefaultVoiceCredentials returns true when the voice config still uses
// the well-known default dev credentials shipped in the source code, or the
// placeholder values from Server/.env.example.
func IsDefaultVoiceCredentials(v *VoiceConfig) bool {
	return v.LiveKitAPIKey == DefaultLiveKitAPIKey ||
		v.LiveKitAPISecret == DefaultLiveKitAPISecret ||
		strings.HasPrefix(v.LiveKitAPIKey, placeholderCredentialPrefix) ||
		strings.HasPrefix(v.LiveKitAPISecret, placeholderCredentialPrefix)
}

// generateRandomKey returns a crypto-random hex string of the given byte length.
func generateRandomKey(byteLen int) (string, error) {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("crypto/rand: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// ensureVoiceCredentials generates unique random LiveKit credentials when
// API key/secret are empty, so voice works out of the box without shipping
// known-public defaults. It also refills URL and quality: Unmarshal leaves them
// alone when the section is merely empty, but a document that NAMES one with an
// explicit `livekit_url: ""` overwrites the default, and an empty URL makes
// NewLiveKitClient refuse and disables voice.
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
