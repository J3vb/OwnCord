package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// HandleMessageForTest dispatches a raw message from client c; exported for ws_test.
func (h *Hub) HandleMessageForTest(c *Client, raw []byte) {
	h.handleMessage(c, raw)
}

// HandleVoiceLeaveForTest calls handleVoiceLeave directly, simulating a
// disconnect cleanup; exported for ws_test.
func (h *Hub) HandleVoiceLeaveForTest(c *Client) {
	txn := h.begin(c.userID)
	defer txn.end()
	h.handleVoiceLeave(context.Background(), txn, c, voiceLeaveReasonDisconnect)
}

func (h *Hub) handleMessage(c *Client, raw []byte) {
	receivedAt := time.Now()
	// kickClient removes c and closes its send channels but never touches the
	// connection or signals readPump, which keeps calling handleMessage for every
	// buffered frame until the write side times out. isSendClosed is the same
	// cut-off flag Subscribe treats as canonical (closeSend sets it synchronously
	// before kickClient returns), so checking it first, even before the session recheck,
	// drops every frame a kicked/banned/expired client still has buffered, whichever
	// goroutine did the kicking.
	if c.isSendClosed() {
		return
	}
	// fctx is this frame's database deadline, derived from the connection context so a
	// disconnect still cancels it. Exempt types (command_deadline.go) dispatch on
	// c.ctx. handleMessageApply uses it only for the voice join's pre-commit work; its
	// events and the rest of the join keep the connection context.
	fctx, cancel := context.WithTimeout(c.ctx, commandDeadline())
	defer cancel()
	if h.handleMessageSessionRecheck(fctx, c) {
		return
	}

	env, msgType, reqID, ok := h.handleMessageDecode(c, raw)
	if !ok {
		return
	}
	if env.Type == MsgTypePing {
		h.touchSession(fctx, c)
	}

	// Every message type parses through its constructor into a typed Command and
	// dispatches to its V2 handler, which returns a Result the applier acts on.
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
	voiceChID, voiceJoinTok := c.voice.state()
	info := ClientInfo{
		Activity:       h.userActivity(c),
		Listening:      h.userListening(c),
		UserID:         c.userID,
		Username:       username,
		Avatar:         avatar,
		DisplayName:    displayName,
		RoleName:       c.roleName,
		IdentityKey:    c.identityKey,
		ReqID:          env.ID,
		VoiceChannelID: voiceChID,
		VoiceJoinToken: voiceJoinTok,
	}

	dispatchCtx := fctx
	exempt := isCommandDeadlineExempt(env.Type)
	if exempt {
		dispatchCtx = c.ctx
	}
	// A frame whose deadline was spent before dispatch (a slow session recheck) is
	// refused without running its handler, which would only fail on the expired
	// context. voice_leave is the exception: it must still release the voice slot.
	if !exempt && env.Type != MsgTypeVoiceLeave && commandDeadlineExceeded(fctx, errDeadlineSpent) {
		slog.Warn("ws command deadline exceeded",
			"user_id", c.userID, "msg_type", msgType, "req_id", reqID, "stage", "before_dispatch")
		c.sendMsg(buildErrorMsgWithID(ErrCodeRequestTimeout, "the server is busy, try again", env.ID))
		return
	}
	result, dispatched := h.registry.DispatchV2(dispatchCtx, cmd, info)
	if !dispatched {
		// A registered constructor with no V2 handler is a wiring bug
		// (TestEveryConstructorHasV2Handler guards it).
		slog.Error("ws no V2 handler for constructed command",
			"user_id", c.userID, "msg_type", msgType, "req_id", reqID, "type", env.Type)
		c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "internal error", env.ID))
		return
	}
	if env.Type == MsgTypeChannelFocus && result.SetChannelID == nil && result.DeferChannelFocus == nil {
		supersedeDeferredFocus(c)
	}
	if result.Error != nil {
		h.handleMessageError(fctx, c, env, msgType, reqID, result, exempt)
		return
	}

	h.handleMessageApply(c.ctx, fctx, c, env, reqID, result, receivedAt)
}

// handleMessageError answers a failed command: REQUEST_TIMEOUT when the frame
// deadline fctx cut it short, else the handler's own error.
func (h *Hub) handleMessageError(fctx context.Context, c *Client, env envelope, msgType, reqID string, result Result, exempt bool) {
	// A client voice_leave (even one refused by its rate limit) still releases the
	// slot, so a spent deadline never turns it into a timeout that drops the leave.
	clientLeave := result.LeaveVoice && result.LeaveVoiceReason == voiceLeaveReasonClient
	if !exempt && !clientLeave && commandDeadlineExceeded(fctx, result.Error) {
		// REQUEST_TIMEOUT means "not applied": a transaction whose context ends before
		// Commit rolls back, and post-commit work is detached.
		slog.Warn("ws command deadline exceeded",
			"user_id", c.userID, "msg_type", msgType, "req_id", reqID, "err", result.Error)
		c.sendMsg(buildErrorMsgWithID(ErrCodeRequestTimeout, "the server is busy, try again", env.ID))
		// A timed-out lookup is not a refusal, so the LeaveVoice a handler attaches to a
		// failed gate read (voice_token_refresh) is not honoured: the user stays in voice
		// and retries.
		return
	}
	if ce, ok := errors.AsType[ClientError](result.Error); ok {
		if ce.ThreadID != 0 {
			c.sendMsg(buildThreadErrorMsg(ce, env.ID))
		} else {
			c.sendMsg(buildErrorMsgWithID(ce.Code, ce.Message, env.ID))
		}
	} else {
		slog.Error("ws handler internal error",
			"user_id", c.userID, "msg_type", msgType, "req_id", reqID, "err", result.Error)
		c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "internal error", env.ID))
	}
	// A rejection may still need to evict: voice_token_refresh returns LeaveVoice with
	// its error when the join gate now refuses, removing the user from the SFU.
	if result.LeaveVoice {
		h.leaveVoiceLocked(c, result.LeaveVoiceReason)
	}
}

// handleMessageSessionRecheck revalidates the session on ctx (the frame's
// deadline). It reports whether the connection was closed, in which case the caller
// must stop processing the frame.
func (h *Hub) handleMessageSessionRecheck(ctx context.Context, c *Client) bool {
	// Every SessionCheckInterval messages, re-validate the session token to catch
	// sessions revoked or expired while the socket is open.
	c.mu.Lock()
	c.msgCount++
	shouldCheck := c.msgCount >= SessionCheckInterval
	if shouldCheck {
		c.msgCount = 0
	}
	c.mu.Unlock()

	if shouldCheck && c.tokenHash != "" {
		result, dbErr := h.readers.Dispatch.GetSessionWithBanStatus(ctx, c.tokenHash)
		if dbErr != nil {
			// A failed read says nothing about this session's validity; kicking on a transient
			// DB error (SQLITE_BUSY, I/O error) would be a false positive. Skip; the next
			// recheck retries and sweepRevokedSessions is the time-based backstop for idle
			// connections (same rule as its failed batch lookup).
			slog.Warn("ws session recheck: lookup failed, skipping", "user_id", c.userID, "err", dbErr)
			return false
		}
		if result == nil || auth.IsSessionExpired(result.ExpiresAt) {
			slog.Info("ws session expired, closing connection", "user_id", c.userID)
			h.kickClientTerminal(c)
			return true
		}
		if sessionUserBanned(result.Banned, result.BanExpires) {
			slog.Info("ws user banned, closing connection", "user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
			h.kickClientTerminal(c)
			return true
		}
	}
	return false
}

// sessionUserBanned reports whether the user behind a session row is banned right
// now (a timed ban that has run out is not).
func sessionUserBanned(banned bool, banExpires *string) bool {
	return auth.IsEffectivelyBanned(&db.User{Banned: banned, BanExpires: banExpires})
}

// handleMessageDecode parses the inbound frame into an envelope, maintaining the
// consecutive-invalid-JSON counter, and returns the capped msg_type / req_id for
// logging. False means the frame was rejected and the caller must stop.
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

	c.mu.Lock()
	c.invalidCount = 0
	c.mu.Unlock()

	// Cap client-controlled fields before logging to prevent log injection and
	// unbounded entries.
	msgType := env.Type
	if len(msgType) > 64 {
		msgType = msgType[:64]
	}
	reqID := env.ID
	if len(reqID) > 64 {
		reqID = reqID[:64]
	}

	// Correlation attrs are inlined at each log site rather than bound via slog.With,
	// which allocated a handler chain per message even when nothing was logged.
	slog.Debug("ws ← client message", "user_id", c.userID, "msg_type", msgType, "req_id", reqID)

	return env, msgType, reqID, true
}

// handleMessageApply applies the state mutations and side effects a successful V2
// Result asks for. receivedAt is when handleMessage read the frame, for timing the
// send-to-ack round trip (chat_send_ok). fctx is the frame deadline: only the voice
// join's pre-commit work runs on it; ctx, the connection context, serves the rest.
func (h *Hub) handleMessageApply(ctx, fctx context.Context, c *Client, env envelope, reqID string, result Result, receivedAt time.Time) {
	if result.SetChannelID != nil {
		h.applyFocusResult(c, env.Type, *result.SetChannelID)
	}
	if result.SetThreadID != nil {
		h.applyThreadFocus(c, *result.SetThreadID)
	}
	if result.DeferChannelFocus != nil {
		h.deferChannelFocus(c, *result.DeferChannelFocus, env.ID, !result.DeferChannelFocusNoRead)
	}
	if result.SetPresence != nil {
		result.Events = h.applyPresenceChoice(c, result.SetPresence, result.Events)
	}
	if result.SetActivity != nil {
		h.applyActivity(c, result.SetActivity.next)
	}
	if result.SetListening != nil {
		h.applyListening(c, result.SetListening.next)
	}
	if result.SetE2EEAnnounce != nil {
		c.setE2EEAnnounce(*result.SetE2EEAnnounce)
	}
	if sw := result.SetVoiceWatching; sw != nil {
		// Relay only while the slot is still in the channel the handler decided against; a
		// frame that lost a channel switch reaches nobody.
		if c.voice.setWatchingIfChannel(sw.chID, sw.ids) {
			h.sendToVoiceChannelExcept(sw.chID, c.userID, buildVoiceWatching(c.userID, sw.ids))
		}
	}
	if result.SetVoiceJoinToken != nil {
		txn := h.begin(c.userID)
		txn.setJoinToken(c, *result.SetVoiceJoinToken)
		txn.end()
	}
	if result.Reply != nil {
		c.sendMsg(result.Reply)
		// chat_send_ack_ms measures the send-to-ack round trip for chat_send only; other
		// reply kinds are not what the load run compares against k6.
		if env.Type == MsgTypeChatSend {
			h.latency.chatAck.Observe(float64(time.Since(receivedAt)) / float64(time.Millisecond))
		}
	}
	if len(result.Events) > 0 {
		h.emitEventsFrom(ctx, c.userID, result.Events)
	}
	// Voice join/leave hand off to hub-internal routines (also called un-throttled on
	// disconnect/switch). handleVoiceJoin re-reads channel_id from the validated payload.
	if result.LeaveVoice {
		h.leaveVoiceLocked(c, result.LeaveVoiceReason)
	}
	if result.JoinVoice {
		h.handleVoiceJoinFrame(fctx, ctx, c, env.Payload, reqID)
	}
}

// applySetChannelID moves c's focused channel to newChID and updates its pub/sub
// subscription.
//
// channel_focus's handler (service/channel.go) checks READ_MESSAGES before returning,
// but that check and the Subscribe below are separated by two SQLite round trips,
// and the visibility-revoke sweeps (RefreshChannelVisibility,
// revokeUnreadableChannels) only Unsubscribe a topic the socket already holds when
// they run. A revoke committing inside that window finds nothing to undo and the
// later Subscribe is never revisited. So after Subscribe we re-validate
// READ_MESSAGES live and unwind on failure: a revoke already committed is caught
// here, and one committing afterward finds the subscription the sweeps expect.
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
	if h.refusesForumTopic(c, newChID) {
		h.unwindChannelFocus(c, newChID)
		return
	}
	h.pubsub.Subscribe(c, ChannelTopic(newChID))
	// The re-validation is permissions.CanAdmitSession, the predicate of
	// HandleChannelFocus's admission gate: DMs are participant-gated (the READ bit is
	// waived), non-DMs need READ_MESSAGES and no archive, a deleted channel is a
	// denial. A transient lookup error is not a denial: the recheck exists to catch a
	// concrete revoke in the Subscribe window, the sweeps stay authoritative, and
	// unwinding on error would turn a DB hiccup into a silently dead message stream
	// with no error frame. subjectFor and the DM lookup report failures instead of
	// collapsing them.
	ch, chErr := h.readers.Dispatch.GetChannel(c.ctx, newChID)
	if chErr != nil {
		return
	}
	if ch != nil {
		// A socket without the forums feature never holds a forum's topic.
		if ch.Type == channelTypeForum && !c.features.forums {
			h.unwindChannelFocus(c, newChID)
			return
		}
		sub, subErr := h.subjectFor(c.ctx, c.userID, newChID)
		if subErr != nil {
			return
		}
		sub.Channel = channelRef(ch)
		if ch.Type == "dm" {
			ok, dmErr := h.readers.Dispatch.IsDMParticipant(c.ctx, c.userID, newChID)
			if dmErr != nil {
				return
			}
			sub.DMParticipant = ok
		}
		if permissions.CanAdmitSession(sub) == nil {
			return
		}
	}
	h.unwindChannelFocus(c, newChID)
}

// unwindChannelFocus drops the topic and slot a refused focus took.
func (h *Hub) unwindChannelFocus(c *Client, chID int64) {
	h.pubsub.Unsubscribe(c, ChannelTopic(chID))
	c.mu.Lock()
	if c.channelID == chID {
		c.channelID = 0
	}
	c.mu.Unlock()
}

// broadcastExcludeLow sends at low priority to the sender's channel except the
// sender. Not stored in the replay ring buffer (ephemeral): right for typing
// indicators (dropped on overflow, not disconnecting), wrong for messages that
// must survive reconnection replay.
func (h *Hub) broadcastExcludeLow(channelID, excludeUserID int64, msg []byte) {
	if channelID == 0 {
		h.pubsub.PublishLow(TopicGlobal, msg, excludeUserID)
		return
	}
	h.pubsub.PublishLow(ChannelTopic(channelID), msg, excludeUserID)
}
