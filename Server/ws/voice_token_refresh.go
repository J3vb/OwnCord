package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// handleVoiceTokenRefreshV2 generates a fresh LiveKit token for a client already in a voice channel.
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

	// Re-run the join gate where the credential is minted (permissions.CanStayInVoice:
	// CanJoinVoice minus the timeout, which only blocks a new join). The channel comes from the
	// client's own session state and only voice_join used to check the gate, so a user whose
	// CONNECT_VOICE was revoked mid-session kept minting room-join grants, and a mid-session
	// block kept re-issuing one for the blocker's DM. Refusing alone would leave the live
	// session, so the refusal also evicts (LeaveVoice -> handleVoiceLeave). Fails closed: a
	// deleted channel or lookup failure is a refusal too.
	ch, chErr := d.Reader.GetChannel(ctx, channelID)
	if chErr != nil || ch == nil {
		return Result{
			Error:            ClientError{Code: ErrCodeForbidden, Message: "missing permission to join this voice channel"},
			LeaveVoice:       true,
			LeaveVoiceReason: voiceLeaveReasonTokenRefresh,
		}
	}
	sub, subErr := channelSubject(ctx, d.Reader, d.Permissions, d.PermSvc, userID, ch, true)
	if subErr != nil {
		return Result{
			Error:            ClientError{Code: ErrCodeForbidden, Message: "missing permission to join this voice channel"},
			LeaveVoice:       true,
			LeaveVoiceReason: voiceLeaveReasonTokenRefresh,
		}
	}
	// A timeout does not evict a member already in the room; the token still carries their server-mute
	// (state.ServerMuted below).
	if joinErr := permissions.CanStayInVoice(sub); joinErr != nil {
		return Result{Error: joinDenial(joinErr), LeaveVoice: true, LeaveVoiceReason: voiceLeaveReasonTokenRefresh}
	}

	// A cached join token identifies the session but does not capture a moderator's current
	// mute/deafen. Always read the persisted flags before minting, and refuse when the
	// membership cannot be read.
	state, stateErr := d.Voice.State(ctx, userID)
	if stateErr != nil || state == nil || state.ChannelID != channelID {
		slog.Error("ws handleVoiceTokenRefreshV2 GetVoiceState", "err", stateErr, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to refresh voice token"}}
	}

	// With a PermissionService these are cache hits after the gate populated the user's entry.
	// Microphone moderation is independent of camera/screenshare permissions.
	canPublish := voiceMicrophoneAllowed(hasPerm(ctx, d.Reader, d.Permissions, d.PermSvc, userID, channelID, permissions.SpeakVoice), state)
	canVideo := hasPerm(ctx, d.Reader, d.Permissions, d.PermSvc, userID, channelID, permissions.UseVideo)
	canScreenShare := hasPerm(ctx, d.Reader, d.Permissions, d.PermSvc, userID, channelID, permissions.ShareScreen)
	if ch.AFK {
		// The AFK channel is listen-only: a refresh must not re-grant what the join withheld.
		canPublish, canVideo, canScreenShare = false, false, false
	}

	joinToken := info.VoiceJoinToken
	var result Result
	if joinToken == "" {
		joinToken = state.JoinedAt
		result.SetVoiceJoinToken = &joinToken
	}

	token, err := d.TokenGen.GenerateToken(userID, info.Username, channelID, joinToken, canPublish, canVideo, canScreenShare)
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
