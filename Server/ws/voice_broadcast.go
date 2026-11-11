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
	// Shared by the four voice moderation commands; each fans a voice_state or voice_leave out to everyone
	// who can see the channel.
	voiceModRateLimit = 5
	voiceModWindow    = time.Second
	// Extra per-target limit on a voice_mod_move that relies on the missing rank rule.
	voiceModMoveTargetLimit  = 3
	voiceModMoveTargetWindow = 30 * time.Second
)

// voiceQualities maps accepted voice quality presets to target bitrate in bits/s; the single source of truth
// (voice_join.go validates against its keys).
var voiceQualities = map[string]int{
	"low":    32000,
	"medium": 64000,
	"high":   128000,
}

func qualityBitrate(quality string) int {
	if bitrate, ok := voiceQualities[quality]; ok {
		return bitrate
	}
	return voiceQualities["medium"]
}

// voiceEventAudience resolves who must receive a voice_state / voice_leave for channelID:
// connected clients whose role may READ it, unioned with the room's participants, narrowed
// by filterDMAudience for a one-to-one DM. Participants are always included because
// membership can outlive READ_MESSAGES (a mid-call revocation, or a DM call after the DM
// closed); excluding them would leave their client with a stale E2EE key holder, stalling
// rotation until e2ee_timeout. subjectID is whose state this is: a stranger's DM voice call
// must stay as invisible to a recipient who has not accepted the message request as chat and typing are.
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

// filterDMAudience narrows audience, for a one-to-one DM, to subjectID (always kept) plus
// every other member who trusts subjectID; non-DM channels and group DMs are returned as-is.
// A lookup error fails CLOSED to subjectID alone: the full audience would leak a stranger's
// voice presence to the room.
func (h *Hub) filterDMAudience(ctx context.Context, channelID, subjectID int64, audience []int64) []int64 {
	// Bare test hubs with no DB have no readers (same guard as channelReadAudienceImpl).
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

// broadcastVoiceEvent enqueues a voice_state / voice_leave for voiceEventAudience. Not
// BroadcastToAll, which would expose voice channels that channel_overrides hide from a
// role (buildReady filters them). Tagging the real channel id also makes reconnect replay
// filter it. The audience is resolved on the caller's goroutine so the dispatch loop never
// blocks on permission lookups.
func (h *Hub) broadcastVoiceEvent(ctx context.Context, channelID, subjectID int64, msg []byte) {
	mark := h.audienceMark()
	h.broadcastChannelScopedTo(channelID, msg, h.voiceEventAudience(ctx, channelID, subjectID), mark, "voice event")
}

// sendVoiceEventSync delivers a voice_state / voice_leave synchronously on the caller's
// goroutine instead of via h.broadcast. voiceJoinComplete sends the joiner four other frames
// directly in program order; the joiner's own voice_state through the async queue would have
// no fixed position among them. Delivery matches deliverBroadcast's recipients path (seqMu,
// nextSeq, replay buffer, SendToUser); only the plugin dispatch hook is skipped, as
// SequencedDMEvent does (emit.go).
func (h *Hub) sendVoiceEventSync(ctx context.Context, channelID, subjectID int64, msg []byte) {
	mark := h.audienceMark()
	h.sendSequencedToUsers(channelID, h.voiceEventAudience(ctx, channelID, subjectID), mark, msg)
}

// broadcastVoiceEventWithLeaver is broadcastVoiceEvent guaranteeing leaverID is in the
// audience even though their client voice state is already cleared (which hides them from
// the participant union). Every teardown before voice_leave needs this: membership can
// outlive READ_MESSAGES, and a leaver without it would never learn the server ended their
// call. Mirrors CleanupVoiceForChannel's leaver union. leaverID is also the DM-audience subject.
func (h *Hub) broadcastVoiceEventWithLeaver(ctx context.Context, channelID int64, msg []byte, leaverID int64) {
	mark := h.audienceMark()
	audience := h.voiceEventAudience(ctx, channelID, leaverID)
	if !slices.Contains(audience, leaverID) {
		audience = append(audience, leaverID)
	}
	h.broadcastChannelScopedTo(channelID, msg, audience, mark, "voice event")
}

// VoiceSessionCount returns the number of connections in a voice channel (one call per account, so also
// users).
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
