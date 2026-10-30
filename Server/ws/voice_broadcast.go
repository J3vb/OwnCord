package ws

import (
	"context"
	"slices"
	"time"
)

const (
	voiceMuteRateLimit        = 2
	voiceMuteWindow           = time.Second
	voiceDeafenRateLimit      = 2
	voiceDeafenWindow         = time.Second
	voiceCameraRateLimit      = 2
	voiceCameraWindow         = time.Second
	voiceScreenshareRateLimit = 2
	voiceScreenshareWindow    = time.Second
	// Shared by the four voice moderation commands; each fans a voice_state or
	// voice_leave broadcast out to everyone who can see the channel.
	voiceModRateLimit = 5
	voiceModWindow    = time.Second
	// Extra per-target limit on a voice_mod_move that relies on the missing rank rule
	// (the target ranks at or above the mover).
	voiceModMoveTargetLimit  = 3
	voiceModMoveTargetWindow = 30 * time.Second
)

// voiceQualities maps accepted voice quality presets to their target bitrate in
// bits/s; the single source of truth (voice_join.go validates against its keys).
var voiceQualities = map[string]int{
	"low":    32000,
	"medium": 64000,
	"high":   128000,
}

// qualityBitrate returns the target audio bitrate in bits/s for a quality preset.
func qualityBitrate(quality string) int {
	if bitrate, ok := voiceQualities[quality]; ok {
		return bitrate
	}
	return voiceQualities["medium"]
}

// voiceEventAudience resolves who must receive a voice_state / voice_leave for
// channelID: the connected clients whose current role may READ it, unioned with
// the room's own participants, then narrowed by filterDMAudience for a one-to-one DM.
//
// The participants are always included because voice membership can outlive
// READ_MESSAGES (a mid-call revocation, or a DM call after the DM was closed): the
// READ filter would exclude a live participant, whose client would keep a stale E2EE
// key holder, stalling rotation and locking new joiners out until e2ee_timeout.
//
// subjectID is whose voice state this event is about: a stranger's DM voice call
// must stay as invisible to a recipient who has not accepted the message request as
// their chat and typing are.
func (h *Hub) voiceEventAudience(ctx context.Context, channelID, subjectID int64) []int64 {
	audience := h.channelReadAudience(ctx, channelID)
	seen := make(map[int64]struct{}, len(audience))
	for _, uid := range audience {
		seen[uid] = struct{}{}
	}
	h.mu.RLock()
	for _, c := range h.allClientsLocked() {
		if _, ok := seen[c.userID]; !ok && c.voice.channel() == channelID {
			seen[c.userID] = struct{}{}
			audience = append(audience, c.userID)
		}
	}
	h.mu.RUnlock()
	return h.filterDMAudience(ctx, channelID, subjectID, audience)
}

// filterDMAudience narrows audience, when channelID is a one-to-one DM, to
// subjectID (always kept) plus every other member who trusts subjectID. Non-DM
// channels and group DMs are returned as-is. A channel or group lookup error fails
// CLOSED to subjectID alone: falling back to the full audience would leak a
// stranger's voice presence to everyone in the room.
func (h *Hub) filterDMAudience(ctx context.Context, channelID, subjectID int64, audience []int64) []int64 {
	// Bare test hubs with no DB have no readers to consult (the same guard
	// channelReadAudienceImpl uses).
	if h.db == nil {
		return audience
	}
	ch, err := h.readers.Visibility.GetChannel(ctx, channelID)
	if err != nil {
		return []int64{subjectID}
	}
	if ch == nil || ch.Type != "dm" {
		return audience
	}
	isGroup, gErr := h.readers.Visibility.IsGroupDM(ctx, channelID)
	if gErr != nil {
		return []int64{subjectID}
	}
	if isGroup {
		return audience
	}
	filtered := make([]int64, 0, len(audience))
	for _, uid := range audience {
		if uid == subjectID {
			filtered = append(filtered, uid)
			continue
		}
		if trusted, tErr := h.readers.Visibility.IsTrustedSender(ctx, uid, subjectID); tErr == nil && trusted {
			filtered = append(filtered, uid)
		}
	}
	return filtered
}

// broadcastVoiceEvent enqueues a voice_state / voice_leave message for
// voiceEventAudience(channelID, subjectID). Not BroadcastToAll, which would hand
// every client the membership and camera/mute state of voice channels that
// channel_overrides hides from their role (buildReady filters them). Tagging the
// event with its real channel id also makes reconnect replay filter it.
//
// The audience is resolved here, on the caller's goroutine, so the hub's dispatch
// loop never blocks on permission lookups.
func (h *Hub) broadcastVoiceEvent(ctx context.Context, channelID, subjectID int64, msg []byte) {
	h.broadcastChannelScopedTo(channelID, msg, h.voiceEventAudience(ctx, channelID, subjectID), "voice event")
}

// sendVoiceEventSync stamps and delivers a voice_state / voice_leave for
// voiceEventAudience(channelID, subjectID) synchronously on the caller's goroutine
// instead of enqueuing it on h.broadcast. voiceJoinComplete sends the joiner four
// other frames (voice_token, existing participants' voice_state, E2EE peer keys,
// voice_config) directly via c.sendMsg in program order; a joiner's own voice_state
// through the async queue would have no fixed position among them. Delivery matches
// deliverBroadcast's recipients path (seqMu, nextSeq, the replay buffer,
// SendToUser); only the plugin dispatch hook is skipped, as SequencedDMEvent does
// for every synchronous per-recipient send (emit.go).
func (h *Hub) sendVoiceEventSync(ctx context.Context, channelID, subjectID int64, msg []byte) {
	h.sendSequencedToUsers(channelID, h.voiceEventAudience(ctx, channelID, subjectID), msg)
}

// broadcastVoiceEventWithLeaver is broadcastVoiceEvent guaranteeing leaverID is in
// the audience even though the caller already cleared their client-side voice state,
// which hides them from the participant union. Every path that tears down a
// participant before the voice_leave goes out needs this: voice membership can
// outlive READ_MESSAGES, so a leaver without it would never learn the server ended
// their call. Mirrors CleanupVoiceForChannel's per-batch leaver union. leaverID is
// also the DM-audience subject: the leaver always sees their own leave.
func (h *Hub) broadcastVoiceEventWithLeaver(ctx context.Context, channelID int64, msg []byte, leaverID int64) {
	audience := h.voiceEventAudience(ctx, channelID, leaverID)
	if !slices.Contains(audience, leaverID) {
		audience = append(audience, leaverID)
	}
	h.broadcastChannelScopedTo(channelID, msg, audience, "voice event")
}

// VoiceSessionCount returns the number of connections currently in a voice
// channel (an account is in at most one call, so also the number of users).
func (h *Hub) VoiceSessionCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	count := 0
	for _, c := range h.allClientsLocked() {
		if c.voice.channel() != 0 {
			count++
		}
	}
	return count
}
