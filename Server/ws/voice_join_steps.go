package ws

import (
	"context"
	"errors"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// voiceJoinPersist commits the join under capacity, reads the row back and publishes the
// client's in-memory voice state. False once the error frame has been sent.
func (h *Hub) voiceJoinPersist(fctx, ctx context.Context, txn *voiceTxn, c *Client, capacity int, channelID int64, reqID string) (*db.VoiceState, bool) {
	// Only voiceJoinPrecheck's moderator decision or a same-channel take-over can select the
	// unchecked insert for a capped channel. persistJoin sets the voice channel once the row
	// is confirmed, before the token mint; a later failure unwinds via rollbackVoiceJoin.
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

// voiceJoinPersistWithModFlags commits the join and re-applies the moderator mute/deafen
// that predates it, both under one hold of the moderation lock when there are flags, so a
// moderator's change never lands between the two. False once the error frame has been sent.
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

// voiceJoinRestoreModFlags re-applies a moderator mute/deafen that predates a channel
// switch and returns the state to broadcast. No SFU mute: MuteParticipant resolves the
// participant in the destination room and no token is minted yet, so it could only fail
// after a LiveKit round trip on the read pump. The persisted server_muted blocks the
// target's own unmute and is re-applied at the SFU on the moderator's next action.
func (h *Hub) voiceJoinRestoreModFlags(ctx context.Context, c *Client, channelID int64, state *db.VoiceState, wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64) *db.VoiceState {
	if refreshed := h.voice.RestoreModFlags(ctx, c.userID, channelID, wasServerMuted, wasServerDeafened, wasServerMutedBy); refreshed != nil {
		return refreshed
	}
	return state
}

// voiceJoinPublishPerms derives the SFU publish permissions from role, so a client using
// direct_url cannot bypass them. Both branches fail closed: an unresolved role or override
// map yields no grants (admins bypass overrides, so a fetch error cannot demote them). The
// bare-hub fallback uses one HasChannelPermBatch fetch. afk: the AFK channel is listen-only
// whatever the role allows; token refresh and the SFU reconcile
// (updateVoiceParticipantPermissions) apply the same rule or they would hand the mic back.
func (h *Hub) voiceJoinPublishPerms(ctx context.Context, userID, channelID int64, afk bool) (canPublish, canVideo, canScreenShare bool) {
	if afk {
		return false, false, false
	}
	if h.perms != nil {
		canPublish = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.SpeakVoice)
		canVideo = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.UseVideo)
		canScreenShare = h.perms.HasChannelPerm(ctx, userID, channelID, permissions.ShareScreen)
	} else if role, roleErr := h.readers.Dispatch.GetMemberRoles(ctx, userID); roleErr == nil && role != nil {
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

// voiceJoinGrantToken mints the LiveKit credential and delivers it, withholding it if the
// join was superseded. granted is false once the join was abandoned; rolledBack is true
// only for this function's own rollback (a failed mint, announced to nobody).
func (h *Hub) voiceJoinGrantToken(ctx context.Context, txn *voiceTxn, c *Client, channelID int64, afk bool, state *db.VoiceState, reqID string) (granted, rolledBack bool) {
	// Token generation failure is fatal: roll back the DB join with broadcast=false (nobody was
	// told about the join yet, so no spurious voice_leave).
	if h.livekit != nil {
		canPublish, canVideo, canScreenShare := h.voiceJoinPublishPerms(ctx, c.userID, channelID, afk)
		// Moderator mute/deafen follows the session across moves; carry it into the SFU grant too,
		// since muting an existing track cannot stop a replacement mic track using this token.
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

		// A concurrent eviction (kick/move, revocation sweep, CleanupVoiceForChannel) can land
		// between c.setVoiceState and here: it deletes the row and clears the state, and
		// RemoveParticipant no-ops because this join never reached the SFU. Re-check right before the
		// credential leaves the process and withhold it if superseded, or the client would hold a
		// live RoomJoin credential for a dead membership.
		if curChID, curToken := c.voice.state(); curChID != channelID || curToken != state.JoinedAt {
			slog.Info("ws handleVoiceJoin: join superseded before token delivery",
				"user_id", c.userID, "channel_id", channelID, "current_channel_id", curChID)
			// Best-effort defense in depth. Async: the voice lock is held and no LiveKit RPC runs under it.
			h.removeLiveKitParticipantAsync(ctx, channelID, c.userID, state.JoinedAt, "handleVoiceJoin supersession")
			return false, false
		}
		// Send the proxy path and, on loopback, the direct URL (avoids self-signed TLS issues with
		// WebView fetch). is_key_holder tells the client whether to start key distribution (keys
		// are exchanged client-side via ECDH).
		isKeyHolder := h.computeIsKeyHolder(channelID, c.userID)
		c.sendMsg(buildVoiceToken(channelID, token, "/livekit", h.livekit.URL(), isKeyHolder))
	}

	return true, false
}

// voiceJoinComplete finishes a join that survived every guard: topic subscription,
// key-holder election, voice_state fan-out, existing states and E2EE keys, voice_config.
// completed is false when superseded or rolled back; rolledBack is true only for this
// function's own rollback (the row is gone, its flags back on the client for the retry).
func (h *Hub) voiceJoinComplete(ctx context.Context, txn *voiceTxn, c *Client, ch *db.Channel, channelID int64, state *db.VoiceState, reqID string) (completed, rolledBack bool) {
	// Tail guard: a concurrent eviction (revocation sweep, participant_left webhook, moderator
	// kick/move) can land after the commit; completing here would resurrect a membership
	// deliberately torn down, so the evictor wins. markCompleted checks the instance atomically
	// with recording completion. registerNow relies on the flag being set only for a join that
	// reached this point: a reconnect transfers voice state solely when it is true, so an
	// in-flight join is never handed off (its guards would misread that as an eviction and
	// orphan the row).
	if !txn.markCompleted(c, channelID, state.JoinedAt) {
		curChID, _ := c.voice.state()
		slog.Info("ws handleVoiceJoin: join superseded before completion",
			"user_id", c.userID, "channel_id", channelID, "current_channel_id", curChID)
		return false, false
	}

	h.updateKeyHolder(channelID)
	// A callee joining the call on any device answers its ring: their phone stops ringing.
	h.ringAnswered(ctx, channelID, c.userID)

	// Sent synchronously (sendVoiceEventSync) so it lands in program order on the joiner's
	// socket among the direct sends around it.
	h.sendVoiceEventSync(ctx, channelID, c.userID, buildVoiceState(*state))

	// This is the only place a new voice_join relays an existing participant's ECDH key to a
	// joiner. Swallowing an error would leave the joiner blind and its E2EE exchange timing out
	// ~15s later, so treat it like every post-commit failure: rollback, error frame, and the
	// compensating voice_leave.
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
	// Relay every other participant's ECDH key and identity signature; shared with the resume
	// path (registerNow) because voice_e2ee_announce is unsequenced and no replay tier recovers it.
	h.sendVoicePeerKeys(c, channelID)
	h.sendVoicePeerWatching(c, channelID)

	// voice.quality config is the only source; there is no per-channel override.
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
