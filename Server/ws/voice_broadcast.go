package ws

import (
	"context"
	"slices"
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

// voiceEventAudience resolves who must receive a voice_state / voice_leave
// for channelID: the connected clients whose current role may READ it,
// unioned with the room's own current participants, then narrowed by
// filterDMAudience when channelID is a one-to-one DM.
//
// A room's own participants must always receive its voice_state /
// voice_leave: voice membership is gated on CONNECT_VOICE alone, so the
// READ filter can exclude a live participant — whose client then keeps a
// stale E2EE key holder, stalling rotation and locking new joiners out
// until e2ee_timeout. Union the READ audience with the room's current
// participants; what outsiders may observe is unchanged.
//
// subjectID is whose voice state this event is about (B5-6, Codex P1-2): a
// stranger's DM voice call must stay as invisible to a recipient who has not
// accepted the message request as their chat and typing are.
func (h *Hub) voiceEventAudience(ctx context.Context, channelID, subjectID int64) []int64 {
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
	return h.filterDMAudience(ctx, channelID, subjectID, audience)
}

// filterDMAudience narrows audience to B5-6's sender-aware set when
// channelID is a one-to-one DM: subjectID (whose voice state this event
// describes) is always kept, every other member of audience only if they
// trust subjectID. Non-DM channels and group DMs (decision 4 — untouched)
// are returned as-is. Codex review round 2, P2: a channel/group lookup
// error fails CLOSED to subjectID alone rather than falling back to the
// full unfiltered audience — the earlier fail-open posture leaked a
// stranger's voice presence to everyone in the room the moment either
// lookup errored, exactly the leak this filter exists to prevent.
func (h *Hub) filterDMAudience(ctx context.Context, channelID, subjectID int64, audience []int64) []int64 {
	// Bare test hubs with no DB (h.db == nil) have no readers to consult —
	// same guard channelReadAudienceImpl uses before its own GetChannel call.
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
// voiceEventAudience(channelID, subjectID).
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
func (h *Hub) broadcastVoiceEvent(ctx context.Context, channelID, subjectID int64, msg []byte) {
	h.broadcastChannelScopedTo(channelID, msg, h.voiceEventAudience(ctx, channelID, subjectID), "voice event")
}

// sendVoiceEventSync stamps and delivers a voice_state / voice_leave for
// voiceEventAudience(channelID, subjectID) synchronously on the caller's own
// goroutine, instead of enqueuing it on h.broadcast for the async dispatch
// goroutine to pick up later. OC-0349: voiceJoinComplete sends the joiner
// four other frames (voice_token, existing participants' voice_state, E2EE
// peer keys, voice_config) directly via c.sendMsg, in program order; a
// joiner's own voice_state relayed through the async queue instead has no
// fixed position among them, since it depends on how backed up the dispatch
// goroutine is. This shares deliverBroadcast's recipients-path delivery
// exactly (seqMu, nextSeq, the replay buffer, SendToUser) — the only thing
// skipped is the plugin dispatch hook, the same trade-off SequencedDMEvent
// already makes for every synchronous per-recipient send (emit.go).
func (h *Hub) sendVoiceEventSync(ctx context.Context, channelID, subjectID int64, msg []byte) {
	h.sendSequencedToUsers(channelID, h.voiceEventAudience(ctx, channelID, subjectID), msg)
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
// leaverID also doubles as the DM-audience subject (B5-6): the leaver always
// sees their own leave.
func (h *Hub) broadcastVoiceEventWithLeaver(ctx context.Context, channelID int64, msg []byte, leaverID int64) {
	audience := h.voiceEventAudience(ctx, channelID, leaverID)
	if !slices.Contains(audience, leaverID) {
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
