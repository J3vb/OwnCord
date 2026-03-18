package ws

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// Voice rate limit settings.
const (
	voiceSignalRateLimit    = 20
	voiceSignalWindow       = time.Second
	soundboardRateLimit     = 1
	soundboardWindow        = 3 * time.Second
	voiceCameraRateLimit    = 2
	voiceCameraWindow       = time.Second
	voiceScreenshareRateLimit = 2
	voiceScreenshareWindow    = time.Second
)

// setupICEMonitor monitors ICE connection state changes on the client's
// PeerConnection. On failure/disconnect, it cleans up voice state.
func (h *Hub) setupICEMonitor(c *Client, channelID int64) {
	pc := c.getPC()
	if pc == nil {
		return
	}

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		slog.Info("ICE state change", "user_id", c.userID, "channel_id", channelID, "state", state.String())

		switch state {
		case webrtc.ICEConnectionStateFailed:
			slog.Warn("ICE connection failed, cleaning up voice", "user_id", c.userID, "channel_id", channelID)
			h.handleVoiceLeave(c)
		case webrtc.ICEConnectionStateDisconnected:
			// Disconnected is transient — ICE may recover.
			// Log but don't clean up immediately.
			slog.Info("ICE disconnected (may recover)", "user_id", c.userID, "channel_id", channelID)
		}
	})
}

// SetupICEMonitorForTest exposes setupICEMonitor for tests.
func (h *Hub) SetupICEMonitorForTest(c *Client, channelID int64) {
	h.setupICEMonitor(c, channelID)
}

// setupICECallback registers an OnICECandidate handler on the client's
// PeerConnection to send server-generated ICE candidates to the client.
func (h *Hub) setupICECallback(c *Client, channelID int64) {
	pc := c.getPC()
	if pc == nil {
		return
	}
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return // gathering complete
		}
		c.sendMsg(buildVoiceICE(channelID, candidate.ToJSON()))
	})
}

// renegotiateParticipant creates a new SDP offer for the given client
// and sends it as voice_offer. Implements the "impolite" side of
// Perfect Negotiation — skips if PC is in have-remote-offer state.
func (h *Hub) renegotiateParticipant(c *Client) {
	pc := c.getPC()
	if pc == nil {
		return
	}

	// Perfect Negotiation: server is impolite — skip if client
	// already sent an offer we haven't answered yet.
	if pc.SignalingState() == webrtc.SignalingStateHaveRemoteOffer {
		slog.Info("renegotiate skipped: have-remote-offer",
			"user_id", c.userID)
		return
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		slog.Error("renegotiateParticipant CreateOffer",
			"err", err, "user_id", c.userID)
		return
	}

	if err := pc.SetLocalDescription(offer); err != nil {
		slog.Error("renegotiateParticipant SetLocalDescription",
			"err", err, "user_id", c.userID)
		return
	}

	channelID := c.getVoiceChID()
	c.sendMsg(buildVoiceOffer(channelID, offer.SDP))
}

// handleVoiceJoin processes a voice_join message.
// 1. Parses channel_id.
// 2. Checks CONNECT_VOICE permission.
// 3. If already in a different voice channel, leaves it first.
// 4. Gets or creates VoiceRoom with config from channel settings.
// 5. Adds participant to VoiceRoom (checks capacity).
// 6. Persists join in DB.
// 7. Creates PeerConnection if SFU is available.
// 8. Broadcasts voice_state to channel.
// 9. Sends existing voice states to joiner.
// 10. Sends voice_config to joiner.
func (h *Hub) handleVoiceJoin(c *Client, payload json.RawMessage) {
	channelID, err := parseChannelID(payload)
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "channel_id must be a positive integer"))
		return
	}

	if !h.requireChannelPerm(c, channelID, permissions.ConnectVoice, "CONNECT_VOICE") {
		return
	}

	currentChID := c.getVoiceChID()

	// HIGH-2: If user is already in the same voice channel, no-op.
	if currentChID == channelID {
		c.sendMsg(buildErrorMsg("ALREADY_JOINED", "already in this voice channel"))
		return
	}

	// If user is already in a different voice channel, leave it first.
	if currentChID > 0 {
		h.handleVoiceLeave(c)
	}

	ch, err := h.db.GetChannel(channelID)
	if err != nil || ch == nil {
		c.sendMsg(buildErrorMsg("NOT_FOUND", "channel not found"))
		return
	}

	roomCfg := h.buildVoiceRoomConfig(ch)
	room := h.GetOrCreateVoiceRoom(channelID, roomCfg)

	if addErr := room.AddParticipant(c.userID); addErr != nil {
		if errors.Is(addErr, ErrRoomFull) {
			c.sendMsg(buildErrorMsg("CHANNEL_FULL", "voice channel is full"))
		} else {
			c.sendMsg(buildErrorMsg("VOICE_ERROR", "failed to join voice channel"))
		}
		return
	}

	if err := h.db.JoinVoiceChannel(c.userID, channelID); err != nil {
		room.RemoveParticipant(c.userID)
		slog.Error("ws handleVoiceJoin JoinVoiceChannel", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to join voice channel"))
		return
	}

	// Create PeerConnection if SFU is available. Non-fatal on failure.
	var pc *webrtc.PeerConnection
	if h.sfu != nil {
		var pcErr error
		pc, pcErr = h.sfu.NewPeerConnection()
		if pcErr != nil {
			slog.Error("ws handleVoiceJoin NewPeerConnection", "err", pcErr, "user_id", c.userID)
		}
	}

	// Track the voice channel and PC on the client atomically (CRIT-1 fix).
	c.setVoice(channelID, pc)

	if pc != nil {
		h.setupOnTrack(c, channelID)
		h.setupICEMonitor(c, channelID)
		h.setupICECallback(c, channelID)
	}

	state, err := h.db.GetVoiceState(c.userID)
	if err != nil || state == nil {
		slog.Error("ws handleVoiceJoin GetVoiceState", "err", err, "user_id", c.userID)
		return
	}

	// Broadcast the joiner's state to all connected clients so every sidebar updates.
	h.BroadcastToAll(buildVoiceState(*state))

	// Send existing channel voice states to the joiner.
	existing, err := h.db.GetChannelVoiceStates(channelID)
	if err != nil {
		slog.Error("ws handleVoiceJoin GetChannelVoiceStates", "err", err)
		return
	}
	for _, vs := range existing {
		if vs.UserID == c.userID {
			continue
		}
		c.sendMsg(buildVoiceState(vs))
	}

	// Send voice_config to the joiner with room settings.
	quality := roomCfg.Quality
	bitrate := 64000 // default medium
	if h.sfu != nil {
		bitrate = h.sfu.QualityBitrate()
	}
	c.sendMsg(buildVoiceConfig(channelID, quality, bitrate, room.Mode(), roomCfg.MixingThreshold, roomCfg.TopSpeakers, roomCfg.MaxUsers))

	slog.Info("voice join", "user_id", c.userID, "channel_id", channelID, "participants", room.ParticipantCount(), "mode", room.Mode())
}

// buildVoiceRoomConfig constructs a VoiceRoomConfig from channel settings and server defaults.
func (h *Hub) buildVoiceRoomConfig(ch *db.Channel) VoiceRoomConfig {
	cfg := VoiceRoomConfig{
		ChannelID:       ch.ID,
		MaxUsers:        ch.VoiceMaxUsers,
		Quality:         "medium",
		MixingThreshold: 10,
		TopSpeakers:     3,
		MaxVideo:        ch.VoiceMaxVideo,
	}
	if ch.VoiceQuality != nil && *ch.VoiceQuality != "" {
		cfg.Quality = *ch.VoiceQuality
	}
	if ch.MixingThreshold != nil {
		cfg.MixingThreshold = *ch.MixingThreshold
	}
	return cfg
}

// handleVoiceLeave processes an explicit voice_leave message or a disconnect.
// 1. Reads current voice state (for broadcast).
// 2. Closes PeerConnection if active.
// 3. Removes participant from VoiceRoom; removes room if empty.
// 4. Removes voice state from DB.
// 5. Broadcasts voice_leave to the channel the user was in.
func (h *Hub) handleVoiceLeave(c *Client) {
	state, err := h.db.GetVoiceState(c.userID)
	if err != nil {
		slog.Error("ws handleVoiceLeave GetVoiceState", "err", err, "user_id", c.userID)
	}

	// Atomically clear voice state and get old values for cleanup (CRIT-1 fix).
	oldChID, oldPC := c.clearVoice()

	// Close PeerConnection if active.
	// This also causes any setupOnTrack goroutine to exit via track.Read error (HIGH-1).
	if oldPC != nil {
		if closeErr := oldPC.Close(); closeErr != nil {
			slog.Error("ws handleVoiceLeave pc.Close", "err", closeErr, "user_id", c.userID)
		}
	}

	// Remove from VoiceRoom and clean up empty rooms.
	if oldChID > 0 {
		if room := h.GetVoiceRoom(oldChID); room != nil {
			room.RemoveParticipant(c.userID)
			if room.IsEmpty() {
				h.RemoveVoiceRoom(oldChID)
			}
		}
	}

	if leaveErr := h.db.LeaveVoiceChannel(c.userID); leaveErr != nil {
		slog.Error("ws handleVoiceLeave LeaveVoiceChannel", "err", leaveErr, "user_id", c.userID)
	}

	if state != nil {
		h.BroadcastToAll(buildVoiceLeave(state.ChannelID, c.userID))
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

// handleVoiceCamera processes a voice_camera message.
// 1. Rate limits at 2/sec per user.
// 2. Checks USE_VIDEO permission.
// 3. Parses enabled bool.
// 4. Updates DB.
// 5. Broadcasts voice_state update to channel.
func (h *Hub) handleVoiceCamera(c *Client, payload json.RawMessage) {
	ratKey := fmt.Sprintf("voice_camera:%d", c.userID)
	if !h.limiter.Allow(ratKey, voiceCameraRateLimit, voiceCameraWindow) {
		c.sendMsg(buildRateLimitError("too many camera toggles", voiceCameraWindow.Seconds()))
		return
	}

	voiceChID := c.getVoiceChID()
	if voiceChID == 0 {
		c.sendMsg(buildErrorMsg("VOICE_ERROR", "not in a voice channel"))
		return
	}

	if !h.requireChannelPerm(c, voiceChID, permissions.UseVideo, "USE_VIDEO") {
		return
	}

	var p struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid voice_camera payload"))
		return
	}

	if err := h.db.UpdateVoiceCamera(c.userID, p.Enabled); err != nil {
		slog.Error("ws handleVoiceCamera UpdateVoiceCamera", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to update camera state"))
		return
	}

	h.broadcastVoiceStateUpdate(c)
}

// handleVoiceScreenshare processes a voice_screenshare message.
// 1. Rate limits at 2/sec per user.
// 2. Checks SHARE_SCREEN permission.
// 3. Parses enabled bool.
// 4. Updates DB.
// 5. Broadcasts voice_state update to channel.
func (h *Hub) handleVoiceScreenshare(c *Client, payload json.RawMessage) {
	ratKey := fmt.Sprintf("voice_screenshare:%d", c.userID)
	if !h.limiter.Allow(ratKey, voiceScreenshareRateLimit, voiceScreenshareWindow) {
		c.sendMsg(buildRateLimitError("too many screenshare toggles", voiceScreenshareWindow.Seconds()))
		return
	}

	voiceChID := c.getVoiceChID()
	if voiceChID == 0 {
		c.sendMsg(buildErrorMsg("VOICE_ERROR", "not in a voice channel"))
		return
	}

	if !h.requireChannelPerm(c, voiceChID, permissions.ShareScreen, "SHARE_SCREEN") {
		return
	}

	var p struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid voice_screenshare payload"))
		return
	}

	if err := h.db.UpdateVoiceScreenshare(c.userID, p.Enabled); err != nil {
		slog.Error("ws handleVoiceScreenshare UpdateVoiceScreenshare", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to update screenshare state"))
		return
	}

	h.broadcastVoiceStateUpdate(c)
}

// handleVoiceOffer processes a voice_offer from the client.
// The client sends an SDP offer; the server sets it as remote description
// on the client's PeerConnection, creates an answer, and sends it back.
func (h *Hub) handleVoiceOffer(c *Client, payload json.RawMessage) {
	ratKey := fmt.Sprintf("voice_signal:%d", c.userID)
	if !h.limiter.Allow(ratKey, voiceSignalRateLimit, voiceSignalWindow) {
		c.sendMsg(buildRateLimitError("too many signaling messages", voiceSignalWindow.Seconds()))
		return
	}

	pc := c.getPC()
	if pc == nil {
		c.sendMsg(buildErrorMsg("VOICE_ERROR", "not in a voice channel"))
		return
	}

	var p struct {
		ChannelID json.Number `json:"channel_id"`
		SDP       string      `json:"sdp"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid voice_offer payload"))
		return
	}
	if p.SDP == "" {
		c.sendMsg(buildErrorMsg("INVALID_SDP", "SDP is required"))
		return
	}

	offer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  p.SDP,
	}

	if err := pc.SetRemoteDescription(offer); err != nil {
		slog.Error("ws handleVoiceOffer SetRemoteDescription", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INVALID_SDP", "failed to set remote description"))
		return
	}

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		slog.Error("ws handleVoiceOffer CreateAnswer", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("VOICE_ERROR", "failed to create answer"))
		return
	}

	if err := pc.SetLocalDescription(answer); err != nil {
		slog.Error("ws handleVoiceOffer SetLocalDescription", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("VOICE_ERROR", "failed to set local description"))
		return
	}

	// Send the answer back to the client.
	c.sendMsg(buildVoiceAnswer(c.getVoiceChID(), answer.SDP))
}

// handleVoiceAnswer processes a voice_answer from the client.
// This handles the case where the server sent an offer (e.g., renegotiation)
// and the client responds with an answer.
func (h *Hub) handleVoiceAnswer(c *Client, payload json.RawMessage) {
	ratKey := fmt.Sprintf("voice_signal:%d", c.userID)
	if !h.limiter.Allow(ratKey, voiceSignalRateLimit, voiceSignalWindow) {
		c.sendMsg(buildRateLimitError("too many signaling messages", voiceSignalWindow.Seconds()))
		return
	}

	pc := c.getPC()
	if pc == nil {
		c.sendMsg(buildErrorMsg("VOICE_ERROR", "not in a voice channel"))
		return
	}

	var p struct {
		ChannelID json.Number `json:"channel_id"`
		SDP       string      `json:"sdp"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid voice_answer payload"))
		return
	}
	if p.SDP == "" {
		c.sendMsg(buildErrorMsg("INVALID_SDP", "SDP is required"))
		return
	}

	answer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  p.SDP,
	}

	if err := pc.SetRemoteDescription(answer); err != nil {
		slog.Error("ws handleVoiceAnswer SetRemoteDescription", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INVALID_SDP", "failed to set remote description"))
		return
	}
}

// handleVoiceICE processes a voice_ice (ICE candidate) from the client.
func (h *Hub) handleVoiceICE(c *Client, payload json.RawMessage) {
	ratKey := fmt.Sprintf("voice_signal:%d", c.userID)
	if !h.limiter.Allow(ratKey, voiceSignalRateLimit, voiceSignalWindow) {
		c.sendMsg(buildRateLimitError("too many signaling messages", voiceSignalWindow.Seconds()))
		return
	}

	pc := c.getPC()
	if pc == nil {
		c.sendMsg(buildErrorMsg("VOICE_ERROR", "not in a voice channel"))
		return
	}

	var p struct {
		ChannelID json.Number             `json:"channel_id"`
		Candidate webrtc.ICECandidateInit `json:"candidate"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid voice_ice payload"))
		return
	}

	if err := pc.AddICECandidate(p.Candidate); err != nil {
		slog.Error("ws handleVoiceICE AddICECandidate", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("VOICE_ERROR", "failed to add ICE candidate"))
		return
	}
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

	if !h.requireChannelPerm(c, 0, permissions.UseSoundboard, "USE_SOUNDBOARD") {
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

// setupOnTrack configures the PeerConnection's OnTrack handler to:
// 1. Read RTP packets from incoming audio tracks.
// 2. Parse the ssrc-audio-level header extension (RFC 6464).
// 3. Feed the audio levels into the VoiceRoom's SpeakerDetector.
//
// Must be called after c.pc is set and before SDP negotiation completes.
func (h *Hub) setupOnTrack(c *Client, channelID int64) {
	pc := c.getPC()
	if pc == nil {
		return
	}

	// audioLevelExtID is the negotiated extension ID for ssrc-audio-level.
	// In a real deployment this is resolved via SDP; we use ID 1 as the
	// conventional default matching the MediaEngine registration in sfu.go.
	const audioLevelExtID = 1

	// The goroutine spawned inside OnTrack exits when track.Read returns an
	// error, which happens when the PeerConnection is closed (HIGH-1).
	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		// Only process audio tracks for speaker detection.
		if track.Kind() != webrtc.RTPCodecTypeAudio {
			return
		}

		slog.Info("SFU OnTrack",
			"user_id", c.userID,
			"channel_id", channelID,
			"kind", track.Kind(),
			"codec", track.Codec().MimeType,
		)

		go func() {
			buf := make([]byte, 1500)
			for {
				n, _, readErr := track.Read(buf)
				if readErr != nil {
					return // track closed or connection gone
				}

				// Parse audio level from RTP header extension.
				level, _, found := ParseAudioLevel(buf[:n], audioLevelExtID)
				if !found {
					continue
				}

				room := h.GetVoiceRoom(channelID)
				if room == nil {
					return // room has been removed
				}

				room.UpdateSpeakerLevel(c.userID, level)
			}
		}()
	})
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
	h.BroadcastToAll(buildVoiceState(*state))
}
