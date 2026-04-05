package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/microcosm-cc/bluemonday"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// Rate limit windows.
const (
	chatRateLimit     = 10
	chatWindow        = time.Second
	typingRateLimit   = 1
	typingWindow      = 3 * time.Second
	presenceRateLimit = 1
	presenceWindow    = 10 * time.Second
	reactionRateLimit = 5
	reactionWindow    = time.Second
)

// maxMessageLen is the maximum allowed message length in runes (Unicode code points).
const maxMessageLen = 4000

var sanitizer = bluemonday.StrictPolicy()

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
		result, dbErr := h.db.GetSessionWithBanStatus(c.tokenHash)
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

	// ── V2 dispatch (strangler fig) ──────────────────────────────────────
	// Only attempt V2 parsing+dispatch if a V2 handler is registered for
	// this type. This prevents the stricter V2 parser from rejecting
	// payloads that V1 handlers handle leniently.
	if h.registry.hasV2(env.Type) {
		if ctor, ok := getCommandConstructor(env.Type); ok {
			cmd, parseErr := ctor(c.userID, env.ID, env.Payload)
			if parseErr != nil {
				reqLog.Warn("ws command parse error", "err", parseErr)
				c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid payload"))
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
				reqLog.Error("ws V2 handler registered but DispatchV2 returned false", "type", env.Type)
				c.sendMsg(buildErrorMsg(ErrCodeInternal, "internal error"))
				return
			}
			if result.Error != nil {
				if ce, ok := result.Error.(ClientError); ok {
					c.sendMsg(buildErrorMsg(ce.Code, ce.Message))
				} else {
					reqLog.Error("ws handler internal error", "err", result.Error)
					c.sendMsg(buildErrorMsg(ErrCodeInternal, "internal error"))
				}
				return
			}
			// Apply client state mutations.
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
				c.setE2EEPubKey(*result.SetE2EEPubKey)
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
				h.EmitEvents(result.Events)
			}
			return
		}
	}
	// ── End V2 dispatch ──────────────────────────────────────────────────

	if !h.registry.Dispatch(c.ctx, env.Type, h, c, env.ID, env.Payload) {
		reqLog.Warn("ws handleMessage unknown type")
		c.sendMsg(buildErrorMsg(ErrCodeUnknownType, fmt.Sprintf("unknown message type: %s", msgType)))
	}
}

// hasChannelPerm reports whether the client's role has all the given permission bits.
// Delegates to the unified permissions.Checker.
func (h *Hub) hasChannelPerm(c *Client, channelID int64, perm int64) bool {
	if c.user == nil {
		return false
	}
	role, err := h.db.GetRoleByID(c.user.RoleID)
	if err != nil || role == nil {
		return false
	}
	return h.permChecker.HasChannelPerm(role.Permissions, role.ID, channelID, perm)
}

// requireChannelPerm checks whether the client has the given permission on the
// channel. If not, it sends a FORBIDDEN error to the client and returns false.
// The permLabel should be the human-readable permission name (e.g. "SEND_MESSAGES").
func (h *Hub) requireChannelPerm(c *Client, channelID int64, perm int64, permLabel string) bool {
	if h.hasChannelPerm(c, channelID, perm) {
		return true
	}
	slog.Warn("ws permission denied", "user_id", c.userID, "channel_id", channelID, "perm", permLabel)
	c.sendMsg(buildErrorMsg(ErrCodeForbidden, "missing "+permLabel+" permission"))
	return false
}

// broadcastExclude sends a message to all clients in the sender's channel
// EXCEPT the sender. Unlike hub.BroadcastToChannel, messages sent via this
// function are NOT stored in the replay ring buffer — they are ephemeral.
// This is correct for typing indicators but would be incorrect for messages
// that should survive reconnection replay.
func (h *Hub) broadcastExclude(channelID, excludeUserID int64, msg []byte) {
	if channelID == 0 {
		// Global broadcast excluding one user — use the global topic.
		h.pubsub.Publish(TopicGlobal, msg, excludeUserID)
		return
	}
	// Channel-scoped broadcast excluding one user.
	h.pubsub.Publish(ChannelTopic(channelID), msg, excludeUserID)
}

// broadcastToDMParticipants sends a message to all participants of a DM channel
// while preserving DM semantics (delivery is by participant, not channel focus).
// Unlike broadcastToDMParticipantsExclude, this path is sequenced and replayable.
func (h *Hub) broadcastToDMParticipants(channelID int64, msg []byte) {
	participantIDs, err := h.db.GetDMParticipantIDs(channelID)
	if err != nil {
		slog.Error("broadcastToDMParticipants GetDMParticipantIDs", "err", err, "channel_id", channelID)
		return
	}
	h.sendSequencedToUsers(channelID, participantIDs, msg)
}

// broadcastToDMParticipantsExclude sends a message to all participants of a DM
// channel EXCEPT the specified user. Used for ephemeral events like typing
// indicators where echoing back to the sender is undesirable.
func (h *Hub) broadcastToDMParticipantsExclude(channelID, excludeUserID int64, msg []byte) {
	participantIDs, err := h.db.GetDMParticipantIDs(channelID)
	if err != nil {
		slog.Error("broadcastToDMParticipantsExclude GetDMParticipantIDs", "err", err, "channel_id", channelID)
		return
	}
	for _, pid := range participantIDs {
		if pid == excludeUserID {
			continue
		}
		h.SendToUser(pid, msg)
	}
}
