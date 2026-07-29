package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// HandleMessageForTest dispatches a raw WebSocket message from client c.
// Exported so ws_test package can invoke it directly without a real connection.
func (h *Hub) HandleMessageForTest(c *Client, raw []byte) {
	h.handleMessage(c, raw)
}

// HandleVoiceLeaveForTest calls handleVoiceLeave directly, simulating a
// disconnect-triggered cleanup without an explicit voice_leave message.
// Exported for ws_test package use only.
func (h *Hub) HandleVoiceLeaveForTest(c *Client) {
	h.handleVoiceLeave(context.Background(), c)
}

// handleMessage parses the envelope and dispatches to the appropriate handler.
func (h *Hub) handleMessage(c *Client, raw []byte) {
	// Periodic session expiry check: every SessionCheckInterval messages,
	// re-validate the session token. This catches sessions that are revoked or
	// expire while the WebSocket connection is still open.
	c.mu.Lock()
	c.msgCount++
	shouldCheck := c.msgCount >= SessionCheckInterval
	if shouldCheck {
		c.msgCount = 0
	}
	c.mu.Unlock()

	if shouldCheck && c.tokenHash != "" {
		result, dbErr := h.db.GetSessionWithBanStatus(c.ctx, c.tokenHash)
		if dbErr != nil || result == nil || auth.IsSessionExpired(result.ExpiresAt) {
			slog.Info("ws session expired, closing connection", "user_id", c.userID)
			h.kickClient(c)
			return
		}
		tempUser := &db.User{Banned: result.Banned, BanExpires: result.BanExpires}
		if auth.IsEffectivelyBanned(tempUser) {
			slog.Info("ws user banned, closing connection", "user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
			h.kickClient(c)
			return
		}
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		c.mu.Lock()
		c.invalidCount++
		count := c.invalidCount
		c.mu.Unlock()

		slog.Warn("ws handleMessage invalid JSON", "user_id", c.userID, "err", err, "invalid_count", count)
		c.sendMsg(buildErrorMsg(ErrCodeInvalidJSON, "message must be valid JSON"))

		if count >= 10 {
			slog.Warn("ws too many invalid messages, closing connection", "user_id", c.userID, "invalid_count", count)
			h.kickClient(c)
		}
		return
	}

	// Valid parse — reset consecutive invalid counter.
	c.mu.Lock()
	c.invalidCount = 0
	c.mu.Unlock()

	// Cap client-controlled fields before logging to prevent log injection
	// and unbounded log entries.
	msgType := env.Type
	if len(msgType) > 64 {
		msgType = msgType[:64]
	}
	reqID := env.ID
	if len(reqID) > 64 {
		reqID = reqID[:64]
	}

	// Request-scoped logger with correlation context.
	reqLog := slog.With(
		"user_id", c.userID,
		"msg_type", msgType,
		"req_id", reqID,
	)

	reqLog.Debug("ws ← client message")

	// ── Typed command dispatch ───────────────────────────────────────────
	// Every message type parses through its constructor into a typed Command,
	// then dispatches to its V2 handler, which returns a Result the applier
	// below acts on. There is no second (V1) generation — the strangler-fig
	// migration is complete.
	ctor, ok := getCommandConstructor(env.Type)
	if !ok {
		reqLog.Warn("ws handleMessage unknown type")
		c.sendMsg(buildErrorMsg(ErrCodeUnknownType, fmt.Sprintf("unknown message type: %s", msgType)))
		return
	}

	cmd, parseErr := ctor(c.userID, env.ID, env.Payload)
	if parseErr != nil {
		reqLog.Warn("ws command parse error", "err", parseErr)
		c.sendMsg(buildErrorMsgWithID(ErrCodeBadRequest, "invalid payload", env.ID))
		return
	}

	var username string
	var avatar *string
	if c.user != nil {
		username = c.user.Username
		avatar = c.user.Avatar
	}
	voiceChID, voiceJoinTok := c.getVoiceState()
	info := ClientInfo{
		UserID:         c.userID,
		Username:       username,
		Avatar:         avatar,
		RoleName:       c.roleName,
		ReqID:          env.ID,
		VoiceChannelID: voiceChID,
		VoiceJoinToken: voiceJoinTok,
	}

	result, dispatched := h.registry.DispatchV2(c.ctx, cmd, info)
	if !dispatched {
		// A registered constructor with no V2 handler is a wiring bug — the
		// guard test (TestEveryConstructorHasV2Handler) locks this shut.
		reqLog.Error("ws no V2 handler for constructed command", "type", env.Type)
		c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "internal error", env.ID))
		return
	}
	if result.Error != nil {
		if ce, ok := result.Error.(ClientError); ok {
			c.sendMsg(buildErrorMsgWithID(ce.Code, ce.Message, env.ID))
		} else {
			reqLog.Error("ws handler internal error", "err", result.Error)
			c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "internal error", env.ID))
		}
		// A rejection may still need to evict: voice_token_refresh returns
		// LeaveVoice alongside its error when CONNECT_VOICE was revoked, so the
		// user is removed from the SFU rather than merely denied a new token.
		if result.LeaveVoice {
			h.handleVoiceLeave(c.ctx, c)
		}
		return
	}

	// Apply client state mutations and side effects.
	if result.SetChannelID != nil {
		oldChID := c.getChannelID()
		c.mu.Lock()
		c.channelID = *result.SetChannelID
		c.mu.Unlock()
		// Update pub/sub channel topic subscriptions.
		newChID := *result.SetChannelID
		if oldChID != newChID {
			if oldChID > 0 {
				c.hub.pubsub.Unsubscribe(c, ChannelTopic(oldChID))
			}
			if newChID > 0 {
				c.hub.pubsub.Subscribe(c, ChannelTopic(newChID))
			}
		}
	}
	if result.SetE2EEPubKey != nil {
		sig := ""
		if result.SetE2EESignature != nil {
			sig = *result.SetE2EESignature
		}
		c.setE2EEPubKey(*result.SetE2EEPubKey, sig)
	}
	if result.SetVoiceJoinToken != nil {
		chID := c.getVoiceChID()
		if chID != 0 {
			c.setVoiceState(chID, *result.SetVoiceJoinToken)
		}
	}
	if result.Reply != nil {
		c.sendMsg(result.Reply)
	}
	if len(result.Events) > 0 {
		h.EmitEvents(c.ctx, result.Events)
	}
	// Voice join/leave hand off to the hub-internal routines (also called
	// un-throttled on disconnect/switch). handleVoiceJoin re-reads channel_id
	// from the already-validated envelope payload.
	if result.LeaveVoice {
		h.handleVoiceLeave(c.ctx, c)
	}
	if result.JoinVoice {
		h.handleVoiceJoin(c.ctx, c, env.Payload)
	}
}

// hasChannelPerm reports whether the client's role has all the given permission bits.
// Delegates to the unified permissions.Checker.
//
// F5: resolve the user's CURRENT role via GetRoleForUser(c.userID) rather than the
// role snapshotted onto c.user at connect time. A mid-session role reassignment
// (e.g. stripping CONNECT_VOICE) must take effect immediately for the live
// connection — including the SPEAK/VIDEO grants baked into a freshly minted
// LiveKit token — instead of persisting until the user reconnects. This mirrors
// the V2 handlers, which already resolve the live role (deps.go).
func (h *Hub) hasChannelPerm(ctx context.Context, c *Client, channelID int64, perm int64) bool {
	role, err := h.db.GetRoleForUser(ctx, c.userID)
	if err != nil || role == nil {
		return false
	}
	return h.permChecker.HasChannelPerm(ctx, role.Permissions, role.ID, channelID, perm)
}

// requireChannelPerm checks whether the client has the given permission on the
// channel. If not, it sends a FORBIDDEN error to the client and returns false.
// The permLabel should be the human-readable permission name (e.g. "SEND_MESSAGES").
func (h *Hub) requireChannelPerm(ctx context.Context, c *Client, channelID int64, perm int64, permLabel string) bool {
	if h.hasChannelPerm(ctx, c, channelID, perm) {
		return true
	}
	slog.Warn("ws permission denied", "user_id", c.userID, "channel_id", channelID, "perm", permLabel)
	c.sendMsg(buildErrorMsg(ErrCodeForbidden, "missing "+permLabel+" permission"))
	return false
}

// broadcastExcludeLow sends a message at low priority to all clients in the
// sender's channel EXCEPT the sender. Messages sent via this function are NOT
// stored in the replay ring buffer — they are ephemeral. This is correct for
// typing indicators (dropped on overflow instead of disconnecting) but would
// be incorrect for messages that should survive reconnection replay.
func (h *Hub) broadcastExcludeLow(channelID, excludeUserID int64, msg []byte) {
	if channelID == 0 {
		h.pubsub.PublishLow(TopicGlobal, msg, excludeUserID)
		return
	}
	h.pubsub.PublishLow(ChannelTopic(channelID), msg, excludeUserID)
}
