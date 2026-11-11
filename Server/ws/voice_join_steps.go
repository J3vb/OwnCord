package ws

import (
	"context"
	"errors"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// voiceJoinPersist commits the join under capacity, reads the row back and
// publishes the client's in-memory voice state. Returns false once the error
// frame has been sent.
func (h *Hub) voiceJoinPersist(fctx, ctx context.Context, txn *voiceTxn, c *Client, capacity int, channelID int64, reqID string) (*db.VoiceState, bool) {
	// The service picks the capacity-checked insert from capacity. Two callers pass
	// 0 for a capped channel: voiceJoinPrecheck's moderator decision, and a
	// same-channel take-over, which re-takes the slot it just freed under the member
	// lock (handleVoiceJoinFrame). persistJoin sets the client's voice channel as soon as the row
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

// voiceJoinPersistWithModFlags commits the join and re-applies the moderator
// mute/deafen that predates it. With flags to re-apply, the insert and the
// restore share one hold of the moderation lock every mute and unmute writes
// under: a moderator's change lands before the row exists (and is told the
// member is not there) or after the row carries the flags, never between the
// two where the restore would overwrite it. A join with nothing to re-apply
// takes no extra lock. Returns false once the error frame has been sent.
func (h *Hub) voiceJoinPersistWithModFlags(fctx, ctx context.Context, txn *voiceTxn, c *Client, capacity int, channelID int64, reqID string, flags modFlagStash) (*db.VoiceState, bool) {
	if flags.muted || flags.deafened {
		unlockMod := h.voiceHub.mod.Lock(c.userID)
		defer unlockMod()
	}
	state, ok := h.voiceJoinPersist(fctx, ctx, txn, c, capacity, channelID, reqID)
	if !ok {
		return nil, false
	}
	return h.voiceJoinRestoreModFlags(ctx, c, channelID, state, flags.muted, flags.deafened, flags.mutedBy), true
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
// if the join was superseded meanwhile. granted is false once the join was
// abandoned; rolledBack is true only for the rollback this function performed
// itself (a failed mint, announced to nobody, the row's flags back on the
// client). A superseded join returns false, false: the evictor that won
// announced its end.
func (h *Hub) voiceJoinGrantToken(ctx context.Context, txn *voiceTxn, c *Client, channelID int64, afk bool, state *db.VoiceState, reqID string) (granted, rolledBack bool) {
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
			h.rollbackVoiceJoinKeepingModFlags(ctx, txn, c, channelID, state.JoinedAt,
				modFlagStash{muted: state.ServerMuted, deafened: state.ServerDeafened, mutedBy: state.ServerMutedBy}, false)
			c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "failed to generate voice token", reqID))
			return false, true
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
			return false, false
		}
		// Send the proxy path and, on loopback, the direct URL; the client prefers
		// direct_url on localhost (avoids self-signed TLS issues with WebView fetch).
		// is_key_holder tells the client whether to start key distribution (E2EE keys
		// are exchanged between clients via ECDH, not generated here).
		isKeyHolder := h.computeIsKeyHolder(channelID, c.userID)
		c.sendMsg(buildVoiceToken(channelID, token, "/livekit", h.livekit.URL(), isKeyHolder))
	}

	return true, false
}

// voiceJoinComplete finishes a join that survived every guard: topic
// subscription, key-holder election, the joiner's voice_state fan-out, existing
// participants' states and E2EE keys, and voice_config. Returns false when the
// join was superseded or rolled back; rolledBack is true only for the rollback
// this function performed itself (the row is gone and the flags it held are
// back on the client for the retry). A superseded join returns false with
// rolledBack false: the evictor that won owns the flags.
func (h *Hub) voiceJoinComplete(ctx context.Context, txn *voiceTxn, c *Client, ch *db.Channel, channelID int64, state *db.VoiceState, reqID string) (completed, rolledBack bool) {
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
		return false, false
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
		h.rollbackVoiceJoinKeepingModFlags(ctx, txn, c, channelID, state.JoinedAt,
			modFlagStash{muted: state.ServerMuted, deafened: state.ServerDeafened, mutedBy: state.ServerMutedBy}, true)
		c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "failed to join voice channel", reqID))
		return false, true
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

	// h.voiceHub.defaultQuality (voice.quality config) is the only source; no per-channel override exists.
	quality := h.voiceHub.defaultQuality
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
	return true, false
}
