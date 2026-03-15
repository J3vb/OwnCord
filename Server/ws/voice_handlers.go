package ws

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/permissions"
)

// Voice rate limit settings.
const (
	voiceSignalRateLimit    = 20
	voiceSignalWindow       = time.Second
	soundboardRateLimit     = 1
	soundboardWindow        = 3 * time.Second
)

// handleVoiceJoin processes a voice_join message.
// 1. Checks CONNECT_VOICE permission.
// 2. Persists join in DB.
// 3. Broadcasts voice_state to channel.
// 4. Sends all current voice states in the channel back to the joiner.
func (h *Hub) handleVoiceJoin(c *Client, payload json.RawMessage) {
	channelID, err := parseChannelID(payload)
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "channel_id must be a positive integer"))
		return
	}

	if !h.hasChannelPerm(c, channelID, permissions.ConnectVoice) {
		c.sendMsg(buildErrorMsg("FORBIDDEN", "missing CONNECT_VOICE permission"))
		return
	}

	if err := h.db.JoinVoiceChannel(c.userID, channelID); err != nil {
		slog.Error("ws handleVoiceJoin JoinVoiceChannel", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to join voice channel"))
		return
	}

	state, err := h.db.GetVoiceState(c.userID)
	if err != nil || state == nil {
		slog.Error("ws handleVoiceJoin GetVoiceState", "err", err, "user_id", c.userID)
		return
	}

	// Broadcast the joiner's state to all clients currently in this voice channel.
	h.BroadcastToChannel(channelID, buildVoiceState(*state))

	// Send existing channel voice states to the joiner.
	existing, err := h.db.GetChannelVoiceStates(channelID)
	if err != nil {
		slog.Error("ws handleVoiceJoin GetChannelVoiceStates", "err", err)
		return
	}
	for _, vs := range existing {
		if vs.UserID == c.userID {
			continue // skip the joiner themselves
		}
		c.sendMsg(buildVoiceState(vs))
	}
}

// handleVoiceLeave processes an explicit voice_leave message or a disconnect.
// 1. Removes voice state from DB.
// 2. Broadcasts voice_leave to the channel the user was in.
func (h *Hub) handleVoiceLeave(c *Client) {
	state, err := h.db.GetVoiceState(c.userID)
	if err != nil {
		slog.Error("ws handleVoiceLeave GetVoiceState", "err", err, "user_id", c.userID)
	}

	if leaveErr := h.db.LeaveVoiceChannel(c.userID); leaveErr != nil {
		slog.Error("ws handleVoiceLeave LeaveVoiceChannel", "err", leaveErr, "user_id", c.userID)
	}

	if state != nil {
		h.BroadcastToChannel(state.ChannelID, buildVoiceLeave(state.ChannelID, c.userID))
	}
}

// handleVoiceMute processes a voice_mute message.
// 1. Parses muted bool.
// 2. Updates DB.
// 3. Broadcasts voice_state update to channel.
func (h *Hub) handleVoiceMute(c *Client, payload json.RawMessage) {
	var p struct {
		Muted bool `json:"muted"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid voice_mute payload"))
		return
	}

	if err := h.db.UpdateVoiceMute(c.userID, p.Muted); err != nil {
		slog.Error("ws handleVoiceMute UpdateVoiceMute", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to update mute state"))
		return
	}

	h.broadcastVoiceStateUpdate(c)
}

// handleVoiceDeafen processes a voice_deafen message.
// 1. Parses deafened bool.
// 2. Updates DB.
// 3. Broadcasts voice_state update to channel.
func (h *Hub) handleVoiceDeafen(c *Client, payload json.RawMessage) {
	var p struct {
		Deafened bool `json:"deafened"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid voice_deafen payload"))
		return
	}

	if err := h.db.UpdateVoiceDeafen(c.userID, p.Deafened); err != nil {
		slog.Error("ws handleVoiceDeafen UpdateVoiceDeafen", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to update deafen state"))
		return
	}

	h.broadcastVoiceStateUpdate(c)
}

// handleVoiceSignal relays voice_offer, voice_answer, and voice_ice messages.
// 1. Rate limits at 20/sec per user.
// 2. Parses channel_id from payload.
// 3. Relays the message (with original type) to all other channel members.
// SDP/ICE content is not inspected or logged.
func (h *Hub) handleVoiceSignal(c *Client, msgType string, payload json.RawMessage) {
	ratKey := fmt.Sprintf("voice_signal:%d", c.userID)
	if !h.limiter.Allow(ratKey, voiceSignalRateLimit, voiceSignalWindow) {
		c.sendMsg(buildErrorMsg("RATE_LIMITED", "too many signaling messages"))
		return
	}

	channelID, err := parseChannelID(payload)
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "channel_id must be a positive integer"))
		return
	}

	relayed := buildVoiceSignalRelay(msgType, channelID, payload)
	h.broadcastExclude(channelID, c.userID, relayed)
}

// handleSoundboard processes a soundboard_play message.
// 1. Rate limits at 1 per 3 seconds.
// 2. Checks USE_SOUNDBOARD permission.
// 3. Broadcasts soundboard_play (with user_id) to all connected clients.
func (h *Hub) handleSoundboard(c *Client, payload json.RawMessage) {
	ratKey := fmt.Sprintf("soundboard:%d", c.userID)
	if !h.limiter.Allow(ratKey, soundboardRateLimit, soundboardWindow) {
		c.sendMsg(buildErrorMsg("RATE_LIMITED", "soundboard is on cooldown"))
		return
	}

	if !h.hasChannelPerm(c, 0, permissions.UseSoundboard) {
		c.sendMsg(buildErrorMsg("FORBIDDEN", "missing USE_SOUNDBOARD permission"))
		return
	}

	var p struct {
		SoundID string `json:"sound_id"`
	}
	if err := json.Unmarshal(payload, &p); err != nil || p.SoundID == "" {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "sound_id is required"))
		return
	}

	h.BroadcastToAll(buildSoundboardPlay(p.SoundID, c.userID))
}

// broadcastVoiceStateUpdate fetches the current voice state for the client
// and broadcasts it to all members of the voice channel they are in.
func (h *Hub) broadcastVoiceStateUpdate(c *Client) {
	state, err := h.db.GetVoiceState(c.userID)
	if err != nil {
		slog.Error("ws broadcastVoiceStateUpdate GetVoiceState", "err", err, "user_id", c.userID)
		return
	}
	if state == nil {
		return // user not in a voice channel — nothing to broadcast
	}
	h.BroadcastToChannel(state.ChannelID, buildVoiceState(*state))
}
