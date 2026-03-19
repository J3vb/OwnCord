package ws

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// Voice rate limit settings.
const (
	voiceSignalRateLimit      = 20
	voiceSignalWindow         = time.Second
	voiceICERateLimit         = 50 // ICE candidates arrive in bursts during connection setup
	voiceICEWindow            = time.Second
	soundboardRateLimit       = 1
	soundboardWindow          = 3 * time.Second
	voiceCameraRateLimit      = 2
	voiceCameraWindow         = time.Second
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
		// Guard: ignore stale events from old PeerConnections after channel switch
		if c.getPC() != pc {
			slog.Debug("ignoring stale ICE event from old PC", "user_id", c.userID, "channel_id", channelID, "state", state.String())
			return
		}

		slog.Info("ICE state change", "user_id", c.userID, "channel_id", channelID, "state", state.String())

		switch state {
		case webrtc.ICEConnectionStateFailed:
			slog.Warn("ICE connection failed, cleaning up voice", "user_id", c.userID, "channel_id", channelID)
			if c.getVoiceChID() != 0 {
				h.handleVoiceLeave(c)
			}
		case webrtc.ICEConnectionStateClosed:
			// Closed means the PC was shut down (client destroyed it).
			// Safety net: only clean up if voice_leave hasn't already done it.
			if c.getVoiceChID() != 0 {
				slog.Info("ICE connection closed, cleaning up voice", "user_id", c.userID, "channel_id", channelID)
				h.handleVoiceLeave(c)
			}
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
			slog.Debug("ICE gathering complete", "user_id", c.userID, "channel_id", channelID)
			return
		}
		slog.Debug("SFU ICE candidate generated",
			"user_id", c.userID,
			"type", candidate.Typ.String(),
			"address", candidate.Address,
			"port", candidate.Port,
			"protocol", candidate.Protocol.String())
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

	// Perfect Negotiation: server is impolite — skip if we're already
	// mid-negotiation (client sent us an offer, or we sent one and are
	// waiting for an answer).
	state := pc.SignalingState()
	if state == webrtc.SignalingStateHaveRemoteOffer {
		slog.Info("renegotiate skipped: have-remote-offer",
			"user_id", c.userID)
		return
	}
	if state == webrtc.SignalingStateHaveLocalOffer {
		// Roll back our pending offer so we can create a fresh one
		// that includes all current tracks.
		if err := pc.SetLocalDescription(webrtc.SessionDescription{
			Type: webrtc.SDPTypeRollback,
		}); err != nil {
			slog.Error("renegotiateParticipant rollback failed",
				"err", err, "user_id", c.userID)
			return
		}
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

	// Add existing tracks to the new joiner's PC so they hear
	// participants who joined before them.
	if pc != nil {
		existingTracks := room.GetTracks()
		addedExisting := 0
		for _, vt := range existingTracks {
			if vt.Local == nil || vt.UserID == c.userID {
				continue
			}
			sender, addErr := pc.AddTrack(vt.Local)
			if addErr != nil {
				slog.Error("handleVoiceJoin AddTrack existing",
					"err", addErr,
					"from", vt.UserID, "to", c.userID)
				continue
			}
			vt.AddSender(c.userID, sender)
			addedExisting++
		}
		slog.Info("existing tracks added to new joiner",
			"user_id", c.userID,
			"existing_tracks_total", len(existingTracks),
			"tracks_added", addedExisting)
	}

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

	// Remove this user's track from all subscribers' PCs.
	// Done AFTER oldPC.Close() so the RTP goroutine has exited.
	if oldChID > 0 {
		if room := h.GetVoiceRoom(oldChID); room != nil {
			needsRenego := make(map[int64]*Client)
			for _, kind := range []string{"audio", "video"} {
				vt := room.RemoveTrack(c.userID, kind)
				if vt == nil {
					continue
				}
				senders := vt.CopySenders()
				for subID, sender := range senders {
					sub := h.GetClient(subID)
					if sub == nil {
						continue
					}
					subPC := sub.getPC()
					if subPC == nil {
						continue
					}
					if rmErr := subPC.RemoveTrack(sender); rmErr != nil {
						slog.Error("handleVoiceLeave RemoveTrack",
							"err", rmErr, "user_id", subID, "kind", kind)
					}
					needsRenego[subID] = sub
				}
			}
			for _, sub := range needsRenego {
				h.renegotiateParticipant(sub)
			}
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

	// Enforce MaxVideo limit when enabling camera.
	if p.Enabled {
		room := h.GetVoiceRoom(voiceChID)
		if room != nil {
			cfg := room.Config()
			if cfg.MaxVideo > 0 {
				allTracks := room.GetTracks()
				videoCount := 0
				for _, vt := range allTracks {
					if vt.Local != nil && strings.HasPrefix(vt.Local.ID(), "video-") {
						videoCount++
					}
				}
				if videoCount >= cfg.MaxVideo {
					c.sendMsg(buildErrorMsg("VIDEO_LIMIT",
						fmt.Sprintf("maximum %d video streams reached", cfg.MaxVideo)))
					return
				}
			}
		}
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

	// Perfect Negotiation: if we already have a pending local offer (glare
	// condition — server and client sent offers simultaneously), roll back
	// ours so we can accept the client's offer.
	if pc.SignalingState() == webrtc.SignalingStateHaveLocalOffer {
		if err := pc.SetLocalDescription(webrtc.SessionDescription{
			Type: webrtc.SDPTypeRollback,
		}); err != nil {
			slog.Error("ws handleVoiceOffer rollback failed", "err", err, "user_id", c.userID)
			c.sendMsg(buildErrorMsg("VOICE_ERROR", "failed to resolve signaling conflict"))
			return
		}
		slog.Info("handleVoiceOffer rolled back local offer (glare)", "user_id", c.userID)
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
	// ICE candidates use a separate, higher rate limit — they arrive in bursts
	// during connection setup and are mandatory for connectivity.
	ratKey := fmt.Sprintf("voice_ice:%d", c.userID)
	if !h.limiter.Allow(ratKey, voiceICERateLimit, voiceICEWindow) {
		c.sendMsg(buildRateLimitError("too many ICE candidates", voiceICEWindow.Seconds()))
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

	slog.Debug("client ICE candidate received",
		"user_id", c.userID,
		"candidate", p.Candidate.Candidate)
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

	// channelID=0: soundboard is a server-wide permission with no per-channel
	// override. The client does not send a channel_id in the payload.
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
// 1. Create a TrackLocalStaticRTP for SFU fan-out.
// 2. Store it on the VoiceRoom as a VoiceTrack.
// 3. Add the local track to all other participants' PCs and renegotiate.
// 4. Forward RTP packets while parsing audio levels for speaker detection.
//
// Must be called after c.pc is set and before SDP negotiation completes.
func (h *Hub) setupOnTrack(c *Client, channelID int64) {
	pc := c.getPC()
	if pc == nil {
		return
	}

	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		// Determine kind from the remote track.
		var kind string
		switch track.Kind() {
		case webrtc.RTPCodecTypeAudio:
			kind = "audio"
		case webrtc.RTPCodecTypeVideo:
			kind = "video"
		default:
			return
		}

		slog.Info("SFU OnTrack",
			"user_id", c.userID,
			"channel_id", channelID,
			"kind", kind,
			"codec", track.Codec().MimeType,
		)

		// Create local track for fan-out using the remote track's codec.
		local, err := webrtc.NewTrackLocalStaticRTP(
			track.Codec().RTPCodecCapability,
			fmt.Sprintf("%s-%d", kind, c.userID),
			fmt.Sprintf("user-%d-%s", c.userID, kind),
		)
		if err != nil {
			slog.Error("setupOnTrack NewTrackLocalStaticRTP",
				"err", err, "user_id", c.userID, "kind", kind)
			return
		}

		room := h.GetVoiceRoom(channelID)
		if room == nil {
			return
		}

		// Store track on room.
		room.SetTrack(c.userID, kind, track, local)
		vt := room.GetTrack(c.userID, kind)

		// Collect other participant IDs (lock ordering: VoiceRoom.mu released before voiceMu).
		participantIDs := room.ParticipantIDs()

		// Add local track to each other participant's PC.
		addedCount := 0
		for _, pid := range participantIDs {
			if pid == c.userID {
				continue
			}
			other := h.GetClient(pid)
			if other == nil {
				slog.Debug("setupOnTrack: participant not found", "from", c.userID, "to", pid)
				continue
			}
			otherPC := other.getPC()
			if otherPC == nil {
				slog.Debug("setupOnTrack: participant has no PC", "from", c.userID, "to", pid)
				continue
			}
			sender, addErr := otherPC.AddTrack(local)
			if addErr != nil {
				slog.Error("setupOnTrack AddTrack",
					"err", addErr,
					"from", c.userID, "to", pid)
				continue
			}
			if vt != nil {
				vt.AddSender(pid, sender)
			}
			addedCount++
			h.renegotiateParticipant(other)
		}
		slog.Info("SFU track fan-out",
			"from_user", c.userID,
			"channel_id", channelID,
			"kind", kind,
			"participants", len(participantIDs),
			"tracks_added", addedCount)

		// Log transceiver state on each subscriber's PC for this track
		for _, pid := range participantIDs {
			if pid == c.userID {
				continue
			}
			other := h.GetClient(pid)
			if other == nil {
				continue
			}
			otherPC := other.getPC()
			if otherPC == nil {
				continue
			}
			for _, tr := range otherPC.GetTransceivers() {
				if tr.Sender() != nil && tr.Sender().Track() != nil &&
					tr.Sender().Track().StreamID() == fmt.Sprintf("user-%d-%s", c.userID, kind) {
					slog.Info("subscriber transceiver state",
						"subscriber", pid,
						"track_from", c.userID,
						"direction", tr.Direction().String(),
						"mid", tr.Mid(),
						"sender_track_id", tr.Sender().Track().ID(),
						"sender_track_stream", tr.Sender().Track().StreamID())
				}
			}
		}

		// RTP forwarding + audio level goroutine.
		// Capture the done channel so this goroutine exits even if PC.Close fails.
		done := c.getVoiceDone()
		go func() {
			buf := make([]byte, 1500)
			var pktCount uint64

			// Warn if no RTP packets arrive within 5 seconds
			noPacketTimer := time.AfterFunc(5*time.Second, func() {
				slog.Warn("RTP: no packets received after 5s",
					"user_id", c.userID,
					"channel_id", channelID,
					"kind", kind)
			})
			defer noPacketTimer.Stop()

			for {
				// Check if voice session was torn down.
				select {
				case <-done:
					slog.Info("RTP goroutine exiting via done signal",
						"user_id", c.userID, "channel_id", channelID,
						"kind", kind,
						"packets_forwarded", pktCount)
					return
				default:
				}

				n, _, readErr := track.Read(buf)
				if readErr != nil {
					slog.Info("RTP read ended",
						"user_id", c.userID,
						"channel_id", channelID,
						"kind", kind,
						"packets_forwarded", pktCount,
						"err", readErr.Error())
					return
				}

				// Forward RTP to local track (Pion fans out to all subscribers).
				if _, writeErr := local.Write(buf[:n]); writeErr != nil {
					slog.Info("RTP write ended",
						"user_id", c.userID,
						"channel_id", channelID,
						"kind", kind,
						"packets_forwarded", pktCount,
						"err", writeErr.Error())
					return
				}
				pktCount++
				if pktCount == 1 {
					noPacketTimer.Stop()
					slog.Info("RTP first packet received",
						"user_id", c.userID,
						"channel_id", channelID,
						"kind", kind,
						"bytes", n)
				} else if pktCount%1000 == 0 {
					slog.Info("RTP forwarding",
						"user_id", c.userID,
						"channel_id", channelID,
						"kind", kind,
						"packets", pktCount)
				}

				// Speaker detection only applies to audio tracks.
				if kind != "audio" {
					continue
				}

				// Extract audio level directly from raw RTP bytes (avoids full Unmarshal).
				level, ok := extractAudioLevel(buf, n)
				if !ok {
					continue
				}

				currentRoom := h.GetVoiceRoom(channelID)
				if currentRoom == nil {
					return
				}
				currentRoom.UpdateSpeakerLevel(c.userID, level)
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
