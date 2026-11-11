package ws

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Voice join/leave rate limits: both broadcast to every client.
const (
	voiceJoinRateLimit  = 5
	voiceJoinWindow     = time.Second
	voiceLeaveRateLimit = 5
	voiceLeaveWindow    = time.Second
)

func validVoiceQuality(q string) bool {
	_, ok := voiceQualities[q]
	return ok
}

// voiceJoinPostTokenRaceHook runs after GenerateToken succeeds, before the supersession check.
// Test-only: the window is too narrow to hit with real goroutines.
var voiceJoinPostTokenRaceHook func(*Client)

// handleVoiceJoinFrame processes a voice_join: gate, optional leave of the current channel,
// capacity check, DB persist, LiveKit token, existing states to the joiner, voice_state
// broadcast, voice_config. reqID correlates a token with its arrival in logs. fctx is the
// frame deadline bounding DB reads and the insert up to commit (expiry answers
// REQUEST_TIMEOUT); ctx is the connection context for work that must not be cut short
// (leave, rollback, post-commit), so a late deadline never leaves a half-applied join.
func (h *Hub) handleVoiceJoinFrame(fctx, ctx context.Context, c *Client, payload json.RawMessage, reqID string) {
	start := time.Now()
	channelID, ch, capacity, ok := h.voiceJoinPrecheck(fctx, c, payload, reqID)
	if !ok {
		return
	}
	precheckDone := time.Now()
	txn := h.begin(c.userID)
	defer txn.end()

	wasServerMuted, wasServerDeafened, wasServerMutedBy, ok := h.voiceJoinLeaveCurrent(fctx, ctx, txn, c, channelID, reqID)
	if !ok {
		h.restorePendingModFlags(c, wasServerMuted, wasServerDeafened, wasServerMutedBy) // a failed switch keeps the stash
		return
	}
	leaveDone := time.Now()

	state, ok := h.voiceJoinPersist(fctx, ctx, txn, c, capacity, channelID, reqID)
	if !ok {
		// The stash was consumed and nothing was persisted for voiceJoinRestoreModFlags to apply;
		// put it back so a retried join still sees it.
		h.restorePendingModFlags(c, wasServerMuted, wasServerDeafened, wasServerMutedBy)
		return
	}

	state = h.voiceJoinRestoreModFlags(ctx, c, channelID, state, wasServerMuted, wasServerDeafened, wasServerMutedBy)
	persistDone := time.Now()

	if !h.voiceJoinGrantToken(ctx, txn, c, channelID, ch.AFK, state, reqID) {
		// Re-stash: these flags were written into the row the failure path is rolling back.
		h.restorePendingModFlags(c, wasServerMuted, wasServerDeafened, wasServerMutedBy)
		return
	}
	tokenDone := time.Now()

	if h.voiceJoinComplete(ctx, txn, c, ch, channelID, state, reqID) {
		h.voice.NoteJoinCompleted(channelID, c.userID)
		h.stats.latency.ObserveVoiceJoin(start, precheckDone, leaveDone, persistDone, tokenDone, time.Now())
	}
}

// restorePendingModFlags puts a moderator stash back onto c after an aborted join consumed
// it. A join with nothing stashed must not overwrite an unrelated moderator stash with false/false/nil.
func (h *Hub) restorePendingModFlags(c *Client, wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64) {
	if wasServerMuted || wasServerDeafened {
		c.voice.stashModFlags(wasServerMuted, wasServerDeafened, wasServerMutedBy)
	}
}

// voiceJoinPrecheck runs every gate that must pass before handleVoiceJoin mutates state. On
// refusal it has already sent the error frame and returns false.
func (h *Hub) voiceJoinPrecheck(ctx context.Context, c *Client, payload json.RawMessage, reqID string) (int64, *db.Channel, int, bool) {
	ratKey := auth.Key("voice_join", c.userID)
	if h.limiter != nil && !h.limiter.Allow(ratKey, voiceJoinRateLimit, voiceJoinWindow) {
		c.sendMsg(buildErrorMsgWithID(ErrCodeRateLimited, "too many voice join attempts", reqID))
		return 0, nil, 0, false
	}

	channelID, err := parseCallChannelID(MsgTypeVoiceJoin, payload)
	if err != nil {
		c.sendMsg(buildErrorMsgWithID(ErrCodeBadRequest, "channel_id must be a positive integer", reqID))
		return 0, nil, 0, false
	}

	// The rejoin block stops only an automatic rejoin; the user's own join (user_initiated)
	// retires it. It is not an access rule: CanJoinVoice still refuses a denied channel.
	var intent struct {
		UserInitiated bool   `json:"user_initiated"`
		Password      string `json:"password"`
	}
	_ = json.Unmarshal(payload, &intent) // parseCallChannelID already accepted it; a non-bool reads as false
	if intent.UserInitiated {
		h.voiceHub.rejoinBlocks.Clear(c.userID)
	} else if h.voiceHub.rejoinBlocks.Blocked(c.userID, channelID) {
		c.sendMsg(buildErrorMsgWithID(ErrCodeForbidden, voiceRejoinRefusal, reqID))
		return 0, nil, 0, false
	}

	ch, err := h.readers.Dispatch.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		voiceJoinFail(ctx, c, reqID, err, ErrCodeNotFound, "channel not found")
		return 0, nil, 0, false
	}

	// channel_id is attacker-controlled, so gate on permissions.CanJoinVoice over the
	// channel-type-aware subject. A role-only check would pass any DM id (DMs have no overrides)
	// and the token carries RoomJoin+CanSubscribe, and a text channel would get a voice_states
	// row. The same predicate gates token refresh and a moderator move's destination.
	sub, subErr := channelSubject(ctx, h.readers.Dispatch, h.permChecker, h.perms, c.userID, ch, true)
	if subErr != nil {
		slog.Error("ws voice_join: permission lookup failed, denying", "user_id", c.userID, "channel_id", channelID, "err", subErr)
		voiceJoinFail(ctx, c, reqID, subErr, ErrCodeInternal, "permission check failed")
		return 0, nil, 0, false
	}
	if joinErr := permissions.CanJoinVoice(sub); joinErr != nil {
		slog.Warn("ws voice_join refused", "user_id", c.userID, "channel_id", channelID, "reason", joinErr)
		refusal := joinDenial(joinErr)
		c.sendMsg(buildErrorMsgWithID(refusal.Code, refusal.Message, reqID))
		return 0, nil, 0, false
	}

	// The password applies to the user's own join only: CanJoinVoice also gates moderator move,
	// AFK move and token refresh, which must work without it.
	if !h.voiceJoinPasswordGate(ctx, c, sub, channelID, ch.JoinLocked, intent.Password, reqID) {
		return 0, nil, 0, false
	}

	capacity := voiceJoinCapacity(sub, ch.VoiceMaxUsers)
	if !h.voiceJoinSwitchCapacityOK(ctx, c, channelID, capacity, reqID) {
		return 0, nil, 0, false
	}

	if c.user == nil {
		slog.Error("handleVoiceJoin: nil user on client", "user_id", c.userID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "not authenticated", reqID))
		return 0, nil, 0, false
	}

	// No SFU means the client cannot connect; persisting state would create a ghost.
	if h.livekit == nil {
		c.sendMsg(buildErrorMsgWithID(ErrCodeVoiceError, "voice is not configured on this server", reqID))
		return 0, nil, 0, false
	}

	if h.voiceHub.lkProcess != nil && !h.voiceHub.lkProcess.IsRunning() {
		slog.Warn("handleVoiceJoin: LiveKit process not running", "user_id", c.userID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeVoiceError, "voice is temporarily unavailable — LiveKit is not running", reqID))
		return 0, nil, 0, false
	}

	// With no supervised companion LiveKit is externally managed. Probe reachability before
	// minting, or the client fails confusingly; the verdict is shared and at most 5 s old, so a
	// burst of joins costs one ListRooms (bounded at 3 s).
	if h.voiceHub.lkProcess == nil {
		if healthy, err := h.livekit.CachedHealthCheck(ctx); !healthy || err != nil {
			slog.Warn("handleVoiceJoin: external LiveKit unreachable", "user_id", c.userID, "err", err)
			voiceJoinFail(ctx, c, reqID, errors.Join(err, errVoiceJoinUnhealthy), ErrCodeVoiceError, "voice is temporarily unavailable — LiveKit is not reachable")
			return 0, nil, 0, false
		}
	}

	return channelID, ch, capacity, true
}

// voiceJoinLeaveCurrent handles a client already in voice: same-channel re-join no-ops; a
// switch snapshots moderator mute/deafen flags, leaves the old channel and verifies the old
// row is gone. A false third return means the join must not proceed (error already sent).
func (h *Hub) voiceJoinLeaveCurrent(fctx, ctx context.Context, txn *voiceTxn, c *Client, channelID int64, reqID string) (wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64, ok bool) {
	currentChID := c.voice.channel()

	if currentChID == channelID {
		c.sendMsg(buildErrorMsgWithID(ErrCodeAlreadyJoined, "already in this voice channel", reqID))
		return false, false, nil, false
	}

	if currentChID == 0 {
		if moved, mMuted, mDeafened, mMutedBy, mOK := h.voiceJoinMoveCall(fctx, ctx, txn, c, channelID, reqID); moved {
			return mMuted, mDeafened, mMutedBy, mOK
		}
	}

	// A moderator mute/deafen must survive a switch: handleVoiceLeave deletes the row, so the
	// ON CONFLICT preservation never applies; snapshot here and reapply after the new row
	// exists. currentChID > 0 is the self-switch (row readable); after voice_mod_move the row
	// is already gone (currentChID 0) and the flags were stashed on the client by
	// handleVoiceModMoveV2, so take-and-clear them here.
	if currentChID > 0 {
		prevState, prevErr := h.voice.State(fctx, c.userID)
		if commandDeadlineExceeded(fctx, prevErr) {
			voiceJoinFail(fctx, c, reqID, prevErr, ErrCodeInternal, "voice channel switch failed — please try again")
			return false, false, nil, false
		}
		if prevErr == nil && prevState != nil {
			wasServerMuted = prevState.ServerMuted
			wasServerDeafened = prevState.ServerDeafened
			wasServerMutedBy = prevState.ServerMutedBy
		}
	} else {
		wasServerMuted, wasServerDeafened, wasServerMutedBy = h.takeUserModFlags(c)
	}

	if currentChID > 0 {
		h.handleVoiceLeave(ctx, txn, c, voiceLeaveReasonSwitch)

		// Verify the old row is gone: if the DB delete failed (retry in background),
		// JoinVoiceChannelIfCapacity's COUNT(*) would be wrong. Fail so the user can retry.
		vs, err := h.voice.State(fctx, c.userID)
		if err != nil {
			slog.Warn("handleVoiceJoin: could not verify voice state cleared",
				"user_id", c.userID, "err", err)
			voiceJoinFail(fctx, c, reqID, err, ErrCodeInternal, "voice channel switch failed — please try again")
			return wasServerMuted, wasServerDeafened, wasServerMutedBy, false
		}
		if vs != nil {
			slog.Warn("handleVoiceJoin: stale voice state persists after leave, aborting switch",
				"user_id", c.userID, "stale_channel", vs.ChannelID, "target_channel", channelID)
			// Do not restore local voice state: handleVoiceLeave already broadcast voice_leave to every
			// client, so restoring would resurrect a session nobody believes exists. The stale row is
			// reaped by sweepStaleVoiceStates within one tick.
			c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "voice channel switch failed — please try again", reqID))
			return wasServerMuted, wasServerDeafened, wasServerMutedBy, false
		}
	}

	return wasServerMuted, wasServerDeafened, wasServerMutedBy, true
}

// voiceMicrophoneAllowed combines the role grant with the moderation flags for token
// minting and SFU updates. Deafen only suppresses the microphone here.
func voiceMicrophoneAllowed(canSpeak bool, state *db.VoiceState) bool {
	return canSpeak && state != nil && !state.ServerMuted && !state.ServerDeafened
}

// rollbackVoiceJoin undoes a partial join: clears the client's voice channel, removes the DB
// row and broadcasts voice_leave. joinedAt scopes the delete to the join being undone,
// since a dead connection lets a second one write a newer row; when empty the row is
// re-read and kept unless it still names channelID. txn is the caller's Hub.begin(c.userID).
func (h *Hub) rollbackVoiceJoin(ctx context.Context, txn *voiceTxn, c *Client, channelID int64, joinedAt string, broadcast bool) {
	// Clear via voiceTxn.clear, not just voiceChID: a join that reached markCompleted's
	// Subscribe would otherwise keep its VoiceTopic subscription.
	txn.clear(c)
	// The client's voice state is set before token generation, so a concurrent join/leave may
	// have elected this half-joined client key holder; re-run the election or rekey offers are
	// rejected with NOT_KEY_HOLDER.
	h.updateKeyHolder(channelID)
	// The delete must run even when the join failed because the connection died.
	rbCtx := context.WithoutCancel(ctx)
	if joinedAt == "" {
		if state, err := h.voice.State(rbCtx, c.userID); err == nil && state != nil && state.ChannelID == channelID {
			joinedAt = state.JoinedAt
		}
	}
	if joinedAt != "" {
		if _, err := txn.deleteRow(rbCtx, channelID, joinedAt); err != nil {
			slog.Error("ws rollbackVoiceJoin LeaveIfMatch", "err", err,
				"user_id", c.userID, "channel_id", channelID)
		}
	}
	if broadcast {
		h.broadcastVoiceEventWithLeaver(ctx, channelID, buildVoiceLeave(channelID, c.userID), c.userID)
	}
}
