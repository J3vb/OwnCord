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
// concurrent eviction landing between token generation and delivery, OC-0008)
// is too narrow to land reliably by staggering real goroutines. Mirrors
// cleanupVoiceRaceClearHook (hub_sweep.go), used the same way for the
// analogous CleanupVoiceForChannel race.
var voiceJoinPostTokenRaceHook func(*Client)

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
	channelID, ch, ok := h.voiceJoinPrecheck(ctx, c, payload)
	if !ok {
		return
	}

	wasServerMuted, wasServerDeafened, ok := h.voiceJoinLeaveCurrent(ctx, c, channelID)
	if !ok {
		return
	}

	state, ok := h.voiceJoinPersist(ctx, c, ch, channelID)
	if !ok {
		return
	}

	state = h.voiceJoinRestoreModFlags(ctx, c, channelID, state, wasServerMuted, wasServerDeafened)

	if !h.voiceJoinGrantToken(ctx, c, channelID, state) {
		return
	}

	h.voiceJoinComplete(ctx, c, ch, channelID, state)
}

// voiceJoinPrecheck runs every gate that must pass before handleVoiceJoin
// mutates any state: rate limit, payload parse, CONNECT_VOICE, channel
// existence, channel type, DM block, archive, authenticated user and LiveKit
// availability. It reports the target channel id and row when the join may
// proceed; on refusal it has already sent the error frame and returns false.
func (h *Hub) voiceJoinPrecheck(ctx context.Context, c *Client, payload json.RawMessage) (int64, *db.Channel, bool) {
	// Rate limit: voice_join broadcasts a voice_state update to every connected
	// client, so cap how often a single user can trigger the fan-out. Mirrors the
	// Limiter.Allow(...) idiom used by the voice control handlers.
	ratKey := auth.Key("voice_join", c.userID)
	if h.limiter != nil && !h.limiter.Allow(ratKey, voiceJoinRateLimit, voiceJoinWindow) {
		c.sendMsg(buildErrorMsg(ErrCodeRateLimited, "too many voice join attempts"))
		return 0, nil, false
	}

	channelID, err := parseChannelID(payload)
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "channel_id must be a positive integer"))
		return 0, nil, false
	}

	// Validate the target channel exists before any state changes (leaving
	// the current voice channel, persisting join, etc.).
	ch, err := h.readers.Dispatch.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		c.sendMsg(buildErrorMsg(ErrCodeNotFound, "channel not found"))
		return 0, nil, false
	}

	// channel_id is attacker-controlled, so the gate is
	// permissions.CanJoinVoice over the channel-TYPE-aware subject: the
	// CONNECT_VOICE bit (a role-only check passes for any DM id — DMs have no
	// overrides — and the token minted below carries RoomJoin+CanSubscribe
	// for that room), a channel that has a room (a text channel would
	// otherwise persist a voice_states row and mint a LiveKit room the UI can
	// never render or moderate; DM and group calls join through this same
	// handler), no archive (a caller still holding the id of a channel nobody
	// can see must not join its room; the archive transition also evicts
	// whoever is inside), and for a DM membership plus no block (blocking
	// never touches dm_participants, so membership alone would let a blocked
	// user into the blocker's call — same rule as every other DM sink,
	// service.requireDMNotBlocked, group DMs exempt). The same predicate
	// gates the token refresh and a moderator move's destination.
	sub, subErr := channelSubject(ctx, h.readers.Dispatch, h.permChecker, h.perms, c.userID, ch, true)
	if subErr != nil {
		slog.Error("ws voice_join: permission lookup failed, denying", "user_id", c.userID, "channel_id", channelID, "err", subErr)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "permission check failed"))
		return 0, nil, false
	}
	if joinErr := permissions.CanJoinVoice(sub); joinErr != nil {
		slog.Warn("ws voice_join refused", "user_id", c.userID, "channel_id", channelID, "reason", joinErr)
		refusal := joinDenial(joinErr)
		c.sendMsg(buildErrorMsg(refusal.Code, refusal.Message))
		return 0, nil, false
	}

	// Advisory capacity pre-flight for the switch case, mirroring
	// handleVoiceModMoveV2's pre-flight (voice_moderation.go): without it,
	// voiceJoinLeaveCurrent below tears the caller out of their current call
	// before voiceJoinPersist's atomic check ever runs, so a switch to a full
	// channel ends the old call for nothing (OC-0351). Same-channel re-join
	// stays gated by ALREADY_JOINED in voiceJoinLeaveCurrent, not here — this
	// only guards the destructive leave a genuine switch would trigger. The
	// atomic JoinVoiceChannelIfCapacity check in voiceJoinPersist remains the
	// authority for the race; this is advisory, exactly as in the move path.
	if cur := c.getVoiceChID(); cur > 0 && cur != channelID && ch.VoiceMaxUsers > 0 {
		count, cErr := h.voice.CountInChannel(ctx, channelID)
		if cErr != nil {
			slog.Error("ws voice_join: capacity pre-check failed", "err", cErr, "channel_id", channelID)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to check channel capacity"))
			return 0, nil, false
		}
		if count >= ch.VoiceMaxUsers {
			c.sendMsg(buildErrorMsg(ErrCodeChannelFull, "voice channel is full"))
			return 0, nil, false
		}
	}

	// Ensure authenticated user is present before any state changes.
	// This guard covers all downstream paths (LiveKit configured or not)
	// that dereference c.user (e.g. c.user.Username in the success log).
	if c.user == nil {
		slog.Error("handleVoiceJoin: nil user on client", "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "not authenticated"))
		return 0, nil, false
	}

	// Hard-fail when LiveKit is not configured — without an SFU the client
	// cannot connect to voice, so persisting state would create a ghost.
	if h.livekit == nil {
		c.sendMsg(buildErrorMsg(ErrCodeVoiceError, "voice is not configured on this server"))
		return 0, nil, false
	}

	// Guard: reject voice join if the companion LiveKit process is not running
	// (e.g. crashed 10 times and gave up).
	if h.lkProcess != nil && !h.lkProcess.IsRunning() {
		slog.Warn("handleVoiceJoin: LiveKit process not running", "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeVoiceError, "voice is temporarily unavailable — LiveKit is not running"))
		return 0, nil, false
	}

	return channelID, ch, true
}

// voiceJoinLeaveCurrent handles the case where the client is already in a
// voice channel: it no-ops a re-join of the same channel, and for a switch it
// snapshots the moderator-imposed mute/deafen flags, leaves the old channel
// and verifies the old row is really gone. The two booleans are the
// snapshotted flags for voiceJoinRestoreModFlags; false in the third position
// means the join must not proceed (the error frame has already been sent).
func (h *Hub) voiceJoinLeaveCurrent(ctx context.Context, c *Client, channelID int64) (bool, bool, bool) {
	currentChID := c.getVoiceChID()

	// If user is already in the same voice channel, no-op.
	if currentChID == channelID {
		c.sendMsg(buildErrorMsg(ErrCodeAlreadyJoined, "already in this voice channel"))
		return false, false, false
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
	var wasServerMuted, wasServerDeafened bool
	if currentChID > 0 {
		if prevState, prevErr := h.voice.State(ctx, c.userID); prevErr == nil && prevState != nil {
			wasServerMuted = prevState.ServerMuted
			wasServerDeafened = prevState.ServerDeafened
		}
	} else {
		wasServerMuted, wasServerDeafened = c.takePendingModFlags()
	}

	// If user is already in a different voice channel, leave it first.
	if currentChID > 0 {
		h.handleVoiceLeave(ctx, c)

		// BUG-088: Verify old voice state is actually cleared before joining
		// the new channel. If the DB delete failed (retry still running in
		// background), the old row persists and JoinVoiceChannelIfCapacity's
		// COUNT(*) may produce an incorrect result. Fail the switch so the
		// user can retry cleanly.
		vs, err := h.voice.State(ctx, c.userID)
		if err != nil {
			slog.Warn("handleVoiceJoin: could not verify voice state cleared",
				"user_id", c.userID, "err", err)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice channel switch failed — please try again"))
			return false, false, false
		}
		if vs != nil {
			slog.Warn("handleVoiceJoin: stale voice state persists after leave, aborting switch",
				"user_id", c.userID, "stale_channel", vs.ChannelID, "target_channel", channelID)
			// OC-0034: do NOT restore the client's local voice state here.
			// handleVoiceLeave above already broadcast voice_leave for the old
			// channel to every client that can see it — including this one,
			// since finishVoiceLeave always adds the leaver to the audience —
			// so every client, this user's own session included, has already
			// torn the old membership down (dispatcher.ts runs leaveVoice on a
			// self voice_leave). Restoring c.voiceChID/the topic subscription
			// would resurrect a session nobody else believes exists anymore,
			// while the stale DB row (this branch's trigger) stays orphaned.
			// Leaving the client cleared keeps it consistent with the
			// voice_leave it just received: the row now disagrees with every
			// connected client's voiceChID, so sweepStaleVoiceStates reaps it
			// (re-broadcasting voice_leave, harmlessly) within one tick, and
			// the user_id-PK upsert lets the user rejoin immediately.
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice channel switch failed — please try again"))
			return false, false, false
		}
	}

	return wasServerMuted, wasServerDeafened, true
}

// voiceJoinPersist commits the join to the DB under the channel's capacity
// limit, loads back the persisted row and publishes the client's in-memory
// voice state. Returns false once the error frame has been sent.
func (h *Hub) voiceJoinPersist(ctx context.Context, c *Client, ch *db.Channel, channelID int64) (*db.VoiceState, bool) {
	// The service picks the capacity-checked insert or the plain one from
	// the channel's own cap, so this handler cannot pick the unchecked
	// insert for a capped channel.
	if err := h.voice.Join(ctx, c.userID, channelID, ch.VoiceMaxUsers); err != nil {
		if errors.Is(err, service.ErrVoiceChannelFull) {
			c.sendMsg(buildErrorMsg(ErrCodeChannelFull, "voice channel is full"))
			return nil, false
		}
		slog.Error("ws handleVoiceJoin Join", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to join voice channel"))
		return nil, false
	}

	// Load the persisted row immediately so later cleanup can target this exact
	// join instance even if the user rejoins the same channel.
	state, err := h.voice.State(ctx, c.userID)
	if err != nil || state == nil {
		slog.Error("ws handleVoiceJoin State", "err", err, "user_id", c.userID)
		h.rollbackVoiceJoin(ctx, c, channelID, "", false)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to join voice channel"))
		return nil, false
	}

	// BUG-088: set the client's voice channel as soon as the DB row is
	// confirmed committed, before the permission checks and LiveKit token
	// generation below (which can take several round trips). Leaving this
	// until after those steps left a window where the concurrent stale-voice
	// sweep sees c.getVoiceChID() still 0 while the row already exists,
	// misclassifies the in-flight join as a ghost and deletes it — leaving
	// the joiner live on the hub and in the SFU with no DB row. A failure
	// further down still unwinds this via rollbackVoiceJoin's
	// c.clearVoiceChID(), same as before.
	c.setVoiceState(channelID, state.JoinedAt)

	return state, true
}

// voiceJoinRestoreModFlags re-applies a moderator-imposed mute/deafen that
// predates a channel switch and returns the voice state the caller should
// broadcast — the re-read row when the restore ran, the original otherwise.
//
// The writes and the re-read are the service's (VoiceService.RestoreModFlags);
// what stays here is the broadcast decision, plus the reason no SFU mute
// accompanies them: MuteParticipantAudio resolves the participant in the
// destination room first, and this join has not minted its token yet, so the
// call could only fail — after a LiveKit round trip on the read pump. As
// everywhere else in the voice moderation path the persisted server_muted is
// the authority: it blocks the target's own unmute and is re-applied at the
// SFU whenever the moderator next acts.
func (h *Hub) voiceJoinRestoreModFlags(ctx context.Context, c *Client, channelID int64, state *db.VoiceState, wasServerMuted, wasServerDeafened bool) *db.VoiceState {
	if refreshed := h.voice.RestoreModFlags(ctx, c.userID, channelID, wasServerMuted, wasServerDeafened); refreshed != nil {
		return refreshed
	}
	return state
}

// voiceJoinPublishPerms derives the SFU publish permissions from role —
// prevents SFU-level bypass when the client connects directly via direct_url
// (BUG-128). With a PermissionService the three bits come from the per-user
// cache; the bare-hub fallback answers them from one role fetch + one
// overrides fetch via HasChannelPermBatch instead of three hasChannelPerm
// round trips. Both branches fail closed: an unresolved role or override map
// yields no publish grants (admins bypass overrides, so an override fetch
// error cannot demote them).
func (h *Hub) voiceJoinPublishPerms(ctx context.Context, userID, channelID int64) (canPublish, canVideo, canScreenShare bool) {
	if h.perms != nil {
		// PermissionService answers all three bits from one cached
		// role+overrides snapshot (populated by the CONNECT_VOICE gate
		// above, so these are cache hits). Same fail-closed posture: an
		// unresolved role or override map yields no publish grants.
		canPublish = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.SpeakVoice)
		canVideo = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.UseVideo)
		canScreenShare = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.ShareScreen)
	} else if role, roleErr := h.readers.Dispatch.GetRoleForUser(ctx, userID); roleErr == nil && role != nil {
		// Admins bypass overrides, so skip the fetch for them (mirrors
		// computeAllowedChannels); HasChannelPermBatch answers true from
		// the role bits alone.
		var overrides map[int64]db.ChannelOverride
		var oErr error
		if !permissions.HasAdmin(role.Permissions) {
			overrides, oErr = h.readers.Dispatch.GetChannelOverridesFor(ctx, role.ID, userID)
		}
		if oErr == nil {
			po := permOverrides(overrides)
			canPublish = h.permChecker.HasChannelPermBatch(role.Permissions, po, channelID, permissions.SpeakVoice)
			canVideo = h.permChecker.HasChannelPermBatch(role.Permissions, po, channelID, permissions.UseVideo)
			canScreenShare = h.permChecker.HasChannelPermBatch(role.Permissions, po, channelID, permissions.ShareScreen)
		}
	}
	return canPublish, canVideo, canScreenShare
}

// voiceJoinGrantToken mints the LiveKit credential and delivers it, withholding
// it if the join was superseded in the meantime. Returns false once the join
// has been abandoned (rolled back, or superseded) and must not complete.
func (h *Hub) voiceJoinGrantToken(ctx context.Context, c *Client, channelID int64, state *db.VoiceState) bool {
	// Generate LiveKit token if LiveKit client is available.
	// Token generation failure is fatal — without a token the client cannot
	// connect to the SFU, so we must roll back the DB join.
	// NOTE: the joiner's own state was already set above (BUG-088), but
	// nobody else has been told about the join yet — rollbackVoiceJoin below
	// is still called with broadcast=false, so a failure here does not
	// broadcast a spurious voice_leave for a join no other client ever saw.
	if h.livekit != nil {
		canPublish, canVideo, canScreenShare := h.voiceJoinPublishPerms(ctx, c.userID, channelID)
		canSubscribe := true
		token, tokenErr := h.livekit.GenerateToken(c.userID, c.user.Username, channelID, state.JoinedAt, canPublish, canSubscribe, canVideo, canScreenShare)
		if tokenErr != nil {
			slog.Error("ws handleVoiceJoin GenerateToken", "err", tokenErr, "user_id", c.userID)
			h.rollbackVoiceJoin(ctx, c, channelID, state.JoinedAt, false)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to generate voice token"))
			return false
		}
		if voiceJoinPostTokenRaceHook != nil {
			voiceJoinPostTokenRaceHook(c)
		}

		// OC-0008: a concurrent eviction (voice_mod_kick/move via
		// DisconnectFromVoiceInChannel, the CONNECT_VOICE revocation sweep, or
		// CleanupVoiceForChannel) can land anywhere between c.setVoiceState
		// (BUG-088, above) and here — all of them delete the voice_states row
		// and clear the client's in-memory state, then call RemoveParticipant,
		// which no-ops because this join has never reached the SFU yet
		// (GenerateToken is a local JWT mint, no LiveKit round trip). The tail
		// guard below used to be the only check, but by then the token had
		// already been queued for delivery — the client ends up with a live
		// 5-minute RoomJoin credential for a membership the server just decided
		// does not exist, and connects to the SFU with it regardless of what
		// happens after. Re-check here, immediately before the credential
		// leaves the process, and withhold it if superseded.
		if curChID, curToken := c.getVoiceState(); curChID != channelID || curToken != state.JoinedAt {
			slog.Info("ws handleVoiceJoin: join superseded before token delivery",
				"user_id", c.userID, "channel_id", channelID, "current_channel_id", curChID)
			// Best-effort defense in depth: this join has not reached the SFU
			// (see above), so this is normally a no-op, but it closes the
			// sliver of time between this check and c.sendMsg below the same
			// way every other eviction path's RemoveParticipant call does.
			rbCtx := context.WithoutCancel(ctx)
			if err := h.livekit.RemoveParticipant(rbCtx, channelID, c.userID, state.JoinedAt); err != nil {
				slog.Warn("ws handleVoiceJoin: RemoveParticipant after supersession failed (may already be gone)",
					"err", err, "user_id", c.userID, "channel_id", channelID)
			}
			return false
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

	return true
}

// voiceJoinComplete finishes a join that survived every guard: voice topic
// subscription, key-holder election, the joiner's own voice_state fan-out, the
// existing participants' states and E2EE keys, and voice_config.
func (h *Hub) voiceJoinComplete(ctx context.Context, c *Client, ch *db.Channel, channelID int64, state *db.VoiceState) {
	// Voice channel state itself was already set above (BUG-088), immediately
	// after the DB row committed — which also means a concurrent eviction (the
	// revocation sweep, a participant_left webhook, a moderator kick/move) can
	// now land on THIS join instance while the token round trip above is in
	// flight. The check inside the h.livekit block above (OC-0008) already
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
	// registerNow (OC-0270) relies on this flag being set only for a join
	// that genuinely reached this point: a network reconnect transfers a
	// replaced connection's voice state onto the resuming client solely when
	// this is true, so that an in-flight join still racing its own
	// supersession guards (the OC-0008 check above, and this one) is never
	// handed off — doing so would make those guards misread the transfer
	// itself as an eviction and abandon the join while its voice_states row
	// stays behind for nothing to reap.
	if !c.markVoiceJoinCompleteIfMatch(channelID, state.JoinedAt) {
		curChID, _ := c.getVoiceState()
		slog.Info("ws handleVoiceJoin: join superseded before completion",
			"user_id", c.userID, "channel_id", channelID, "current_channel_id", curChID)
		return
	}

	// Subscribe to voice topic for voice-scoped events.
	h.pubsub.Subscribe(c, VoiceTopic(channelID))

	// Update key holder map now that this client's voice state is set.
	h.updateKeyHolder(channelID)

	// Broadcast the joiner's state to the clients allowed to see this channel.
	//
	// OC-0349: sent synchronously (sendVoiceEventSync), not via the async
	// broadcastVoiceEvent queue, so it lands in program order on the joiner's
	// own socket among the four other direct sends below it (voice_token
	// above, existing states, peer keys, voice_config) — the async queue gave
	// it no fixed position relative to them, depending on how backed up the
	// dispatch goroutine was.
	h.sendVoiceEventSync(ctx, channelID, buildVoiceState(*state))

	// Send existing channel voice states to the joiner.
	//
	// OC-0172: this is the ONLY place a brand-new voice_join relays an
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
		h.rollbackVoiceJoin(ctx, c, channelID, state.JoinedAt, true)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to join voice channel"))
		return
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
	// pub/sub frame that no reconnect replay tier can ever recover (OC-0276).
	h.sendVoicePeerKeys(c, channelID)

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

	ratKey := auth.Key("voice_token_refresh", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, 1, 60*time.Second) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "token refresh rate limited"}}
	}

	if channelID == 0 {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "not in voice"}}
	}

	if d.TokenGen == nil {
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "voice not configured"}}
	}

	// Re-run the join gate (permissions.CanJoinVoice, exactly as voice_join
	// applies it) where the credential is minted. The channel comes from the
	// client's own session state, and voice_join used to be the only place
	// the bit was checked — so a user whose CONNECT_VOICE was revoked
	// mid-session kept minting fresh SFU room-join grants, and a block imposed
	// mid-session (OC-0018) kept re-issuing one for the blocker's DM. Refusing
	// alone would leave the live session in place, so the refusal also evicts:
	// LeaveVoice runs handleVoiceLeave, which clears the client's voice state,
	// deletes the voice_states row and removes the LiveKit participant. Fails
	// closed: a deleted channel or a lookup failure is a refusal too.
	ch, chErr := d.Reader.GetChannel(ctx, channelID)
	if chErr != nil || ch == nil {
		return Result{
			Error:      ClientError{Code: ErrCodeForbidden, Message: "missing CONNECT_VOICE permission"},
			LeaveVoice: true,
		}
	}
	sub, subErr := channelSubject(ctx, d.Reader, d.Permissions, d.PermSvc, userID, ch, true)
	if subErr != nil {
		return Result{
			Error:      ClientError{Code: ErrCodeForbidden, Message: "missing CONNECT_VOICE permission"},
			LeaveVoice: true,
		}
	}
	if joinErr := permissions.CanJoinVoice(sub); joinErr != nil {
		return Result{Error: joinDenial(joinErr), LeaveVoice: true}
	}

	// With a PermissionService these three are cache hits after the gate above
	// populated the user's entry — the refresh drops from ~9 DB reads to at
	// most one channel-row lookup.
	canPublish := hasPerm(ctx, d.Reader, d.Permissions, d.PermSvc, userID, channelID, permissions.SpeakVoice)
	canSubscribe := true
	canVideo := hasPerm(ctx, d.Reader, d.Permissions, d.PermSvc, userID, channelID, permissions.UseVideo)
	canScreenShare := hasPerm(ctx, d.Reader, d.Permissions, d.PermSvc, userID, channelID, permissions.ShareScreen)

	joinToken := info.VoiceJoinToken
	var result Result
	if joinToken == "" {
		state, stateErr := d.Voice.State(ctx, userID)
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
func (h *Hub) rollbackVoiceJoin(ctx context.Context, c *Client, channelID int64, joinedAt string, broadcast bool) {
	// OC-0219: use clearVoiceAndUnsubscribe (not the bare clearVoiceChID) so a
	// join that already reached voiceJoinComplete's h.pubsub.Subscribe call
	// drops its VoiceTopic subscription along with its in-memory voiceChID —
	// exactly like every other path that takes a client out of voice while its
	// WS stays up (see clearVoiceAndUnsubscribe's doc comment in
	// voice_leave.go). Safe for the two earlier call sites too:
	// Unsubscribe is a documented no-op when the client was never subscribed
	// to that topic (pubsub.go), which is the case whenever this fires before
	// voiceJoinComplete's Subscribe has run.
	h.clearVoiceAndUnsubscribe(c)
	// The client's voice state is now set before token generation (BUG-088),
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
		if _, err := h.voice.LeaveIfMatch(rbCtx, c.userID, channelID, joinedAt); err != nil {
			slog.Error("ws rollbackVoiceJoin LeaveIfMatch", "err", err,
				"user_id", c.userID, "channel_id", channelID)
		}
	}
	if broadcast {
		h.broadcastVoiceEventWithLeaver(ctx, channelID, buildVoiceLeave(channelID, c.userID), c.userID)
	}
}
