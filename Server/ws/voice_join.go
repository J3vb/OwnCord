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

	wasServerMuted, wasServerDeafened, wasServerMutedBy, ok, unannounced := h.voiceJoinLeaveCurrent(fctx, ctx, txn, c, channelID, reqID)
	if !ok {
		h.restorePendingModFlags(c, wasServerMuted, wasServerDeafened, wasServerMutedBy) // a failed switch keeps the stash
		h.announceUnconfirmedMoveLeave(ctx, c, unannounced)
		return
	}
	if unannounced == channelID {
		// A same-channel move re-takes the user's own slot: never refused as full.
		capacity = 0
	}
	leaveDone := time.Now()

	state, ok := h.voiceJoinPersistWithModFlags(fctx, ctx, txn, c, capacity, channelID, reqID,
		modFlagStash{muted: wasServerMuted, deafened: wasServerDeafened, mutedBy: wasServerMutedBy})
	if !ok {
		// The stash was consumed and nothing was persisted for voiceJoinRestoreModFlags to apply;
		// put it back so a retried join still sees it.
		h.restorePendingModFlags(c, wasServerMuted, wasServerDeafened, wasServerMutedBy)
		h.announceUnconfirmedMoveLeave(ctx, c, unannounced)
		return
	}
	persistDone := time.Now()

	granted, tokenRolledBack := h.voiceJoinGrantToken(ctx, txn, c, channelID, ch.AFK, state, reqID)
	if !granted {
		if tokenRolledBack {
			// This join's own rollback is silent: announce the held-back leave.
			h.announceUnconfirmedMoveLeave(ctx, c, unannounced)
			return
		}
		// Superseded: the evictor deleted the row holding these flags, so re-stash.
		h.restorePendingModFlags(c, wasServerMuted, wasServerDeafened, wasServerMutedBy)
		return
	}
	tokenDone := time.Now()

	if completed, _ := h.voiceJoinComplete(ctx, txn, c, ch, channelID, state, reqID); completed {
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
// row is gone. A false ok means the join must not proceed (error already sent). unannounced
// is the channel whose membership a same-channel call move ended without a voice_leave (0
// otherwise), whatever ok says.
func (h *Hub) voiceJoinLeaveCurrent(fctx, ctx context.Context, txn *voiceTxn, c *Client, channelID int64, reqID string) (wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64, ok bool, unannounced int64) {
	currentChID := c.voice.channel()

	if currentChID == channelID {
		c.sendMsg(buildErrorMsgWithID(ErrCodeAlreadyJoined, "already in this voice channel", reqID))
		return false, false, nil, false, 0
	}

	if currentChID == 0 {
		if moved, mMuted, mDeafened, mMutedBy, mOK, mUnannounced := h.voiceJoinMoveCall(fctx, ctx, txn, c, channelID, reqID); moved {
			return mMuted, mDeafened, mMutedBy, mOK, mUnannounced
		}
	}

	// A moderator mute/deafen must survive a switch: handleVoiceLeave deletes the row, so the
	// ON CONFLICT preservation never applies; the flags are read off the row as it is deleted
	// (leaveForSwitch) and reapplied after the new row exists. After voice_mod_move the row is
	// already gone (currentChID 0) and the flags were stashed on the client by
	// EvictForModeratorMove, so take-and-clear them here.
	if currentChID == 0 {
		// The stash may sit on another of this user's devices (moved, then changed device).
		wasServerMuted, wasServerDeafened, wasServerMutedBy = h.takeUserModFlags(c)
	} else {
		flags, left := h.leaveForSwitch(fctx, ctx, txn, c, reqID)
		if !left {
			return false, false, nil, false, 0
		}
		wasServerMuted, wasServerDeafened, wasServerMutedBy = flags.muted, flags.deafened, flags.mutedBy

		// Verify the old row is gone: if the DB delete failed (retry in background),
		// JoinVoiceChannelIfCapacity's COUNT(*) would be wrong. Fail so the user can retry.
		vs, err := h.voice.State(fctx, c.userID)
		if err != nil {
			slog.Warn("handleVoiceJoin: could not verify voice state cleared",
				"user_id", c.userID, "err", err)
			voiceJoinFail(fctx, c, reqID, err, ErrCodeInternal, "voice channel switch failed — please try again")
			return wasServerMuted, wasServerDeafened, wasServerMutedBy, false, 0
		}
		if vs != nil {
			slog.Warn("handleVoiceJoin: stale voice state persists after leave, aborting switch",
				"user_id", c.userID, "stale_channel", vs.ChannelID, "target_channel", channelID)
			// Do not restore local voice state: handleVoiceLeave already broadcast voice_leave to every
			// client, so restoring would resurrect a session nobody believes exists. The stale row is
			// reaped by sweepStaleVoiceStates within one tick.
			c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "voice channel switch failed — please try again", reqID))
			return wasServerMuted, wasServerDeafened, wasServerMutedBy, false, 0
		}
	}

	return wasServerMuted, wasServerDeafened, wasServerMutedBy, true, 0
}

// leaveForSwitch reads the moderator mute/deafen off c's row and runs the leave that
// deletes it, both under the moderation lock, so a mute or unmute racing the switch is
// carried or told the member has left. left is false when the read failed: nothing was torn down.
func (h *Hub) leaveForSwitch(fctx, ctx context.Context, txn *voiceTxn, c *Client, reqID string) (flags modFlagStash, left bool) {
	unlockMod := h.voiceHub.mod.Lock(c.userID)
	defer unlockMod()
	prevState, prevErr := h.voice.State(fctx, c.userID)
	if prevErr != nil {
		slog.Warn("voice switch: could not read the moderator flags, switch refused", "user_id", c.userID, "err", prevErr)
		voiceJoinFail(fctx, c, reqID, prevErr, ErrCodeInternal, "voice channel switch failed — please try again")
		return modFlagStash{}, false
	}
	if prevState != nil {
		flags = modFlagStash{muted: prevState.ServerMuted, deafened: prevState.ServerDeafened, mutedBy: prevState.ServerMutedBy}
	}
	h.handleVoiceLeave(ctx, txn, c, voiceLeaveReasonSwitch)
	return flags, true
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

// rollbackVoiceJoinKeepingModFlags rolls back a join whose row moderators could already
// act on: under one hold of the moderation lock it reads the row's flags and deletes it, and
// those flags go back onto c for the retry. held stands in when the row is not readable.
func (h *Hub) rollbackVoiceJoinKeepingModFlags(ctx context.Context, txn *voiceTxn, c *Client, channelID int64, joinedAt string, held modFlagStash, broadcast bool) {
	flags := held
	unlockMod := h.voiceHub.mod.Lock(c.userID)
	row, err := h.voice.State(context.WithoutCancel(ctx), c.userID)
	if err == nil && row != nil && row.ChannelID == channelID && row.JoinedAt == joinedAt {
		flags = modFlagStash{muted: row.ServerMuted, deafened: row.ServerDeafened, mutedBy: row.ServerMutedBy}
	}
	h.rollbackVoiceJoin(ctx, txn, c, channelID, joinedAt, false)
	unlockMod()
	h.restorePendingModFlags(c, flags.muted, flags.deafened, flags.mutedBy)
	if broadcast {
		h.broadcastVoiceEventWithLeaver(ctx, channelID, buildVoiceLeave(channelID, c.userID), c.userID)
	}
}
