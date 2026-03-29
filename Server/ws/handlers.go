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

	// Request-scoped logger with correlation context.
	reqLog := slog.With(
		"user_id", c.userID,
		"msg_type", env.Type,
		"req_id", env.ID,
	)

	reqLog.Debug("ws ← client message")

	if !h.registry.Dispatch(c.ctx, env.Type, h, c, env.ID, env.Payload) {
		reqLog.Warn("ws handleMessage unknown type")
		c.sendMsg(buildErrorMsg(ErrCodeUnknownType, fmt.Sprintf("unknown message type: %s", env.Type)))
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
	h.mu.RLock()
	defer h.mu.RUnlock()
	for uid, c := range h.clients {
		if uid == excludeUserID {
			continue
		}
		if channelID != 0 && c.getChannelID() != channelID {
			continue
		}
		c.sendMsg(msg)
	}
}

// broadcastToDMParticipants sends a message to all participants of a DM channel
// using SendToUser for each participant. This bypasses the channel-subscription
// model used by BroadcastToChannel, which is correct for DMs since users may
// not be "focused" on the DM channel.
func (h *Hub) broadcastToDMParticipants(channelID int64, msg []byte) {
	participantIDs, err := h.db.GetDMParticipantIDs(channelID)
	if err != nil {
		slog.Error("broadcastToDMParticipants GetDMParticipantIDs", "err", err, "channel_id", channelID)
		return
	}
	for _, pid := range participantIDs {
		h.SendToUser(pid, msg)
	}
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
