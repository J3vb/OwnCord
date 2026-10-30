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
	"github.com/J3vb/OwnCord/Server/service"
)

// Voice join/leave rate limits: both fan out a broadcast to every connected
// client, so one user must not trigger them in a tight loop.
const (
	voiceJoinRateLimit  = 5
	voiceJoinWindow     = time.Second
	voiceLeaveRateLimit = 5
	voiceLeaveWindow    = time.Second
)

// validVoiceQuality reports whether q is an accepted preset in voiceQualities.
func validVoiceQuality(q string) bool {
	_, ok := voiceQualities[q]
	return ok
}

// voiceJoinPostTokenRaceHook, when non-nil, runs right after GenerateToken
// succeeds and before the token is checked for supersession. Test-only: the
// window (an eviction between mint and delivery) is too narrow to hit reliably
// with real goroutines. Same idea as cleanupVoiceRaceClearHook (hub_sweep.go).
var voiceJoinPostTokenRaceHook func(*Client)

// handleVoiceJoinFrame processes a voice_join message: gate, optional leave of
// the current channel, capacity check, DB persist, LiveKit token, existing
// states to the joiner, voice_state broadcast, voice_config.
//
// reqID is the client-supplied request id, logged so an operator can correlate a
// token with the arrival that produced it. fctx is the frame deadline: it bounds
// the database reads and the membership insert up to the commit point, and its
// expiry is answered REQUEST_TIMEOUT (voiceJoinFail). ctx is the connection
// context for everything that must not be cut short (leave of a previous
// channel, rollback, post-commit work), so a late deadline never leaves a
// half-applied join.
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
		// voiceJoinLeaveCurrent already took the moderator mute/deafen stash off the
		// client (or read it off the row it deleted) and nothing was persisted for
		// voiceJoinRestoreModFlags to apply; put it back so a retried join still sees it.
		h.restorePendingModFlags(c, wasServerMuted, wasServerDeafened, wasServerMutedBy)
		return
	}

	state = h.voiceJoinRestoreModFlags(ctx, c, channelID, state, wasServerMuted, wasServerDeafened, wasServerMutedBy)
	persistDone := time.Now()

	if !h.voiceJoinGrantToken(ctx, txn, c, channelID, ch.AFK, state, reqID) {
		// voiceJoinRestoreModFlags wrote these flags into the row that
		// voiceJoinGrantToken's failure path is about to roll back; re-stash as above.
		h.restorePendingModFlags(c, wasServerMuted, wasServerDeafened, wasServerMutedBy)
		return
	}
	tokenDone := time.Now()

	if h.voiceJoinComplete(ctx, txn, c, ch, channelID, state, reqID) {
		h.voice.NoteJoinCompleted(channelID, c.userID)
		h.latency.voiceJoin.observe(start, precheckDone, leaveDone, persistDone, tokenDone, time.Now())
	}
}

// restorePendingModFlags puts a moderator mute/deafen stash back onto c after an
// aborted join consumed it. The guard mirrors stashPendingModFlags: a join with
// nothing stashed must not overwrite an unrelated moderator action's stash with
// false/false/nil.
func (h *Hub) restorePendingModFlags(c *Client, wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64) {
	if wasServerMuted || wasServerDeafened {
		c.voice.stashModFlags(wasServerMuted, wasServerDeafened, wasServerMutedBy)
	}
}

// voiceJoinPrecheck runs every gate that must pass before handleVoiceJoin mutates
// state (rate limit, parse, rejoin block, channel, join gate, switch capacity,
// user, LiveKit availability). On refusal it has already sent the error frame
// and returns false.
func (h *Hub) voiceJoinPrecheck(ctx context.Context, c *Client, payload json.RawMessage, reqID string) (int64, *db.Channel, int, bool) {
	// voice_join fans out to every client, so cap how often one user can trigger it.
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

	// The rejoin block stops only an automatic rejoin; the user's own join
	// (user_initiated) retires it. It is not an access rule: CanJoinVoice below still
	// refuses a denied channel.
	var intent struct {
		UserInitiated bool `json:"user_initiated"`
		// Password is the channel password, sent when the member joins a
		// password-protected channel they have not unlocked yet.
		Password string `json:"password"`
	}
	_ = json.Unmarshal(payload, &intent) // parseCallChannelID already accepted it; a non-bool reads as false
	if intent.UserInitiated {
		h.voiceRejoinBlocks.clear(c.userID)
	} else if h.voiceRejoinBlocks.blocked(c.userID, channelID) {
		c.sendMsg(buildErrorMsgWithID(ErrCodeForbidden, voiceRejoinRefusal, reqID))
		return 0, nil, 0, false
	}

	ch, err := h.readers.Dispatch.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		voiceJoinFail(ctx, c, reqID, err, ErrCodeNotFound, "channel not found")
		return 0, nil, 0, false
	}

	// channel_id is attacker-controlled, so gate on permissions.CanJoinVoice over
	// the channel-type-aware subject. A role-only check would pass any DM id (DMs
	// have no overrides) and the token below carries RoomJoin+CanSubscribe; a text
	// channel would otherwise persist a voice_states row and mint a room the UI
	// cannot render. DM membership and block rules match every other DM sink
	// (service.RequireDMReachable). The same predicate gates token refresh and a
	// moderator move's destination.
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

	// The password is the user's own join only: CanJoinVoice above also gates
	// a moderator's move, the AFK move and the token refresh, and those must
	// keep working without it.
	if !h.voiceJoinPasswordGate(ctx, c, sub, channelID, ch.JoinLocked, intent.Password, reqID) {
		return 0, nil, 0, false
	}

	capacity := voiceJoinCapacity(sub, ch.VoiceMaxUsers)
	if !h.voiceJoinSwitchCapacityOK(ctx, c, channelID, capacity, reqID) {
		return 0, nil, 0, false
	}

	// Every downstream path dereferences c.user, so require it before any state change.
	if c.user == nil {
		slog.Error("handleVoiceJoin: nil user on client", "user_id", c.userID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "not authenticated", reqID))
		return 0, nil, 0, false
	}

	// Without an SFU the client cannot connect, so persisting state would create a ghost.
	if h.livekit == nil {
		c.sendMsg(buildErrorMsgWithID(ErrCodeVoiceError, "voice is not configured on this server", reqID))
		return 0, nil, 0, false
	}

	// Reject when the companion LiveKit process gave up (crashed repeatedly).
	if h.lkProcess != nil && !h.lkProcess.IsRunning() {
		slog.Warn("handleVoiceJoin: LiveKit process not running", "user_id", c.userID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeVoiceError, "voice is temporarily unavailable — LiveKit is not running", reqID))
		return 0, nil, 0, false
	}

	// With no supervised companion LiveKit is externally managed and the check above
	// no-ops. Probe reachability before minting: a credential for an unreachable SFU
	// makes the client fail confusingly with no server-side explanation. ListRooms
	// bounds itself at 3s.
	if h.lkProcess == nil {
		if healthy, err := h.livekit.HealthCheck(ctx); !healthy || err != nil {
			slog.Warn("handleVoiceJoin: external LiveKit unreachable", "user_id", c.userID, "err", err)
			voiceJoinFail(ctx, c, reqID, errors.Join(err, errVoiceJoinUnhealthy), ErrCodeVoiceError, "voice is temporarily unavailable — LiveKit is not reachable")
			return 0, nil, 0, false
		}
	}

	return channelID, ch, capacity, true
}

// voiceJoinLeaveCurrent handles a client already in a voice channel: a re-join of
// the same channel no-ops; a switch snapshots the moderator-imposed mute/deafen
// flags, leaves the old channel and verifies the old row is gone. The third
// return false means the join must not proceed (error frame already sent).
func (h *Hub) voiceJoinLeaveCurrent(fctx, ctx context.Context, txn *voiceTxn, c *Client, channelID int64, reqID string) (wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64, ok bool) {
	currentChID := c.voice.channel()

	if currentChID == channelID {
		c.sendMsg(buildErrorMsgWithID(ErrCodeAlreadyJoined, "already in this voice channel", reqID))
		return false, false, nil, false
	}

	// The call may be on another of this user's devices: this join takes it over (one call per account).
	if currentChID == 0 {
		if moved, mMuted, mDeafened, mMutedBy, mOK := h.voiceJoinMoveCall(fctx, ctx, txn, c, channelID, reqID); moved {
			return mMuted, mDeafened, mMutedBy, mOK
		}
	}

	// A moderator mute/deafen must survive a channel switch. The switch below
	// deletes the row via handleVoiceLeave and re-inserts it, so voice.sql's ON
	// CONFLICT preservation never applies; snapshot the flags here and reapply once
	// the new row exists.
	//
	// currentChID > 0 is the self-switch: the row is still readable. voice_mod_move
	// deletes the row on the moderator's goroutine before the target re-joins, so
	// currentChID is already 0 and the flags were stashed on this client by
	// handleVoiceModMoveV2 (setPendingModFlags); take them back out here.
	// Take-and-clear so an unrelated first join is unaffected by an unconsumed stash.
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
		// The stash may sit on another of this user's devices: a moderator move evicted
		// the call from it and the user changed device before rejoining.
		wasServerMuted, wasServerDeafened, wasServerMutedBy = h.takeUserModFlags(c)
	}

	if currentChID > 0 {
		h.handleVoiceLeave(ctx, txn, c, voiceLeaveReasonSwitch)

		// Verify the old row is gone before joining: if the DB delete failed (retry
		// running in background), JoinVoiceChannelIfCapacity's COUNT(*) would be wrong.
		// Fail the switch so the user can retry cleanly.
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
			// Do NOT restore the client's local voice state. handleVoiceLeave already
			// broadcast voice_leave for the old channel to every client, this one included,
			// so all of them (this user's own session too) have torn the old membership down.
			// Restoring would resurrect a session nobody believes exists. The stale row then
			// disagrees with every client's voiceChID, so sweepStaleVoiceStates reaps it
			// within one tick, and the user_id-PK upsert lets the user rejoin immediately.
			c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "voice channel switch failed — please try again", reqID))
			return wasServerMuted, wasServerDeafened, wasServerMutedBy, false
		}
	}

	return wasServerMuted, wasServerDeafened, wasServerMutedBy, true
}

// voiceJoinPersist commits the join under capacity, reads the row back and
// publishes the client's in-memory voice state. Returns false once the error
// frame has been sent.
func (h *Hub) voiceJoinPersist(fctx, ctx context.Context, txn *voiceTxn, c *Client, capacity int, channelID int64, reqID string) (*db.VoiceState, bool) {
	// The service picks the capacity-checked insert from capacity, so only
	// voiceJoinPrecheck's moderator decision can select the unchecked insert for a
	// capped channel. persistJoin sets the client's voice channel as soon as the row
	// is confirmed, before the token mint below; a later failure unwinds it via
	// rollbackVoiceJoin.
	state, err := txn.persistJoin(fctx, c, channelID, capacity)
	switch {
	case errors.Is(err, service.ErrVoiceChannelFull):
		c.sendMsg(buildErrorMsgWithID(ErrCodeChannelFull, "voice channel is full", reqID))
		return nil, false
	case errors.Is(err, errVoiceJoinReadBack):
		slog.Error("ws handleVoiceJoin State", "err", err, "user_id", c.userID)
		h.rollbackVoiceJoin(ctx, txn, c, channelID, "", false)
		voiceJoinFail(fctx, c, reqID, err, ErrCodeInternal, "failed to join voice channel")
		return nil, false
	case err != nil:
		slog.Error("ws handleVoiceJoin Join", "err", err, "user_id", c.userID)
		h.voiceJoinAbandonOnDeadline(fctx, ctx, txn, c, channelID, err)
		voiceJoinFail(fctx, c, reqID, err, ErrCodeInternal, "failed to join voice channel")
		return nil, false
	}
	return state, true
}

// voiceJoinRestoreModFlags re-applies a moderator mute/deafen that predates a
// channel switch and returns the state to broadcast (the re-read row if restored,
// else the original). No SFU mute accompanies it: MuteParticipant resolves the
// participant in the destination room, and this join has not minted its token yet,
// so it could only fail after a LiveKit round trip on the read pump. The persisted
// server_muted is the authority: it blocks the target's own unmute and is
// re-applied at the SFU whenever the moderator next acts.
func (h *Hub) voiceJoinRestoreModFlags(ctx context.Context, c *Client, channelID int64, state *db.VoiceState, wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64) *db.VoiceState {
	if refreshed := h.voice.RestoreModFlags(ctx, c.userID, channelID, wasServerMuted, wasServerDeafened, wasServerMutedBy); refreshed != nil {
		return refreshed
	}
	return state
}

// voiceJoinPublishPerms derives the SFU publish permissions from role, so a
// client connecting directly via direct_url cannot bypass them. Both branches
// fail closed: an unresolved role or override map yields no grants (admins bypass
// overrides, so an override fetch error cannot demote them). The bare-hub
// fallback uses one role fetch and one overrides fetch via HasChannelPermBatch
// instead of one per bit.
//
// afk is the channel's AFK flag: the AFK channel is listen-only whatever the role
// allows. Token refresh (handleVoiceTokenRefreshV2) and the live SFU reconcile
// (updateVoiceParticipantPermissions) apply the same rule, or they would hand the
// microphone back.
func (h *Hub) voiceJoinPublishPerms(ctx context.Context, userID, channelID int64, afk bool) (canPublish, canVideo, canScreenShare bool) {
	if afk {
		return false, false, false
	}
	if h.perms != nil {
		canPublish = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.SpeakVoice)
		canVideo = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.UseVideo)
		canScreenShare = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.ShareScreen)
	} else if role, roleErr := h.readers.Dispatch.GetMemberRoles(ctx, userID); roleErr == nil && role != nil {
		// Admins bypass overrides, so skip the fetch for them.
		grants := permissions.MemberGrants{Perms: role.Perms}
		var oErr error
		if !permissions.HasAdmin(role.Perms) {
			grants, oErr = h.readers.Dispatch.GetMemberGrants(ctx, userID)
			grants.Perms = role.Perms
		}
		if oErr == nil {
			canPublish = h.permChecker.HasChannelPermBatch(grants, channelID, permissions.SpeakVoice)
			canVideo = h.permChecker.HasChannelPermBatch(grants, channelID, permissions.UseVideo)
			canScreenShare = h.permChecker.HasChannelPermBatch(grants, channelID, permissions.ShareScreen)
		}
	}
	return canPublish, canVideo, canScreenShare
}

// voiceJoinGrantToken mints the LiveKit credential and delivers it, withholding it
// if the join was superseded meanwhile. Returns false once the join was abandoned
// (rolled back or superseded).
func (h *Hub) voiceJoinGrantToken(ctx context.Context, txn *voiceTxn, c *Client, channelID int64, afk bool, state *db.VoiceState, reqID string) bool {
	// Token generation failure is fatal (the client cannot reach the SFU), so roll
	// back the DB join. rollbackVoiceJoin is called with broadcast=false: nobody else
	// has been told about the join yet, so no spurious voice_leave.
	if h.livekit != nil {
		canPublish, canVideo, canScreenShare := h.voiceJoinPublishPerms(ctx, c.userID, channelID, afk)
		// Moderator mute/deafen follows the voice session across moves; carry it into the
		// SFU grant too, since muting an existing track cannot stop a replacement
		// microphone track being published with this token.
		canPublish = voiceMicrophoneAllowed(canPublish, state)
		token, tokenErr := h.livekit.GenerateToken(c.userID, c.user.Username, channelID, state.JoinedAt, canPublish, canVideo, canScreenShare)
		if tokenErr != nil {
			slog.Error("ws handleVoiceJoin GenerateToken", "err", tokenErr, "user_id", c.userID)
			h.rollbackVoiceJoin(ctx, txn, c, channelID, state.JoinedAt, false)
			c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "failed to generate voice token", reqID))
			return false
		}
		if voiceJoinPostTokenRaceHook != nil {
			voiceJoinPostTokenRaceHook(c)
		}

		// A concurrent eviction (voice_mod_kick/move, the permission revocation sweep,
		// CleanupVoiceForChannel) can land between c.setVoiceState and here: it deletes
		// the row, clears the client's state and calls RemoveParticipant, which no-ops
		// because this join never reached the SFU. Re-check immediately before the
		// credential leaves the process and withhold it if superseded; otherwise the
		// client would hold a live RoomJoin credential for a membership that no longer exists.
		if curChID, curToken := c.voice.state(); curChID != channelID || curToken != state.JoinedAt {
			slog.Info("ws handleVoiceJoin: join superseded before token delivery",
				"user_id", c.userID, "channel_id", channelID, "current_channel_id", curChID)
			// Best-effort defense in depth; normally a no-op as the join never reached the
			// SFU. Async because the voice lock is held and no LiveKit RPC runs under it.
			h.removeLiveKitParticipantAsync(ctx, channelID, c.userID, state.JoinedAt, "handleVoiceJoin supersession")
			return false
		}
		// Send the proxy path and, on loopback, the direct URL; the client prefers
		// direct_url on localhost (avoids self-signed TLS issues with WebView fetch).
		// is_key_holder tells the client whether to start key distribution (E2EE keys
		// are exchanged between clients via ECDH, not generated here).
		isKeyHolder := h.computeIsKeyHolder(channelID, c.userID)
		c.sendMsg(buildVoiceToken(channelID, token, "/livekit", h.livekit.URL(), isKeyHolder))
	}

	return true
}

// voiceJoinComplete finishes a join that survived every guard: topic
// subscription, key-holder election, the joiner's voice_state fan-out, existing
// participants' states and E2EE keys, and voice_config. Returns false when the
// join was superseded or rolled back.
func (h *Hub) voiceJoinComplete(ctx context.Context, txn *voiceTxn, c *Client, ch *db.Channel, channelID int64, state *db.VoiceState, reqID string) bool {
	// Tail guard: a concurrent eviction (revocation sweep, participant_left webhook,
	// moderator kick/move) can land on this join instance after the commit. Evictors
	// clear the client's voice state and delete the row, so completing here would
	// resurrect a membership that was deliberately torn down. Their decision wins.
	// markCompleted checks same-instance atomically with recording completion, so an
	// eviction cannot slip between check and set. registerNow relies on the flag
	// being set only for a join that reached this point: a reconnect transfers a
	// replaced connection's voice state to the resuming client solely when it is
	// true, so an in-flight join still racing its guards is never handed off (the
	// guards would misread the transfer as an eviction and orphan the row).
	if !txn.markCompleted(c, channelID, state.JoinedAt) {
		curChID, _ := c.voice.state()
		slog.Info("ws handleVoiceJoin: join superseded before completion",
			"user_id", c.userID, "channel_id", channelID, "current_channel_id", curChID)
		return false
	}

	// Update key holder map now that this client's voice state is set.
	h.updateKeyHolder(channelID)

	// Sent synchronously (sendVoiceEventSync), not via the async queue, so it lands
	// in program order on the joiner's socket among the direct sends around it
	// (voice_token, existing states, peer keys, voice_config).
	h.sendVoiceEventSync(ctx, channelID, c.userID, buildVoiceState(*state))

	// This is the only place a new voice_join relays an existing participant's ECDH
	// public key to a joiner (mid-call peers only answer offers). Swallowing an error
	// would leave the joiner blind to who is present and its E2EE exchange timing out
	// ~15s later, so treat it like every other post-commit failure: rollback, error
	// frame, and the compensating voice_leave for the voice_state already sent.
	existing, err := h.voice.ChannelStates(ctx, channelID)
	if err != nil {
		slog.Error("ws handleVoiceJoin ChannelStates", "err", err)
		h.rollbackVoiceJoin(ctx, txn, c, channelID, state.JoinedAt, true)
		c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "failed to join voice channel", reqID))
		return false
	}
	for _, vs := range existing {
		if vs.UserID == c.userID {
			continue
		}
		c.sendMsg(buildVoiceState(vs))
	}
	// Relay every other participant's ECDH public key and identity signature so the
	// joiner can complete the E2EE exchange. Shared with the resume path (registerNow)
	// because voice_e2ee_announce is an unsequenced pub/sub frame no replay tier can recover.
	h.sendVoicePeerKeys(c, channelID)
	h.sendVoicePeerWatching(c, channelID)

	// h.defaultVoiceQuality (voice.quality config) is the only source; no per-channel override exists.
	quality := h.defaultVoiceQuality
	maxUsers := ch.VoiceMaxUsers
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
		"req_id", reqID,
		"remote", c.remoteAddr,
		"livekit_url", lkURL,
		"quality", quality,
		"channel_users", len(existing),
		"channel_max", maxUsers,
	)
	return true
}

// voiceMicrophoneAllowed combines the role grant with the session's moderation
// flags for token minting and SFU permission updates. Deafen only suppresses the
// microphone here; subscription and screen-share grants stay separate.
func voiceMicrophoneAllowed(canSpeak bool, state *db.VoiceState) bool {
	return canSpeak && state != nil && !state.ServerMuted && !state.ServerDeafened
}

// rollbackVoiceJoin undoes a partially-completed join: clears the client's voice
// channel, removes the DB row and broadcasts voice_leave so no ghost remains.
//
// joinedAt scopes the compensating delete to the join instance being undone. A
// rollback often fires because the connection died, which lets a second
// connection race ahead and write a newer legitimate row; an unconditional
// delete would destroy it. When joinedAt is empty the row is re-read and the
// delete is skipped unless it still names channelID. txn is the caller's
// Hub.begin(c.userID) handle.
func (h *Hub) rollbackVoiceJoin(ctx context.Context, txn *voiceTxn, c *Client, channelID int64, joinedAt string, broadcast bool) {
	// Clear via voiceTxn.clear, not just the in-memory voiceChID: a join that reached
	// markCompleted's Subscribe would otherwise keep its VoiceTopic subscription.
	// Unsubscribe is a no-op if never subscribed.
	txn.clear(c)
	// The client's voice state is set before token generation, so a concurrent
	// join/leave can have elected this half-joined client key holder. Re-run the
	// election or rekey offers are rejected with NOT_KEY_HOLDER until the next join/leave.
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
