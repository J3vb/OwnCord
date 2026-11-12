package ws

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/livekitproc"
)

// GenerateToken delegates to the LiveKit client; errors when LiveKit is not configured. Satisfies
// VoiceTokenGenerator.
func (h *Hub) GenerateToken(userID int64, username string, channelID int64, voiceJoinToken string, canPublish, canVideo, canScreenShare bool) (string, error) {
	if h.livekit == nil {
		return "", fmt.Errorf("voice not configured")
	}
	return h.livekit.GenerateToken(userID, username, channelID, voiceJoinToken, canPublish, canVideo, canScreenShare)
}

// URL delegates to the LiveKit client; "" when not configured.
func (h *Hub) URL() string {
	if h.livekit == nil {
		return ""
	}
	return h.livekit.URL()
}

// LiveKitHealthCheck reports whether LiveKit answers a room listing, from a verdict at most 5 s old
// shared with voice_join, metrics and /health (one probe in flight). False with a reason when not
// configured or unreachable.
func (h *Hub) LiveKitHealthCheck(ctx context.Context) (bool, error) {
	if h.livekit == nil {
		return false, fmt.Errorf("not configured")
	}
	return h.livekit.CachedHealthCheck(ctx)
}

// LiveKitHealthProbe is LiveKitHealthCheck without the cache; only the operator's explicit health
// probe uses it.
func (h *Hub) LiveKitHealthProbe(ctx context.Context) (bool, error) {
	if h.livekit == nil {
		return false, fmt.Errorf("not configured")
	}
	return h.livekit.HealthCheck(ctx)
}

// LiveKitProcessStatus reports the supervised companion's local state. Managed false (externally
// managed) means "don't check", not "down". Probes nothing.
func (h *Hub) LiveKitProcessStatus() livekitproc.Status {
	if h.voiceHub.lkProcess == nil {
		return livekitproc.Status{}
	}
	return h.voiceHub.lkProcess.Status()
}

// RestartLiveKit wakes a supervisor that gave up restarting the companion; false when there is
// nothing to restart.
func (h *Hub) RestartLiveKit() bool {
	if h.voiceHub.lkProcess == nil {
		return false
	}
	return h.voiceHub.lkProcess.Restart()
}

// LiveKitPID returns the companion's process id; false when unmanaged or not running.
func (h *Hub) LiveKitPID() (int, bool) {
	if h.voiceHub.lkProcess == nil {
		return 0, false
	}
	return h.voiceHub.lkProcess.PID()
}

// LiveKitRoomUsage returns open room and participant counts from LiveKit's room service.
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

// The process manager arrives via HubOptions.LiveKitProcess; its only hub consumer is the
// voice_join guard reading IsRunning to fail closed while the SFU is down.
