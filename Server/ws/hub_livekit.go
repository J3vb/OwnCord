package ws

import (
	"context"
	"fmt"
)

// GenerateToken delegates to the LiveKit client. Returns an error if LiveKit
// is not configured (HubOptions.LiveKit was nil). Satisfies
// VoiceTokenGenerator so the Hub can be passed as a dep at registration time.
func (h *Hub) GenerateToken(userID int64, username string, channelID int64, voiceJoinToken string, canPublish, canSubscribe, canVideo, canScreenShare bool) (string, error) {
	if h.livekit == nil {
		return "", fmt.Errorf("voice not configured")
	}
	return h.livekit.GenerateToken(userID, username, channelID, voiceJoinToken, canPublish, canSubscribe, canVideo, canScreenShare)
}

// URL delegates to the LiveKit client. Returns empty string if not configured.
func (h *Hub) URL() string {
	if h.livekit == nil {
		return ""
	}
	return h.livekit.URL()
}

// LiveKitHealthCheck probes the LiveKit server for connectivity.
// It tries the SDK client first (ListRooms), and falls back to an HTTP probe
// if a managed process is configured. Returns false with a reason if LiveKit
// is not configured or unreachable.
func (h *Hub) LiveKitHealthCheck(ctx context.Context) (bool, error) {
	if h.livekit == nil {
		return false, fmt.Errorf("not configured")
	}
	return h.livekit.HealthCheck(ctx)
}

// The LiveKit process manager arrives via HubOptions.LiveKitProcess (B3-4);
// its only hub consumer is the voice_join guard reading IsRunning to fail
// closed while the supervised SFU is down.
