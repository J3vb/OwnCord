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

// voiceJoinPostTokenRaceHook, when non-nil, runs immediately after
// GenerateToken succeeds and before the minted token is checked for
// supersession / handed to the client. Test-only (always nil in production):
// GenerateToken is a local JWT mint with no I/O, so the window it pins (a
// concurrent eviction landing between token generation and delivery)
// is too narrow to land reliably by staggering real goroutines. Mirrors
// cleanupVoiceRaceClearHook (hub_sweep.go), used the same way for the
// analogous CleanupVoiceForChannel race.
var voiceJoinPostTokenRaceHook func(*Client)

// handleVoiceJoinFrame processes a voice_join message.
// 1. Parses channel_id.
// 2. Checks the voice join gate (permissions.CanJoinVoice).
// 3. If already in a different voice channel, leaves it first.
// 4. Checks channel capacity (voice_max_users).
// 5. Persists join in DB.
// 6. Generates LiveKit token and sends voice_token to the client.
// 7. Sends existing voice states to the joiner.
// 8. Broadcasts voice_state to all clients.
// 9. Sends voice_config to the joiner.
//
// reqID is the joining frame's client-supplied request id (envelope.id), logged
// on the "voice join" line so an operator can correlate a token with the arrival
// that produced it (SRE-M2). Empty when the frame carried none.
// fctx is the frame deadline: it bounds the database
// reads and the membership insert up to the commit point, and a failure caused
// by it is answered REQUEST_TIMEOUT (voiceJoinFail). ctx
// is the connection context for everything that must not be cut short: the
// leave of a previous channel, the rollback, and the work after the commit
// (token, broadcasts), so a late deadline never leaves a half-applied join.
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
		// voiceJoinLeaveCurrent already took the moderator
		// mute/deafen stash off the client (or read it off the row it just
		// deleted) with nothing yet written for voiceJoinRestoreModFlags to
		// have applied — put it back so it survives for a retried join, or
		// the client's next unrelated one, instead of vanishing here.
		h.restorePendingModFlags(c, wasServerMuted, wasServerDeafened, wasServerMutedBy)
		return
	}

	state = h.voiceJoinRestoreModFlags(ctx, c, channelID, state, wasServerMuted, wasServerDeafened, wasServerMutedBy)
	persistDone := time.Now()

	if !h.voiceJoinGrantToken(ctx, txn, c, channelID, ch.AFK, state, reqID) {
		// voiceJoinRestoreModFlags above just wrote these flags into
		// the row voiceJoinGrantToken's own failure path is about to roll
		// back (rollbackVoiceJoin deletes it) — re-stash for the same reason
		// as the persist branch above.
		h.restorePendingModFlags(c, wasServerMuted, wasServerDeafened, wasServerMutedBy)
		return
	}
	tokenDone := time.Now()

	if h.voiceJoinComplete(ctx, txn, c, ch, channelID, state, reqID) {
		h.voice.NoteJoinCompleted(channelID, c.userID)
		h.latency.voiceJoin.observe(start, precheckDone, leaveDone, persistDone, tokenDone, time.Now())
	}
}

// restorePendingModFlags puts a moderator mute/deafen stash back onto c after
// an aborted join consumed it (voiceJoinLeaveCurrent's take-and-clear) or read
// it off a row that is being deleted, but could not carry it through to a
// persisted voice_states row for a later join to read back. The
// wasServerMuted || wasServerDeafened guard mirrors stashPendingModFlags' own
// early return (voice_moderation.go): a join with nothing stashed or muted
// must not overwrite an unrelated moderator action's stash with false/false/nil.
func (h *Hub) restorePendingModFlags(c *Client, wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64) {
	if wasServerMuted || wasServerDeafened {
		c.voice.stashModFlags(wasServerMuted, wasServerDeafened, wasServerMutedBy)
	}
}

// voiceJoinPrecheck runs every gate that must pass before handleVoiceJoin
// mutates any state: rate limit, payload parse, a moderator's rejoin block
// (voice_rejoin_block.go), channel existence, the join gate
// (permissions.CanJoinVoice: CONNECT_VOICE, READ_MESSAGES outside a DM,
// channel type, DM block, archive), switch capacity, authenticated user and
// LiveKit availability. It reports the target channel id, row and capacity
// (voiceJoinCapacity) when the join may proceed; on refusal it has already
// sent the error frame and returns false.
func (h *Hub) voiceJoinPrecheck(ctx context.Context, c *Client, payload json.RawMessage, reqID string) (int64, *db.Channel, int, bool) {
	// Rate limit: voice_join broadcasts a voice_state update to every connected
	// client, so cap how often a single user can trigger the fan-out. Mirrors the
	// Limiter.Allow(...) idiom used by the voice control handlers.
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
	// (user_initiated) acknowledges the removal and retires it. The block is
	// not an access rule — CanJoinVoice below still refuses a denied channel.
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

	// Validate the target channel exists before any state changes (leaving
	// the current voice channel, persisting join, etc.).
	ch, err := h.readers.Dispatch.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		voiceJoinFail(ctx, c, reqID, err, ErrCodeNotFound, "channel not found")
		return 0, nil, 0, false
	}

	// channel_id is attacker-controlled, so the gate is
	// permissions.CanJoinVoice over the channel-TYPE-aware subject: the
	// CONNECT_VOICE bit (a role-only check passes for any DM id — DMs have no
	// overrides — and the token minted below carries RoomJoin+CanSubscribe
	// for that room), READ_MESSAGES outside a DM (a channel hidden from the
	// caller is not joinable), a channel that has a room (a text channel would
	// otherwise persist a voice_states row and mint a LiveKit room the UI can
	// never render or moderate; DM and group calls join through this same
	// handler), no archive (a caller still holding the id of a channel nobody
	// can see must not join its room; the archive transition also evicts
	// whoever is inside), and for a DM membership plus no block (blocking
	// never touches dm_participants, so membership alone would let a blocked
	// user into the blocker's call — same rule as every other DM sink,
	// service.RequireDMReachable, group DMs exempt). The same predicate
	// gates the token refresh and a moderator move's destination.
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
	if !h.voiceJoinPasswordGate(ctx, c, sub, channelID, ch.PasswordProtected, intent.Password, reqID) {
		return 0, nil, 0, false
	}

	capacity := voiceJoinCapacity(sub, ch.VoiceMaxUsers)
	if !h.voiceJoinSwitchCapacityOK(ctx, c, channelID, capacity, reqID) {
		return 0, nil, 0, false
	}

	// Ensure authenticated user is present before any state changes.
	// This guard covers all downstream paths (LiveKit configured or not)
	// that dereference c.user (e.g. c.user.Username in the success log).
	if c.user == nil {
		slog.Error("handleVoiceJoin: nil user on client", "user_id", c.userID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "not authenticated", reqID))
		return 0, nil, 0, false
	}

	// Hard-fail when LiveKit is not configured — without an SFU the client
	// cannot connect to voice, so persisting state would create a ghost.
	if h.livekit == nil {
		c.sendMsg(buildErrorMsgWithID(ErrCodeVoiceError, "voice is not configured on this server", reqID))
		return 0, nil, 0, false
	}

	// Guard: reject voice join if the companion LiveKit process is not running
	// (e.g. crashed 10 times and gave up).
	if h.lkProcess != nil && !h.lkProcess.IsRunning() {
		slog.Warn("handleVoiceJoin: LiveKit process not running", "user_id", c.userID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeVoiceError, "voice is temporarily unavailable — LiveKit is not running", reqID))
		return 0, nil, 0, false
	}

	// Guard: with no supervised companion, LiveKit is externally managed, so
	// the process check above no-ops. Probe reachability before minting a
	// token: a minted credential for an SFU nobody can reach is the
	// disguised-success shape the smoke test forbids (cmd/smoke's stepSExternalAbsent
	// records exactly this) — the client would connect, fail confusingly, and
	// get no server-side explanation. ListRooms bounds itself at 3s.
	if h.lkProcess == nil {
		if healthy, err := h.livekit.HealthCheck(ctx); !healthy || err != nil {
			slog.Warn("handleVoiceJoin: external LiveKit unreachable", "user_id", c.userID, "err", err)
			voiceJoinFail(ctx, c, reqID, errors.Join(err, errVoiceJoinUnhealthy), ErrCodeVoiceError, "voice is temporarily unavailable — LiveKit is not reachable")
			return 0, nil, 0, false
		}
	}

	return channelID, ch, capacity, true
}

// voiceJoinLeaveCurrent handles the case where the client is already in a
// voice channel: it no-ops a re-join of the same channel, and for a switch it
// snapshots the moderator-imposed mute/deafen flags, leaves the old channel
// and verifies the old row is really gone. The two booleans are the
// snapshotted flags for voiceJoinRestoreModFlags; false in the third position
// means the join must not proceed (the error frame has already been sent).
func (h *Hub) voiceJoinLeaveCurrent(fctx, ctx context.Context, txn *voiceTxn, c *Client, channelID int64, reqID string) (wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64, ok bool) {
	currentChID := c.voice.channel()

	// If user is already in the same voice channel, no-op.
	if currentChID == channelID {
		c.sendMsg(buildErrorMsgWithID(ErrCodeAlreadyJoined, "already in this voice channel", reqID))
		return false, false, nil, false
	}

	// The call may be on another of this user's devices: this join takes it
	// over (rule: one call per account, and it moves).
	if currentChID == 0 {
		if moved, mMuted, mDeafened, mMutedBy, mOK := h.voiceJoinMoveCall(fctx, ctx, txn, c, channelID, reqID); moved {
			return mMuted, mDeafened, mMutedBy, mOK
		}
	}

	// A moderator-imposed mute/deafen must survive a channel switch.
	// voice.sql's ON CONFLICT branch preserves server_muted/server_deafened
	// across a plain re-join, but the switch below deletes the row via
	// handleVoiceLeave and lets JoinVoiceChannel(IfCapacity) re-insert it, so
	// that branch is never reached: the flags are snapshotted here and
	// reapplied once the new row exists.
	//
	// currentChID > 0 is the self-switch case: the row is still there to read.
	// voice_mod_move instead deletes the row on the moderator's goroutine
	// (DisconnectFromVoice) before the target's client re-joins, so by the
	// time this handler runs there is nothing left to read and currentChID is
	// already 0 — the flags for that case were snapshotted onto this client by
	// handleVoiceModMoveV2 before the delete ran (see setPendingModFlags /
	// voicePendingModFlagsSetter in voice_moderation.go) and are taken back
	// out here instead. Take-and-clear so an ordinary first join, unrelated to
	// any move, is unaffected by a stash nobody consumed.
	if currentChID > 0 {
		prevState, prevErr := h.voice.State(fctx, c.userID)
		if commandDeadlineExceeded(fctx, prevErr) {
			// Nothing has been torn down yet, so the switch can still be refused whole.
			voiceJoinFail(fctx, c, reqID, prevErr, ErrCodeInternal, "voice channel switch failed — please try again")
			return false, false, nil, false
		}
		if prevErr == nil && prevState != nil {
			wasServerMuted = prevState.ServerMuted
			wasServerDeafened = prevState.ServerDeafened
			wasServerMutedBy = prevState.ServerMutedBy
		}
	} else {
		// The stash may sit on another of this user's devices: a moderator move
		// evicted the call from it and the user changed device before rejoining.
		wasServerMuted, wasServerDeafened, wasServerMutedBy = h.takeUserModFlags(c)
	}

	// If user is already in a different voice channel, leave it first.
	if currentChID > 0 {
		h.handleVoiceLeave(ctx, txn, c, voiceLeaveReasonSwitch)

		// Verify old voice state is actually cleared before joining
		// the new channel. If the DB delete failed (retry still running in
		// background), the old row persists and JoinVoiceChannelIfCapacity's
		// COUNT(*) may produce an incorrect result. Fail the switch so the
		// user can retry cleanly.
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
			// do NOT restore the client's local voice state here.
			// handleVoiceLeave above already broadcast voice_leave for the old
			// channel to every client that can see it — including this one,
			// since finishVoiceLeave always adds the leaver to the audience —
			// so every client, this user's own session included, has already
			// torn the old membership down (dispatcher.ts runs leaveVoice on a
			// self voice_leave). Restoring c.voice.voiceChID/the topic subscription
			// would resurrect a session nobody else believes exists anymore,
			// while the stale DB row (this branch's trigger) stays orphaned.
			// Leaving the client cleared keeps it consistent with the
			// voice_leave it just received: the row now disagrees with every
			// connected client's voiceChID, so sweepStaleVoiceStates reaps it
			// (re-broadcasting voice_leave, harmlessly) within one tick, and
			// the user_id-PK upsert lets the user rejoin immediately.
			c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "voice channel switch failed — please try again", reqID))
			return wasServerMuted, wasServerDeafened, wasServerMutedBy, false
		}
	}

	return wasServerMuted, wasServerDeafened, wasServerMutedBy, true
}

// voiceJoinPersist commits the join to the DB under capacity, loads back the
// persisted row and publishes the client's in-memory voice state. Returns
// false once the error frame has been sent.
func (h *Hub) voiceJoinPersist(fctx, ctx context.Context, txn *voiceTxn, c *Client, capacity int, channelID int64, reqID string) (*db.VoiceState, bool) {
	// The service picks the capacity-checked insert or the plain one from
	// capacity, so only voiceJoinPrecheck's moderator decision can select the
	// unchecked insert for a capped channel. persistJoin sets the client's
	// voice channel as soon as the row is confirmed, before the
	// permission checks and LiveKit token mint below; a failure further down
	// unwinds it via rollbackVoiceJoin.
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

// voiceJoinRestoreModFlags re-applies a moderator-imposed mute/deafen that
// predates a channel switch and returns the voice state the caller should
// broadcast — the re-read row when the restore ran, the original otherwise.
//
// The writes and the re-read are the service's (VoiceService.RestoreModFlags);
// what stays here is the broadcast decision, plus the reason no SFU mute
// accompanies them: MuteParticipant's updateVoiceParticipantPermissions
// resolves the participant in the destination room first, and this join has
// not minted its token yet, so the call could only fail — after a LiveKit
// round trip on the read pump. As everywhere else in the voice moderation
// path the persisted server_muted is the authority: it blocks the target's
// own unmute and is re-applied at the SFU whenever the moderator next acts.
func (h *Hub) voiceJoinRestoreModFlags(ctx context.Context, c *Client, channelID int64, state *db.VoiceState, wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64) *db.VoiceState {
	if refreshed := h.voice.RestoreModFlags(ctx, c.userID, channelID, wasServerMuted, wasServerDeafened, wasServerMutedBy); refreshed != nil {
		return refreshed
	}
	return state
}

// voiceJoinPublishPerms derives the SFU publish permissions from role —
// prevents SFU-level bypass when the client connects directly via direct_url.
// With a PermissionService the three bits come from the per-user
// cache; the bare-hub fallback answers them from one role fetch + one
// overrides fetch via HasChannelPermBatch instead of re-fetching the role
// and overrides once per bit. Both branches fail closed: an unresolved role or override map
// yields no publish grants (admins bypass overrides, so an override fetch
// error cannot demote them).
//
// afk is the channel's AFK flag (migration 068): the AFK channel is
// listen-only, so it grants no publishing whatever the role allows. The
// token refresh (handleVoiceTokenRefreshV2) and the live SFU reconcile
// (updateVoiceParticipantPermissions) apply the same rule, or they would
// hand the microphone back.
func (h *Hub) voiceJoinPublishPerms(ctx context.Context, userID, channelID int64, afk bool) (canPublish, canVideo, canScreenShare bool) {
	if afk {
		return false, false, false
	}
	if h.perms != nil {
		// PermissionService answers all three bits from one cached
		// role+overrides snapshot (populated by the join gate
		// above, so these are cache hits). Same fail-closed posture: an
		// unresolved role or override map yields no publish grants.
		canPublish = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.SpeakVoice)
		canVideo = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.UseVideo)
		canScreenShare = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.ShareScreen)
	} else if role, roleErr := h.readers.Dispatch.GetMemberRoles(ctx, userID); roleErr == nil && role != nil {
		// Admins bypass overrides, so skip the fetch for them (mirrors
		// computeAllowedChannels); HasChannelPermBatch answers true from
		// the role bits alone.
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

// voiceJoinGrantToken mints the LiveKit credential and delivers it, withholding
// it if the join was superseded in the meantime. Returns false once the join
// has been abandoned (rolled back, or superseded) and must not complete.
func (h *Hub) voiceJoinGrantToken(ctx context.Context, txn *voiceTxn, c *Client, channelID int64, afk bool, state *db.VoiceState, reqID string) bool {
	// Generate LiveKit token if LiveKit client is available.
	// Token generation failure is fatal — without a token the client cannot
	// connect to the SFU, so we must roll back the DB join.
	// NOTE: the joiner's own state was already set above, but
	// nobody else has been told about the join yet — rollbackVoiceJoin below
	// is still called with broadcast=false, so a failure here does not
	// broadcast a spurious voice_leave for a join no other client ever saw.
	if h.livekit != nil {
		canPublish, canVideo, canScreenShare := h.voiceJoinPublishPerms(ctx, c.userID, channelID, afk)
		// Moderator mute/deafen follows the voice session across channel moves.
		// Carry it into the SFU grant too: muting an existing track cannot stop
		// a replacement microphone track from being published with this token.
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

		// a concurrent eviction (voice_mod_kick/move via
		// DisconnectFromVoiceInChannel, the voice permission revocation sweep, or
		// CleanupVoiceForChannel) can land anywhere between c.setVoiceState
		// (above) and here — all of them delete the voice_states row
		// and clear the client's in-memory state, then call RemoveParticipant,
		// which no-ops because this join has never reached the SFU yet
		// (GenerateToken is a local JWT mint, no LiveKit round trip). The tail
		// guard below used to be the only check, but by then the token had
		// already been queued for delivery — the client ends up with a live
		// 5-minute RoomJoin credential for a membership the server just decided
		// does not exist, and connects to the SFU with it regardless of what
		// happens after. Re-check here, immediately before the credential
		// leaves the process, and withhold it if superseded.
		if curChID, curToken := c.voice.state(); curChID != channelID || curToken != state.JoinedAt {
			slog.Info("ws handleVoiceJoin: join superseded before token delivery",
				"user_id", c.userID, "channel_id", channelID, "current_channel_id", curChID)
			// Best-effort defense in depth: this join has not reached the SFU
			// (see above), so this is normally a no-op. Async, because the
			// voice lock is held here and no LiveKit RPC runs under it.
			h.removeLiveKitParticipantAsync(ctx, channelID, c.userID, state.JoinedAt, "handleVoiceJoin supersession")
			return false
		}
		// Send the proxy path and, when loopback, the direct URL (see
		// buildVoiceToken). The client uses direct_url when on localhost
		// (avoids self-signed TLS issues with WebView fetch) and falls back
		// to the /livekit proxy otherwise.
		// NOTE: E2EE keys are no longer server-generated. Clients exchange
		// keys via ECDH (voice_e2ee_announce / voice_e2ee_offer messages).
		// Include is_key_holder so the client knows whether to initiate
		// key distribution after connecting to the SFU.
		isKeyHolder := h.computeIsKeyHolder(channelID, c.userID)
		c.sendMsg(buildVoiceToken(channelID, token, "/livekit", h.livekit.URL(), isKeyHolder))
	}

	return true
}

// voiceJoinComplete finishes a join that survived every guard: voice topic
// subscription, key-holder election, the joiner's own voice_state fan-out, the
// existing participants' states and E2EE keys, and voice_config. Returns false
// when the join was superseded or rolled back instead of completing.
func (h *Hub) voiceJoinComplete(ctx context.Context, txn *voiceTxn, c *Client, ch *db.Channel, channelID int64, state *db.VoiceState, reqID string) bool {
	// Voice channel state itself was already set above, immediately
	// after the DB row committed — which also means a concurrent eviction (the
	// revocation sweep, a participant_left webhook, a moderator kick/move) can
	// now land on THIS join instance while the token round trip above is in
	// flight. The check inside the h.livekit block above already
	// withholds the token itself in that case; this is the tail guard for
	// everything downstream of it (voice topic subscription, the joiner's own
	// voice_state broadcast) when no token round trip ran at all (h.livekit ==
	// nil is unreachable in practice — handleVoiceJoin returns earlier — but
	// kept here as the single completion gate for both paths). Those evictors
	// all clear the client's voice state and delete the row after deciding
	// against it, so completing the join here would resurrect a membership
	// that was deliberately torn down: subscribed to the voice topic and
	// broadcast as present, with no row behind it. Their decision wins; a
	// same-instance state is the only thing this join may finish.
	// markVoiceJoinCompleteIfMatch performs the same same-instance check as the
	// old plain getVoiceState comparison, but atomically with recording that
	// this join has now completed — closing the gap a separate check-then-set
	// would leave between confirming the match and marking it, which a
	// concurrent eviction landing in between could otherwise turn into a
	// completed flag surviving a state that was cleared out from under it.
	// registerNow relies on this flag being set only for a join
	// that genuinely reached this point: a network reconnect transfers a
	// replaced connection's voice state onto the resuming client solely when
	// this is true, so that an in-flight join still racing its own
	// supersession guards (the eviction check above, and this one) is never
	// handed off — doing so would make those guards misread the transfer
	// itself as an eviction and abandon the join while its voice_states row
	// stays behind for nothing to reap.
	if !txn.markCompleted(c, channelID, state.JoinedAt) {
		curChID, _ := c.voice.state()
		slog.Info("ws handleVoiceJoin: join superseded before completion",
			"user_id", c.userID, "channel_id", channelID, "current_channel_id", curChID)
		return false
	}

	// markCompleted subscribed c to the voice topic for voice-scoped events.

	// Update key holder map now that this client's voice state is set.
	h.updateKeyHolder(channelID)

	// Broadcast the joiner's state to the clients allowed to see this channel.
	//
	// sent synchronously (sendVoiceEventSync), not via the async
	// broadcastVoiceEvent queue, so it lands in program order on the joiner's
	// own socket among the four other direct sends below it (voice_token
	// above, existing states, peer keys, voice_config) — the async queue gave
	// it no fixed position relative to them, depending on how backed up the
	// dispatch goroutine was.
	h.sendVoiceEventSync(ctx, channelID, c.userID, buildVoiceState(*state))

	// Send existing channel voice states to the joiner.
	//
	// this is the ONLY place a brand-new voice_join relays an
	// existing participant's stored ECDH public key (voice_e2ee_announce) to
	// a joiner — mid-call peers never counter-announce, they only answer an
	// offer. A swallowed error here used to just `return`, leaving the
	// joiner's own voice_state already broadcast to everyone (above) but the
	// joiner itself blind to who else is in the channel and unable to
	// complete the E2EE key exchange: it times out ~15s later with no
	// explanation. Treat this the same as every other post-commit failure in
	// this handler (rollbackVoiceJoin + an error frame), broadcasting the
	// compensating voice_leave for the voice_state that already went out.
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
	// Send every other current participant's ECDH public key (and its
	// identity signature, F3 TOFU) so the joiner can complete the E2EE key
	// exchange. Factored into sendVoicePeerKeys (voice_e2ee.go) so the WS
	// resume path (registerNow, hub.go) can reuse the exact same relay for a
	// reconnecting client — voice_e2ee_announce itself is an unsequenced
	// pub/sub frame that no reconnect replay tier can ever recover.
	h.sendVoicePeerKeys(c, channelID)
	h.sendVoicePeerWatching(c, channelID)

	// Send voice_config to the joiner. h.defaultVoiceQuality (the operator's
	// voice.quality config) is the only source. A per-channel voice_quality
	// override was read here, but nothing ever wrote the column — not
	// CreateChannel, not the admin channel update — so the branch was
	// unreachable and is dropped (voice report #14); the global
	// voice.quality is authoritative.
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

// voiceMicrophoneAllowed combines the role grant with the current session's
// moderation flags for both token minting and active SFU permission updates.
// Deafen only suppresses the microphone here: clients keep stream audio
// available while deafened, so subscription and screen-share grants stay separate.
func voiceMicrophoneAllowed(canSpeak bool, state *db.VoiceState) bool {
	return canSpeak && state != nil && !state.ServerMuted && !state.ServerDeafened
}

// rollbackVoiceJoin undoes a partially-completed voice join: clears the
// client's voice channel ID, removes the DB voice state row, and broadcasts
// voice_leave so other clients don't see a ghost participant.
//
// joinedAt scopes the compensating delete to the join instance being undone
// (mirrors LeaveVoiceChannelIfMatch, used for the same reason by every
// sibling leave path). A rollback fires most often because the connection
// that started the join just died, and that same cancellation is exactly
// what lets a second connection for this user race ahead and establish a
// newer, legitimate voice_states row before this rollback runs — an
// unconditional "DELETE ... WHERE user_id = ?" would destroy that newer row
// instead of the failed one. When joinedAt is empty (the caller never read
// the row back far enough to learn it), the row is re-read here and the
// delete is skipped unless it still names channelID.
// txn is the caller's Hub.begin(c.userID) handle.
func (h *Hub) rollbackVoiceJoin(ctx context.Context, txn *voiceTxn, c *Client, channelID int64, joinedAt string, broadcast bool) {
	// the rollback must clear via voiceTxn.clear, not merely drop
	// the in-memory voiceChID: a join that already reached markCompleted's
	// Subscribe would otherwise keep its VoiceTopic subscription alive.
	// Unsubscribe is a documented no-op when the client was never subscribed
	// to that topic (pubsub.go), as when this fires before markCompleted.
	txn.clear(c)
	// The client's voice state is now set before token generation,
	// so a concurrent join/leave in the same channel can have elected this
	// half-joined client key holder. Re-run the election after taking it back
	// out, or the map keeps naming a user who never reached the SFU and the
	// real lowest-uid participant's rekey offers are rejected with
	// NOT_KEY_HOLDER until the next join or leave.
	h.updateKeyHolder(channelID)
	// The compensating delete must run even when the join failed BECAUSE the
	// connection died — that cancellation is the most common rollback trigger.
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
