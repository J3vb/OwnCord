package ws

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/service"
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
	// Rate limit: voice_join broadcasts a voice_state update to every connected
	// client, so cap how often a single user can trigger the fan-out. Mirrors the
	// Limiter.Allow(...) idiom used by the voice control handlers.
	ratKey := auth.Key("voice_join", c.userID)
	if h.limiter != nil && !h.limiter.Allow(ratKey, voiceJoinRateLimit, voiceJoinWindow) {
		c.sendMsg(buildErrorMsg(ErrCodeRateLimited, "too many voice join attempts"))
		return
	}

	channelID, err := parseChannelID(payload)
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "channel_id must be a positive integer"))
		return
	}

	// channel_id is attacker-controlled, so the gate must be channel-TYPE aware:
	// a role-only check passes for any DM channel id (DMs have no overrides), and
	// the token minted below carries RoomJoin+CanSubscribe for that DM's room.
	if !h.requireChannelAccess(ctx, c, channelID, permissions.ConnectVoice, "CONNECT_VOICE") {
		return
	}

	// Validate the target channel exists before any state changes (leaving
	// the current voice channel, persisting join, etc.).
	ch, err := h.db.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		c.sendMsg(buildErrorMsg(ErrCodeNotFound, "channel not found"))
		return
	}

	// channel_id is attacker-controlled and requireChannelAccess above only
	// gates CONNECT_VOICE, which says nothing about channel type — a text or
	// announcement channel would otherwise accept a join, persist a
	// voice_states row, mint a LiveKit room and broadcast voice_state for a
	// channel the UI can never render or moderate. 'dm' stays allowed: DM and
	// group voice calls join through this same handler.
	if ch.Type != "voice" && ch.Type != "dm" {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "not a voice channel"))
		return
	}

	// A blocked user is still a DM participant — blocking never touches
	// dm_participants (service/block.go), so the CONNECT_VOICE + IsDMParticipant
	// gate above passes them straight through into the blocker's DM voice room.
	// Every other 1:1-DM interaction sink (send, edit, react, pin, typing,
	// call_ring) already routes through this same check
	// (service.requireDMNotBlocked); voice was the one gap. Group DMs are
	// exempt inside it, matching every other sink. h.db satisfies
	// service.Store directly, so no MessageService wiring is needed here.
	if ch.Type == "dm" {
		if err := service.RequireDMNotBlocked(ctx, h.db, c.userID, channelID); err != nil {
			c.sendMsg(buildErrorMsg(ErrCodeForbidden, "cannot join voice: blocked"))
			return
		}
	}

	// Archived channels are hidden from every client and their voice states are
	// dropped from `ready`, but `archived` was consulted only by the visibility
	// predicate — so a caller still holding the id could join the room of a
	// channel nobody can see or moderate. Refuse the join outright; the sibling
	// archive transition also evicts whoever is already inside.
	if ch.Archived {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "channel is archived"))
		return
	}

	// Ensure authenticated user is present before any state changes.
	// This guard covers all downstream paths (LiveKit configured or not)
	// that dereference c.user (e.g. c.user.Username in the success log).
	if c.user == nil {
		slog.Error("handleVoiceJoin: nil user on client", "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "not authenticated"))
		return
	}

	// Hard-fail when LiveKit is not configured — without an SFU the client
	// cannot connect to voice, so persisting state would create a ghost.
	if h.livekit == nil {
		c.sendMsg(buildErrorMsg(ErrCodeVoiceError, "voice is not configured on this server"))
		return
	}

	// Guard: reject voice join if the companion LiveKit process is not running
	// (e.g. crashed 10 times and gave up).
	if h.lkProcess != nil && !h.lkProcess.IsRunning() {
		slog.Warn("handleVoiceJoin: LiveKit process not running", "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeVoiceError, "voice is temporarily unavailable — LiveKit is not running"))
		return
	}

	currentChID := c.getVoiceChID()

	// If user is already in the same voice channel, no-op.
	if currentChID == channelID {
		c.sendMsg(buildErrorMsg(ErrCodeAlreadyJoined, "already in this voice channel"))
		return
	}

	// A moderator-imposed mute/deafen must survive a channel switch.
	// voice.sql's ON CONFLICT branch preserves server_muted/server_deafened
	// across a plain re-join, but the switch below deletes the row via
	// handleVoiceLeave and lets JoinVoiceChannel(IfCapacity) re-insert it, so
	// that branch is never reached: the flags are snapshotted here and
	// reapplied once the new row exists.
	//
	// This covers the self-switch only. voice_mod_move deletes the row on the
	// moderator's goroutine (DisconnectFromVoice) before the target's client
	// re-joins, so by the time this handler runs there is nothing left to read
	// and currentChID is already 0 — preserving the flags across a move needs
	// state that outlives the row (see the cross-batch note on v029).
	var wasServerMuted, wasServerDeafened bool
	if currentChID > 0 {
		if prevState, prevErr := h.db.GetVoiceState(ctx, c.userID); prevErr == nil && prevState != nil {
			wasServerMuted = prevState.ServerMuted
			wasServerDeafened = prevState.ServerDeafened
		}
	}

	// If user is already in a different voice channel, leave it first.
	if currentChID > 0 {
		h.handleVoiceLeave(ctx, c)

		// BUG-088: Verify old voice state is actually cleared before joining
		// the new channel. If the DB delete failed (retry still running in
		// background), the old row persists and JoinVoiceChannelIfCapacity's
		// COUNT(*) may produce an incorrect result. Fail the switch so the
		// user can retry cleanly.
		vs, err := h.db.GetVoiceState(ctx, c.userID)
		if err != nil {
			slog.Warn("handleVoiceJoin: could not verify voice state cleared",
				"user_id", c.userID, "err", err)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice channel switch failed — please try again"))
			return
		}
		if vs != nil {
			slog.Warn("handleVoiceJoin: stale voice state persists after leave, aborting switch",
				"user_id", c.userID, "stale_channel", vs.ChannelID, "target_channel", channelID)
			// Restore client voice state so the user knows they're still in the
			// old channel. The failed leave already dropped the voice-topic
			// subscription and key-holder entry, and voice state and topic
			// subscription must move as a pair (see clearVoiceAndUnsubscribe)
			// — without them the restored session silently misses every
			// voice_e2ee relay for its channel.
			c.setVoiceState(vs.ChannelID, vs.JoinedAt)
			h.pubsub.Subscribe(c, VoiceTopic(vs.ChannelID))
			h.updateKeyHolder(vs.ChannelID)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice channel switch failed — please try again"))
			return
		}
	}

	// Check channel capacity and persist to DB atomically.
	maxUsers := ch.VoiceMaxUsers
	if maxUsers > 0 {
		if err := h.db.JoinVoiceChannelIfCapacity(ctx, c.userID, channelID, maxUsers); err != nil {
			if errors.Is(err, db.ErrChannelFull) {
				c.sendMsg(buildErrorMsg(ErrCodeChannelFull, "voice channel is full"))
				return
			}
			slog.Error("ws handleVoiceJoin JoinVoiceChannelIfCapacity", "err", err, "user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to join voice channel"))
			return
		}
	} else {
		// No capacity limit — use standard join.
		if err := h.db.JoinVoiceChannel(ctx, c.userID, channelID); err != nil {
			slog.Error("ws handleVoiceJoin JoinVoiceChannel", "err", err, "user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to join voice channel"))
			return
		}
	}

	// Load the persisted row immediately so later cleanup can target this exact
	// join instance even if the user rejoins the same channel.
	state, err := h.db.GetVoiceState(ctx, c.userID)
	if err != nil || state == nil {
		slog.Error("ws handleVoiceJoin GetVoiceState", "err", err, "user_id", c.userID)
		h.rollbackVoiceJoin(ctx, c, channelID, "", false)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to join voice channel"))
		return
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

	// Restore a moderator-imposed mute/deafen that predates this switch (see
	// the snapshot above). Best-effort: a failure here is logged but does not
	// fail the join, matching every other SetVoiceServerMute/Deafen call site.
	if wasServerMuted || wasServerDeafened {
		if wasServerMuted {
			if err := h.db.SetVoiceServerMute(ctx, c.userID, true); err != nil {
				slog.Error("ws handleVoiceJoin SetVoiceServerMute (restore)", "err", err, "user_id", c.userID)
			}
		}
		if wasServerDeafened {
			if err := h.db.SetVoiceServerDeafen(ctx, c.userID, true); err != nil {
				slog.Error("ws handleVoiceJoin SetVoiceServerDeafen (restore)", "err", err, "user_id", c.userID)
			}
		}
		// Re-read so the voice_state broadcast below carries the restored
		// flags rather than the plain-insert defaults — that broadcast is what
		// makes the mute effective on the target's own client and visible to
		// everyone else.
		//
		// No SFU mute is applied here: MuteParticipantAudio resolves the
		// participant in the destination room first, and this join has not even
		// minted its token yet, so the call could only fail (after a LiveKit
		// round trip on the read pump). As everywhere else in the voice
		// moderation path, the persisted server_muted is the authority — it
		// blocks the target's own unmute and is re-applied at the SFU whenever
		// the moderator next acts.
		if refreshed, refErr := h.db.GetVoiceState(ctx, c.userID); refErr == nil && refreshed != nil {
			state = refreshed
		}
	}

	// Generate LiveKit token if LiveKit client is available.
	// Token generation failure is fatal — without a token the client cannot
	// connect to the SFU, so we must roll back the DB join.
	// NOTE: the joiner's own state was already set above (BUG-088), but
	// nobody else has been told about the join yet — rollbackVoiceJoin below
	// is still called with broadcast=false, so a failure here does not
	// broadcast a spurious voice_leave for a join no other client ever saw.
	if h.livekit != nil {
		// Derive publish permissions from role — prevents SFU-level bypass
		// when client connects directly via direct_url (BUG-128). With a
		// PermissionService the three bits come from the per-user cache; the
		// bare-hub fallback answers them from one role fetch + one overrides
		// fetch via HasChannelPermBatch instead of three hasChannelPerm round
		// trips. Both branches fail closed: an unresolved role or override map
		// yields no publish grants (admins bypass overrides, so an override
		// fetch error cannot demote them).
		var canPublish, canVideo, canScreenShare bool
		canSubscribe := true
		if h.perms != nil {
			// PermissionService answers all three bits from one cached
			// role+overrides snapshot (populated by the CONNECT_VOICE gate
			// above, so these are cache hits). Same fail-closed posture: an
			// unresolved role or override map yields no publish grants.
			canPublish = h.perms.HasChannelPerm(ctx, c.userID, channelID, permissions.SpeakVoice)
			canVideo = h.perms.HasChannelPerm(ctx, c.userID, channelID, permissions.UseVideo)
			canScreenShare = h.perms.HasChannelPerm(ctx, c.userID, channelID, permissions.ShareScreen)
		} else if role, roleErr := h.db.GetRoleForUser(ctx, c.userID); roleErr == nil && role != nil {
			// Admins bypass overrides, so skip the fetch for them (mirrors
			// computeAllowedChannels); HasChannelPermBatch answers true from
			// the role bits alone.
			var overrides map[int64]db.ChannelOverride
			var oErr error
			if !permissions.HasAdmin(role.Permissions) {
				overrides, oErr = h.db.GetChannelOverridesFor(ctx, role.ID, c.userID)
			}
			if oErr == nil {
				po := permOverrides(overrides)
				canPublish = h.permChecker.HasChannelPermBatch(role.Permissions, po, channelID, permissions.SpeakVoice)
				canVideo = h.permChecker.HasChannelPermBatch(role.Permissions, po, channelID, permissions.UseVideo)
				canScreenShare = h.permChecker.HasChannelPermBatch(role.Permissions, po, channelID, permissions.ShareScreen)
			}
		}
		token, tokenErr := h.livekit.GenerateToken(c.userID, c.user.Username, channelID, state.JoinedAt, canPublish, canSubscribe, canVideo, canScreenShare)
		if tokenErr != nil {
			slog.Error("ws handleVoiceJoin GenerateToken", "err", tokenErr, "user_id", c.userID)
			h.rollbackVoiceJoin(ctx, c, channelID, state.JoinedAt, false)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to generate voice token"))
			return
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

	// Voice channel state itself was already set above (BUG-088), immediately
	// after the DB row committed — which also means a concurrent eviction (the
	// revocation sweep, a participant_left webhook, a moderator kick/move) can
	// now land on THIS join instance while the token round trip above is in
	// flight. Those all clear the client's voice state and delete the row after
	// deciding against it, so completing the join here would resurrect a
	// membership that was deliberately torn down: subscribed to the voice
	// topic and broadcast as present, with no row behind it. Their decision
	// wins; a same-instance state is the only thing this join may finish.
	if curChID, curToken := c.getVoiceState(); curChID != channelID || curToken != state.JoinedAt {
		slog.Info("ws handleVoiceJoin: join superseded before completion",
			"user_id", c.userID, "channel_id", channelID, "current_channel_id", curChID)
		return
	}

	// Subscribe to voice topic for voice-scoped events.
	h.pubsub.Subscribe(c, VoiceTopic(channelID))

	// Update key holder map now that this client's voice state is set.
	h.updateKeyHolder(channelID)

	// Broadcast the joiner's state to the clients allowed to see this channel.
	h.broadcastVoiceEvent(ctx, channelID, buildVoiceState(*state))

	// Send existing channel voice states to the joiner.
	existing, err := h.db.GetChannelVoiceStates(ctx, channelID)
	if err != nil {
		slog.Error("ws handleVoiceJoin GetChannelVoiceStates", "err", err)
		return
	}
	for _, vs := range existing {
		if vs.UserID == c.userID {
			continue
		}
		c.sendMsg(buildVoiceState(vs))
		// Send existing participant's ECDH public key (and its identity
		// signature, F3 TOFU) so the joiner can participate in the
		// client-side E2EE key exchange.
		if pubKey, sig := h.getClientE2EEPubKey(vs.UserID); pubKey != "" {
			c.sendMsg(buildVoiceE2EEAnnounce(vs.UserID, pubKey, sig))
		}
	}

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

	// Re-check CONNECT_VOICE where the credential is minted. The channel comes
	// from the client's own session state, and voice_join (voice_join.go:61) was
	// the only place this bit was ever checked — so a user whose CONNECT_VOICE
	// was revoked mid-session kept minting fresh SFU room-join grants. Refusing
	// alone would leave the live session in place, so the refusal also evicts:
	// LeaveVoice runs handleVoiceLeave, which clears the client's voice state,
	// deletes the voice_states row and removes the LiveKit participant.
	// Channel-type aware, like the voice_join gate: this mints the same
	// RoomJoin+CanSubscribe credential, so a role-only check here would keep
	// re-issuing one for a DM the user is not a participant of.
	if !hasChannelAccess(ctx, d.DB, d.Permissions, d.PermSvc, userID, channelID, permissions.ConnectVoice) {
		return Result{
			Error:      ClientError{Code: ErrCodeForbidden, Message: "missing CONNECT_VOICE permission"},
			LeaveVoice: true,
		}
	}

	// Same block gate as voice_join (voice_join.go, OC-0018): a block imposed
	// mid-session must not let the refresh keep minting a fresh SFU credential
	// for a DM the other participant has since blocked. RequireDMNotBlocked is
	// a safe no-op for a non-DM channelID (no dm_participants row to match), so
	// this needs no channel-type fetch of its own. d.DB satisfies service.Store
	// directly.
	if err := service.RequireDMNotBlocked(ctx, d.DB, userID, channelID); err != nil {
		return Result{
			Error:      ClientError{Code: ErrCodeForbidden, Message: "cannot refresh voice token: blocked"},
			LeaveVoice: true,
		}
	}

	// With a PermissionService these three are cache hits after the gate above
	// populated the user's entry — the refresh drops from ~9 DB reads to at
	// most one channel-row lookup.
	canPublish := hasPerm(ctx, d.DB, d.Permissions, d.PermSvc, userID, channelID, permissions.SpeakVoice)
	canSubscribe := true
	canVideo := hasPerm(ctx, d.DB, d.Permissions, d.PermSvc, userID, channelID, permissions.UseVideo)
	canScreenShare := hasPerm(ctx, d.DB, d.Permissions, d.PermSvc, userID, channelID, permissions.ShareScreen)

	joinToken := info.VoiceJoinToken
	var result Result
	if joinToken == "" {
		state, stateErr := d.DB.GetVoiceState(ctx, userID)
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
	c.clearVoiceChID()
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
		if state, err := h.db.GetVoiceState(rbCtx, c.userID); err == nil && state != nil && state.ChannelID == channelID {
			joinedAt = state.JoinedAt
		}
	}
	if joinedAt != "" {
		if _, err := h.db.LeaveVoiceChannelIfMatch(rbCtx, c.userID, channelID, joinedAt); err != nil {
			slog.Error("ws rollbackVoiceJoin LeaveVoiceChannelIfMatch", "err", err,
				"user_id", c.userID, "channel_id", channelID)
		}
	}
	if broadcast {
		h.broadcastVoiceEvent(ctx, channelID, buildVoiceLeave(channelID, c.userID))
	}
}
