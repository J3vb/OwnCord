package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
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
	// kickClient (hub_sweep.go and the ban/expiry paths below) removes c from
	// the hub and closes its send channels, but never touches the underlying
	// connection or signals readPump — readPump keeps calling handleMessage
	// for every frame it reads until the write side eventually times out and
	// closes the conn (OC-0285). isSendClosed is the same "this client has
	// been cut off" flag Subscribe already treats as canonical (pubsub.go)
	// and that closeSend sets synchronously before kickClient returns, so
	// checking it here — before the session recheck even runs — drops every
	// frame a kicked/banned/expired client's connection still has buffered,
	// regardless of which goroutine did the kicking.
	if c.isSendClosed() {
		return
	}
	if h.handleMessageSessionRecheck(c) {
		return
	}

	env, msgType, reqID, ok := h.handleMessageDecode(c, raw)
	if !ok {
		return
	}

	// ── Typed command dispatch ───────────────────────────────────────────
	// Every message type parses through its constructor into a typed Command,
	// then dispatches to its V2 handler, which returns a Result the applier
	// below acts on. There is no second (V1) generation — the strangler-fig
	// migration is complete.
	ctor, ok := getCommandConstructor(env.Type)
	if !ok {
		slog.Warn("ws handleMessage unknown type", "user_id", c.userID, "msg_type", msgType, "req_id", reqID)
		c.sendMsg(buildErrorMsg(ErrCodeUnknownType, fmt.Sprintf("unknown message type: %s", msgType)))
		return
	}

	cmd, parseErr := ctor(c.userID, env.ID, env.Payload)
	if parseErr != nil {
		slog.Warn("ws command parse error", "user_id", c.userID, "msg_type", msgType, "req_id", reqID, "err", parseErr)
		c.sendMsg(buildErrorMsgWithID(ErrCodeBadRequest, "invalid payload", env.ID))
		return
	}

	var username string
	var avatar, displayName *string
	if c.user != nil {
		username = c.user.Username
		avatar = c.user.Avatar
		displayName = c.user.DisplayName
	}
	voiceChID, voiceJoinTok := c.getVoiceState()
	info := ClientInfo{
		UserID:         c.userID,
		Username:       username,
		Avatar:         avatar,
		DisplayName:    displayName,
		RoleName:       c.roleName,
		ReqID:          env.ID,
		VoiceChannelID: voiceChID,
		VoiceJoinToken: voiceJoinTok,
	}

	result, dispatched := h.registry.DispatchV2(c.ctx, cmd, info)
	if !dispatched {
		// A registered constructor with no V2 handler is a wiring bug — the
		// guard test (TestEveryConstructorHasV2Handler) locks this shut.
		slog.Error("ws no V2 handler for constructed command",
			"user_id", c.userID, "msg_type", msgType, "req_id", reqID, "type", env.Type)
		c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "internal error", env.ID))
		return
	}
	if result.Error != nil {
		if ce, ok := result.Error.(ClientError); ok {
			c.sendMsg(buildErrorMsgWithID(ce.Code, ce.Message, env.ID))
		} else {
			slog.Error("ws handler internal error",
				"user_id", c.userID, "msg_type", msgType, "req_id", reqID, "err", result.Error)
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

	h.handleMessageApply(c, env, result)
}

// handleMessageSessionRecheck performs handleMessage's periodic session
// revalidation. It reports whether the connection was closed, in which case
// the caller must stop processing the frame.
func (h *Hub) handleMessageSessionRecheck(c *Client) bool {
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
		if dbErr != nil {
			// A failed read says nothing about this session's validity —
			// kicking the client on a transient DB error (SQLITE_BUSY, an
			// I/O error, a maintenance window) would be a false positive.
			// Skip this recheck; the next one retries, and
			// sweepRevokedSessions remains the time-based backstop for
			// idle connections. Matches sweepRevokedSessions's identical
			// rule for a failed batch lookup (hub_sweep.go).
			slog.Warn("ws session recheck: lookup failed, skipping", "user_id", c.userID, "err", dbErr)
			return false
		}
		if result == nil || auth.IsSessionExpired(result.ExpiresAt) {
			slog.Info("ws session expired, closing connection", "user_id", c.userID)
			h.kickClient(c)
			return true
		}
		tempUser := &db.User{Banned: result.Banned, BanExpires: result.BanExpires}
		if auth.IsEffectivelyBanned(tempUser) {
			slog.Info("ws user banned, closing connection", "user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
			h.kickClient(c)
			return true
		}
	}
	return false
}

// handleMessageDecode parses handleMessage's inbound frame into an envelope,
// maintaining the consecutive-invalid-JSON counter, and returns the capped
// msg_type / req_id used for logging. It reports false when the frame was
// rejected and the caller must stop.
func (h *Hub) handleMessageDecode(c *Client, raw []byte) (envelope, string, string, bool) {
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
		return env, "", "", false
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

	// Correlation attrs (user_id/msg_type/req_id) are inlined at each log site
	// below rather than bound via slog.With — the With clone allocated a new
	// handler chain per message even when nothing ended up being logged.
	slog.Debug("ws ← client message", "user_id", c.userID, "msg_type", msgType, "req_id", reqID)

	return env, msgType, reqID, true
}

// handleMessageApply applies the client state mutations and side effects that a
// successful V2 Result asks for.
func (h *Hub) handleMessageApply(c *Client, env envelope, result Result) {
	// Apply client state mutations and side effects.
	if result.SetChannelID != nil {
		h.applySetChannelID(c, *result.SetChannelID)
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

// applySetChannelID moves c's focused channel to newChID and updates its
// pub/sub topic subscription to match.
//
// OC-0024: channel_focus's handler (service/channel.go) checks READ_MESSAGES
// before returning, but that check and the Subscribe below are separated by
// two SQLite round trips (GetLatestMessageID/UpdateReadState), and the hub's
// visibility-revoke sweeps (RefreshChannelVisibility, revokeUnreadableChannels)
// only ever Unsubscribe a topic the socket already holds at the instant they
// run — a revoke that commits inside that window finds nothing to undo, and
// the Subscribe that lands once the window closes is never revisited. Once
// Subscribe is called we re-validate READ_MESSAGES live and unwind it on
// failure, which closes the race from both directions: a revoke that already
// committed is caught right here, and a revoke that commits afterward still
// finds the subscription the sweeps have always expected to see.
func (h *Hub) applySetChannelID(c *Client, newChID int64) {
	oldChID := c.getChannelID()
	c.mu.Lock()
	c.channelID = newChID
	c.mu.Unlock()
	if oldChID == newChID {
		return
	}
	if oldChID > 0 {
		h.pubsub.Unsubscribe(c, ChannelTopic(oldChID))
	}
	if newChID <= 0 {
		return
	}
	h.pubsub.Subscribe(c, ChannelTopic(newChID))
	// The re-validation is permissions.CanAdmitSession — the same predicate
	// as HandleChannelFocus's admission gate (S-12): DMs are participant-gated
	// (the READ role bit is deliberately waived), non-DMs need READ_MESSAGES
	// and no archive, and a deleted channel is a denial. A transient lookup
	// error is NOT a denial (OC-0266) — the recheck exists to catch a concrete
	// revoke in the Subscribe race window, the sweeps stay authoritative, and
	// unwinding on error would turn any DB hiccup into a silently dead
	// message stream with no error frame sent to the client; subjectFor and
	// the DM lookup both report a failure instead of collapsing it.
	ch, chErr := h.db.GetChannel(c.ctx, newChID)
	if chErr != nil {
		return
	}
	if ch != nil {
		sub, subErr := h.subjectFor(c.ctx, c.userID, newChID)
		if subErr != nil {
			return
		}
		sub.Channel = channelRef(ch)
		if ch.Type == "dm" {
			ok, dmErr := h.db.IsDMParticipant(c.ctx, c.userID, newChID)
			if dmErr != nil {
				return
			}
			sub.DMParticipant = ok
		}
		if permissions.CanAdmitSession(sub) == nil {
			return
		}
	}
	h.pubsub.Unsubscribe(c, ChannelTopic(newChID))
	c.mu.Lock()
	if c.channelID == newChID {
		c.channelID = 0
	}
	c.mu.Unlock()
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
//
// Deliberately NOT routed through the cached PermissionService: the only
// production caller is sweepStaleVoiceStates, the last-line revocation backstop
// that evicts live voice participants. Reading the DB live keeps that backstop
// authoritative even for a permission change that somehow bypassed the
// invalidation hooks, and the sweep runs once a minute for only the clients
// currently in voice, so the uncached cost is negligible.
func (h *Hub) hasChannelPerm(ctx context.Context, c *Client, channelID int64, perm int64) bool {
	role, err := h.db.GetRoleForUser(ctx, c.userID)
	if err != nil || role == nil {
		return false
	}
	return h.permChecker.HasChannelPerm(ctx, role.Permissions, role.ID, c.userID, channelID, perm)
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
