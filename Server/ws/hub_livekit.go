package ws

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/livekitproc"
)

// GenerateToken delegates to the LiveKit client. Returns an error if LiveKit
// is not configured (HubOptions.LiveKit was nil). Satisfies
// VoiceTokenGenerator so the Hub can be passed as a dep at registration time.
func (h *Hub) GenerateToken(userID int64, username string, channelID int64, voiceJoinToken string, canPublish, canVideo, canScreenShare bool) (string, error) {
	if h.livekit == nil {
		return "", fmt.Errorf("voice not configured")
	}
	return h.livekit.GenerateToken(userID, username, channelID, voiceJoinToken, canPublish, canVideo, canScreenShare)
}

// URL delegates to the LiveKit client. Returns empty string if not configured.
func (h *Hub) URL() string {
	if h.livekit == nil {
		return ""
	}
	return h.livekit.URL()
}

// LiveKitHealthCheck reports whether the LiveKit server answers a room listing,
// from a verdict at most 5 s old shared with voice_join, metrics, diagnostics and
// /health (one probe in flight at a time). Returns false with a reason if LiveKit
// is not configured or unreachable.
func (h *Hub) LiveKitHealthCheck(ctx context.Context) (bool, error) {
	if h.livekit == nil {
		return false, fmt.Errorf("not configured")
	}
	return h.livekit.CachedHealthCheck(ctx)
}

// LiveKitHealthProbe is LiveKitHealthCheck without the cache: one room listing now.
// Only the operator's explicit /api/v1/livekit/health probe uses it.
func (h *Hub) LiveKitHealthProbe(ctx context.Context) (bool, error) {
	if h.livekit == nil {
		return false, fmt.Errorf("not configured")
	}
	return h.livekit.HealthCheck(ctx)
}

// LiveKitProcessStatus reports the supervised companion's local state
// (running, restart count, gave-up). Managed is false when LiveKit is
// externally managed (no companion), which callers must read as "don't
// check" rather than "down". Reading it probes nothing.
func (h *Hub) LiveKitProcessStatus() livekitproc.Status {
	if h.voiceHub.lkProcess == nil {
		return livekitproc.Status{}
	}
	return h.voiceHub.lkProcess.Status()
}

// LiveKitPID returns the supervised companion's process id; ok is false when
// LiveKit is not managed or no process is running right now.
func (h *Hub) LiveKitPID() (int, bool) {
	if h.voiceHub.lkProcess == nil {
		return 0, false
	}
	return h.voiceHub.lkProcess.PID()
}

// LiveKitRoomUsage returns the open room and participant counts from LiveKit's
// room service.
func (h *Hub) LiveKitRoomUsage(ctx context.Context) (rooms, participants int, err error) {
	if h.livekit == nil {
		return 0, 0, fmt.Errorf("not configured")
	}
	return h.livekit.RoomUsage(ctx)
}

// LiveKitManaged reports whether OwnCord supervises the companion process.
func (h *Hub) LiveKitManaged() bool {
	return h.voiceHub.lkProcess != nil
}

// The LiveKit process manager arrives via HubOptions.LiveKitProcess;
// its only hub consumer is the voice_join guard reading IsRunning to fail
// closed while the supervised SFU is down.
