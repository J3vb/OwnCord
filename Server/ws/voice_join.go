package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// Voice join/leave rate limits. voice_join and voice_leave each fan out a
// broadcast to every connected client, so a single user must not be able to
// trigger them in a tight loop. Mirrors the named-constant idiom used by the
// voice control handlers (see voice_broadcast.go / voice_controls.go).
// voiceLeaveRateLimit/Window are consumed by the voice_leave message dispatch
// in handlers_voice.go (same package).
const (
	voiceJoinRateLimit  = 5
	voiceJoinWindow     = time.Second
	voiceLeaveRateLimit = 5
	voiceLeaveWindow    = time.Second
)

// validVoiceQuality returns true if q is an accepted voice quality preset.
// Uses voiceQualities (defined in voice_broadcast.go) as the single source of truth.
func validVoiceQuality(q string) bool {
	_, ok := voiceQualities[q]
	return ok
}

// handleVoiceJoin processes a voice_join message.
// 1. Parses channel_id.
// 2. Checks CONNECT_VOICE permission.
// 3. If already in a different voice channel, leaves it first.
// 4. Checks channel capacity (voice_max_users).
// 5. Persists join in DB.
// 6. Generates LiveKit token and sends voice_token to the client.
// 7. Sends existing voice states to the joiner.
// 8. Broadcasts voice_state to all clients.
// 9. Sends voice_config to the joiner.
func (h *Hub) handleVoiceJoin(ctx context.Context, c *Client, payload json.RawMessage) {
	// Rate limit: voice_join broadcasts a voice_state update to every connected
	// client, so cap how often a single user can trigger the fan-out. Mirrors the
	// Limiter.Allow(...) idiom used by the voice control handlers.
	ratKey := fmt.Sprintf("voice_join:%d", c.userID)
	if h.limiter != nil && !h.limiter.Allow(ratKey, voiceJoinRateLimit, voiceJoinWindow) {
		c.sendMsg(buildErrorMsg(ErrCodeRateLimited, "too many voice join attempts"))
		return
	}

	channelID, err := parseChannelID(payload)
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "channel_id must be a positive integer"))
		return
	}

	if !h.requireChannelPerm(ctx, c, channelID, permissions.ConnectVoice, "CONNECT_VOICE") {
		return
	}

	// Validate the target channel exists before any state changes (leaving
	// the current voice channel, persisting join, etc.).
	ch, err := h.db.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		c.sendMsg(buildErrorMsg(ErrCodeNotFound, "channel not found"))
		return
	}

	// Ensure authenticated user is present before any state changes.
	// This guard covers all downstream paths (LiveKit configured or not)
	// that dereference c.user (e.g. c.user.Username in the success log).
	if c.user == nil {
		slog.Error("handleVoiceJoin: nil user on client", "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "not authenticated"))
		return
	}

	// Hard-fail when LiveKit is not configured — without an SFU the client
	// cannot connect to voice, so persisting state would create a ghost.
	if h.livekit == nil {
		c.sendMsg(buildErrorMsg(ErrCodeVoiceError, "voice is not configured on this server"))
		return
	}

	// Guard: reject voice join if the companion LiveKit process is not running
	// (e.g. crashed 10 times and gave up).
	if h.lkProcess != nil && !h.lkProcess.IsRunning() {
		slog.Warn("handleVoiceJoin: LiveKit process not running", "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeVoiceError, "voice is temporarily unavailable — LiveKit is not running"))
		return
	}

	currentChID := c.getVoiceChID()

	// If user is already in the same voice channel, no-op.
	if currentChID == channelID {
		c.sendMsg(buildErrorMsg(ErrCodeAlreadyJoined, "already in this voice channel"))
		return
	}

	// If user is already in a different voice channel, leave it first.
	if currentChID > 0 {
		h.handleVoiceLeave(ctx, c)

		// BUG-088: Verify old voice state is actually cleared before joining
		// the new channel. If the DB delete failed (retry still running in
		// background), the old row persists and JoinVoiceChannelIfCapacity's
		// COUNT(*) may produce an incorrect result. Fail the switch so the
		// user can retry cleanly.
		vs, err := h.db.GetVoiceState(ctx, c.userID)
		if err != nil {
			slog.Warn("handleVoiceJoin: could not verify voice state cleared",
				"user_id", c.userID, "err", err)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice channel switch failed — please try again"))
			return
		}
		if vs != nil {
			slog.Warn("handleVoiceJoin: stale voice state persists after leave, aborting switch",
				"user_id", c.userID, "stale_channel", vs.ChannelID, "target_channel", channelID)
			// Restore client voice state so the user knows they're still in the old channel.
			c.setVoiceState(vs.ChannelID, vs.JoinedAt)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice channel switch failed — please try again"))
			return
		}
	}

	// Check channel capacity and persist to DB atomically.
	maxUsers := ch.VoiceMaxUsers
	if maxUsers > 0 {
		if err := h.db.JoinVoiceChannelIfCapacity(ctx, c.userID, channelID, maxUsers); err != nil {
			if errors.Is(err, db.ErrChannelFull) {
				c.sendMsg(buildErrorMsg(ErrCodeChannelFull, "voice channel is full"))
				return
			}
			slog.Error("ws handleVoiceJoin JoinVoiceChannelIfCapacity", "err", err, "user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to join voice channel"))
			return
		}
	} else {
		// No capacity limit — use standard join.
		if err := h.db.JoinVoiceChannel(ctx, c.userID, channelID); err != nil {
			slog.Error("ws handleVoiceJoin JoinVoiceChannel", "err", err, "user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to join voice channel"))
			return
		}
	}

	// Load the persisted row immediately so later cleanup can target this exact
	// join instance even if the user rejoins the same channel.
	state, err := h.db.GetVoiceState(ctx, c.userID)
	if err != nil || state == nil {
		slog.Error("ws handleVoiceJoin GetVoiceState", "err", err, "user_id", c.userID)
		h.rollbackVoiceJoin(ctx, c, channelID, false)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to join voice channel"))
		return
	}

	// Generate LiveKit token if LiveKit client is available.
	// Token generation failure is fatal — without a token the client cannot
	// connect to the SFU, so we must roll back the DB join.
	// NOTE: setVoiceState is deferred until after token send succeeds, so
	// rollback does not broadcast a spurious voice_leave for an unannounced join.
	if h.livekit != nil {
		// Derive publish permissions from role — prevents SFU-level bypass
		// when client connects directly via direct_url (BUG-128).
		canPublish := h.hasChannelPerm(ctx, c, channelID, permissions.SpeakVoice)
		canSubscribe := true
		canVideo := h.hasChannelPerm(ctx, c, channelID, permissions.UseVideo)
		canScreenShare := h.hasChannelPerm(ctx, c, channelID, permissions.ShareScreen)
		token, tokenErr := h.livekit.GenerateToken(c.userID, c.user.Username, channelID, state.JoinedAt, canPublish, canSubscribe, canVideo, canScreenShare)
		if tokenErr != nil {
			slog.Error("ws handleVoiceJoin GenerateToken", "err", tokenErr, "user_id", c.userID)
			h.rollbackVoiceJoin(ctx, c, channelID, false)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to generate voice token"))
			return
		}
		// Send both proxy path and direct URL. The client uses direct_url
		// when on localhost (avoids self-signed TLS issues with WebView
		// fetch) and falls back to the /livekit proxy for remote clients.
		// NOTE: E2EE keys are no longer server-generated. Clients exchange
		// keys via ECDH (voice_e2ee_announce / voice_e2ee_offer messages).
		// C-2: Include is_key_holder so the client knows whether to initiate
		// key distribution after connecting to the SFU.
		isKeyHolder := h.computeIsKeyHolder(channelID, c.userID)
		c.sendMsg(buildVoiceToken(channelID, token, "/livekit", h.livekit.URL(), isKeyHolder))
	}

	// Set voice channel on the client AFTER token is sent successfully.
	c.setVoiceState(channelID, state.JoinedAt)

	// Subscribe to voice topic for voice-scoped events.
	h.pubsub.Subscribe(c, VoiceTopic(channelID))

	// Update key holder map now that this client's voice state is set.
	h.updateKeyHolder(channelID)

	// Broadcast the joiner's state to all connected clients.
	h.BroadcastToAll(buildVoiceState(*state))

	// Send existing channel voice states to the joiner.
	existing, err := h.db.GetChannelVoiceStates(ctx, channelID)
	if err != nil {
		slog.Error("ws handleVoiceJoin GetChannelVoiceStates", "err", err)
		return
	}
	for _, vs := range existing {
		if vs.UserID == c.userID {
			continue
		}
		c.sendMsg(buildVoiceState(vs))
		// Send existing participant's ECDH public key (and its identity
		// signature, F3 TOFU) so the joiner can participate in the
		// client-side E2EE key exchange.
		if pubKey, sig := h.getClientE2EEPubKey(vs.UserID); pubKey != "" {
			c.sendMsg(buildVoiceE2EEAnnounce(vs.UserID, pubKey, sig))
		}
	}

	// Send voice_config to the joiner.
	quality := "medium"
	if ch.VoiceQuality != nil && *ch.VoiceQuality != "" {
		q := *ch.VoiceQuality
		if validVoiceQuality(q) {
			quality = q
		} else {
			slog.Warn("ws handleVoiceJoin invalid voice quality, using default",
				"quality", q, "channel_id", channelID)
		}
	}
	bitrate := qualityBitrate(quality)
	c.sendMsg(buildVoiceConfig(channelID, quality, bitrate, maxUsers))

	lkURL := ""
	if h.livekit != nil {
		lkURL = h.livekit.URL()
	}
	slog.Info("voice join",
		"user_id", c.userID,
		"username", c.user.Username,
		"channel_id", channelID,
		"remote", c.remoteAddr,
		"livekit_url", lkURL,
		"quality", quality,
		"channel_users", len(existing),
		"channel_max", maxUsers,
	)
}

// handleVoiceTokenRefreshV2 is the V2 (pure) handler for voice_token_refresh.
// It generates a fresh LiveKit token for a client already in a voice channel.
func handleVoiceTokenRefreshV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	userID := info.UserID
	channelID := info.VoiceChannelID

	ratKey := fmt.Sprintf("voice_token_refresh:%d", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, 1, 60*time.Second) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "token refresh rate limited"}}
	}

	if channelID == 0 {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "not in voice"}}
	}

	if d.TokenGen == nil {
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "voice not configured"}}
	}

	canPublish := hasPerm(ctx, d.DB, d.Permissions, userID, channelID, permissions.SpeakVoice)
	canSubscribe := true
	canVideo := hasPerm(ctx, d.DB, d.Permissions, userID, channelID, permissions.UseVideo)
	canScreenShare := hasPerm(ctx, d.DB, d.Permissions, userID, channelID, permissions.ShareScreen)

	joinToken := info.VoiceJoinToken
	var result Result
	if joinToken == "" {
		state, stateErr := d.DB.GetVoiceState(ctx, userID)
		if stateErr != nil || state == nil {
			slog.Error("ws handleVoiceTokenRefreshV2 GetVoiceState", "err", stateErr, "user_id", userID)
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to refresh voice token"}}
		}
		joinToken = state.JoinedAt
		result.SetVoiceJoinToken = &joinToken
	}

	token, err := d.TokenGen.GenerateToken(userID, info.Username, channelID, joinToken, canPublish, canSubscribe, canVideo, canScreenShare)
	if err != nil {
		slog.Error("ws handleVoiceTokenRefreshV2 GenerateToken", "err", err, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to generate voice token"}}
	}

	isKeyHolder := false
	if d.KeyHolder != nil {
		isKeyHolder = d.KeyHolder.IsVoiceKeyHolder(channelID, userID)
	}

	result.Reply = buildVoiceToken(channelID, token, "/livekit", d.TokenGen.URL(), isKeyHolder)
	slog.Info("voice token refreshed (v2)", "user_id", userID, "channel_id", channelID)
	return result
}

// rollbackVoiceJoin undoes a partially-completed voice join: clears the
// client's voice channel ID, removes the DB voice state row, and broadcasts
// voice_leave so other clients don't see a ghost participant.
func (h *Hub) rollbackVoiceJoin(ctx context.Context, c *Client, channelID int64, broadcast bool) {
	c.clearVoiceChID()
	// The compensating delete must run even when the join failed BECAUSE the
	// connection died — that cancellation is the most common rollback trigger.
	if err := h.db.LeaveVoiceChannel(context.WithoutCancel(ctx), c.userID); err != nil {
		slog.Error("ws rollbackVoiceJoin LeaveVoiceChannel", "err", err,
			"user_id", c.userID, "channel_id", channelID)
	}
	if broadcast {
		h.BroadcastToAll(buildVoiceLeave(channelID, c.userID))
	}
}
