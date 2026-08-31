package ws

import (
	"context"
	"time"
)

// Voice rate limit settings.
const (
	voiceMuteRateLimit        = 2
	voiceMuteWindow           = time.Second
	voiceDeafenRateLimit      = 2
	voiceDeafenWindow         = time.Second
	voiceCameraRateLimit      = 2
	voiceCameraWindow         = time.Second
	voiceScreenshareRateLimit = 2
	voiceScreenshareWindow    = time.Second
	// Shared by the four voice moderation commands. Each fans a voice_state or
	// voice_leave broadcast out to everyone who can see the channel.
	voiceModRateLimit = 5
	voiceModWindow    = time.Second
)

// voiceQualities maps accepted voice quality presets to their target bitrate
// in bits/s. This is the single source of truth — voice_join.go validates
// against these keys, qualityBitrate looks up the value.
var voiceQualities = map[string]int{
	"low":    32000,
	"medium": 64000,
	"high":   128000,
}

// qualityBitrate returns the target audio bitrate in bits/s based on a quality preset.
func qualityBitrate(quality string) int {
	if bitrate, ok := voiceQualities[quality]; ok {
		return bitrate
	}
	return voiceQualities["medium"]
}

// broadcastVoiceEvent enqueues a voice_state / voice_leave message for the
// connected clients whose current role may READ channelID.
//
// These events used to go out via BroadcastToAll, which handed every
// authenticated client the membership and camera/mute state of voice channels
// that channel_overrides hides from their role — while the equivalent read path
// (buildReady) deliberately filters voice states to readable channels. Tagging
// the event with its real channel id also makes reconnect replay filter it,
// where a channelID of 0 was replayed unconditionally.
//
// The audience is resolved here, on the caller's goroutine, so the hub's
// dispatch loop never blocks on permission lookups.
func (h *Hub) broadcastVoiceEvent(ctx context.Context, channelID int64, msg []byte) {
	// A room's own participants must always receive its voice_state /
	// voice_leave: voice membership is gated on CONNECT_VOICE alone, so the
	// READ filter can exclude a live participant — whose client then keeps a
	// stale E2EE key holder, stalling rotation and locking new joiners out
	// until e2ee_timeout. Union the READ audience with the room's current
	// participants; what outsiders may observe is unchanged.
	audience := h.channelReadAudience(ctx, channelID)
	seen := make(map[int64]struct{}, len(audience))
	for _, uid := range audience {
		seen[uid] = struct{}{}
	}
	h.mu.RLock()
	for uid, c := range h.clients {
		if _, ok := seen[uid]; !ok && c.getVoiceChID() == channelID {
			audience = append(audience, uid)
		}
	}
	h.mu.RUnlock()
	h.broadcastChannelScopedTo(channelID, msg, audience, "voice event")
}

// broadcastVoiceEventWithLeaver is broadcastVoiceEvent extended to guarantee
// leaverID is in the audience even though the caller has already cleared
// their client-side voice state — which means broadcastVoiceEvent's own
// still-in-the-room participant union can no longer see them. Every path
// that tears down a voice participant whose client state is cleared before
// the voice_leave goes out needs this: voice membership is gated on
// CONNECT_VOICE alone, so a leaver without READ_MESSAGES on the channel
// would otherwise never learn the server already ended their call. Mirrors
// CleanupVoiceForChannel's per-batch leaver union, for the single-leaver case.
func (h *Hub) broadcastVoiceEventWithLeaver(ctx context.Context, channelID int64, msg []byte, leaverID int64) {
	audience := h.channelReadAudience(ctx, channelID)
	seen := make(map[int64]struct{}, len(audience)+1)
	for _, uid := range audience {
		seen[uid] = struct{}{}
	}
	h.mu.RLock()
	for uid, c := range h.clients {
		if _, ok := seen[uid]; !ok && c.getVoiceChID() == channelID {
			seen[uid] = struct{}{}
			audience = append(audience, uid)
		}
	}
	h.mu.RUnlock()
	if _, ok := seen[leaverID]; !ok {
		audience = append(audience, leaverID)
	}
	h.broadcastChannelScopedTo(channelID, msg, audience, "voice event")
}

// VoiceSessionCount returns the number of clients currently in a voice channel.
func (h *Hub) VoiceSessionCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	count := 0
	for _, c := range h.clients {
		if c.getVoiceChID() != 0 {
			count++
		}
	}
	return count
}
