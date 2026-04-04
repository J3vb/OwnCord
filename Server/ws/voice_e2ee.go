package ws

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"
	"sync"
)

// e2eeKeySize is the number of random bytes for each per-channel E2EE key.
// 32 bytes = 256 bits, matching AES-256-GCM used by LiveKit's SFrame E2EE.
const e2eeKeySize = 32

// VoiceE2EEKeys manages ephemeral per-channel symmetric encryption keys for
// LiveKit end-to-end encrypted voice/video. Keys are generated when the first
// participant joins a voice channel and cleared when the channel empties.
//
// Keys are distributed to participants via the voice_token WS message (which
// itself travels over the TLS-encrypted WebSocket connection). The LiveKit SFU
// never sees the keys — it only forwards encrypted SFrame payloads.
type VoiceE2EEKeys struct {
	mu   sync.Mutex
	keys map[int64]string // channelID → base64-encoded 256-bit key
}

// NewVoiceE2EEKeys creates an empty key store.
func NewVoiceE2EEKeys() *VoiceE2EEKeys {
	return &VoiceE2EEKeys{
		keys: make(map[int64]string),
	}
}

// KeyForChannel returns the E2EE key for a channel, generating a new one if
// none exists (i.e. the first participant is joining). The key is returned as
// a base64-encoded string suitable for transmission in JSON.
func (v *VoiceE2EEKeys) KeyForChannel(channelID int64) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if key, ok := v.keys[channelID]; ok {
		return key, nil
	}

	// Generate a fresh 256-bit key.
	raw := make([]byte, e2eeKeySize)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("voice e2ee: generating key: %w", err)
	}
	encoded := base64.StdEncoding.EncodeToString(raw)
	v.keys[channelID] = encoded

	slog.Info("voice e2ee: generated new channel key", "channel_id", channelID)
	return encoded, nil
}

// ClearChannel removes the E2EE key for a channel. Should be called when the
// last participant leaves the voice channel so that the next session gets a
// fresh key.
func (v *VoiceE2EEKeys) ClearChannel(channelID int64) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if _, ok := v.keys[channelID]; ok {
		delete(v.keys, channelID)
		slog.Info("voice e2ee: cleared channel key", "channel_id", channelID)
	}
}
