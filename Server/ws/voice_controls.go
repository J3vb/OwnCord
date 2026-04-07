package ws

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/owncord/server/permissions"
)

// handleVoiceMuteV2 processes a voice_mute command.
func handleVoiceMuteV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	muteCmd := cmd.(VoiceMuteCmd)
	userID := info.UserID

	ratKey := fmt.Sprintf("voice_mute:%d", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceMuteRateLimit, voiceMuteWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many mute toggles"}}
	}

	if info.VoiceChannelID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	if err := d.DB.UpdateVoiceMute(userID, muteCmd.Muted()); err != nil {
		slog.Error("ws handleVoiceMuteV2 UpdateVoiceMute", "err", err, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update mute state"}}
	}
	slog.Debug("voice mute changed", "user_id", userID, "muted", muteCmd.Muted(), "channel_id", info.VoiceChannelID)

	return voiceStateBroadcast(d, userID)
}

// handleVoiceDeafenV2 processes a voice_deafen command.
func handleVoiceDeafenV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	deafenCmd := cmd.(VoiceDeafenCmd)
	userID := info.UserID

	ratKey := fmt.Sprintf("voice_deafen:%d", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceDeafenRateLimit, voiceDeafenWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many deafen toggles"}}
	}

	if info.VoiceChannelID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	if err := d.DB.UpdateVoiceDeafen(userID, deafenCmd.Deafened()); err != nil {
		slog.Error("ws handleVoiceDeafenV2 UpdateVoiceDeafen", "err", err, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update deafen state"}}
	}
	slog.Debug("voice deafen changed", "user_id", userID, "deafened", deafenCmd.Deafened(), "channel_id", info.VoiceChannelID)

	return voiceStateBroadcast(d, userID)
}

// handleVoiceCameraV2 processes a voice_camera command.
func handleVoiceCameraV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	cameraCmd := cmd.(VoiceCameraCmd)
	userID := info.UserID
	voiceChID := info.VoiceChannelID

	ratKey := fmt.Sprintf("voice_camera:%d", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceCameraRateLimit, voiceCameraWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many camera toggles"}}
	}

	if voiceChID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	// Permission check.
	if r := requirePerm(d.DB, d.Permissions, userID, voiceChID, permissions.UseVideo, "USE_VIDEO"); r != nil {
		return *r
	}

	enabled := cameraCmd.Enabled()

	// Enforce MaxVideo limit when enabling camera using an atomic check-and-update.
	if enabled {
		ch, chErr := d.DB.GetChannel(voiceChID)
		if chErr == nil && ch != nil && ch.VoiceMaxVideo > 0 {
			ok, limitErr := d.DB.EnableCameraIfUnderLimit(userID, voiceChID, ch.VoiceMaxVideo)
			if limitErr != nil {
				slog.Error("handleVoiceCameraV2 EnableCameraIfUnderLimit", "err", limitErr, "channel_id", voiceChID)
				return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to check video limit"}}
			}
			if !ok {
				return Result{Error: ClientError{
					Code:    ErrCodeVideoLimit,
					Message: fmt.Sprintf("maximum %d video streams reached", ch.VoiceMaxVideo),
				}}
			}
		} else {
			if err := d.DB.UpdateVoiceCamera(userID, true); err != nil {
				slog.Error("ws handleVoiceCameraV2 UpdateVoiceCamera", "err", err, "user_id", userID)
				return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update camera state"}}
			}
		}
	} else {
		if err := d.DB.UpdateVoiceCamera(userID, false); err != nil {
			slog.Error("ws handleVoiceCameraV2 UpdateVoiceCamera", "err", err, "user_id", userID)
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update camera state"}}
		}
	}
	slog.Debug("voice camera changed", "user_id", userID, "enabled", enabled, "channel_id", voiceChID)

	return voiceStateBroadcast(d, userID)
}

// handleVoiceScreenshareV2 processes a voice_screenshare command.
func handleVoiceScreenshareV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	ssCmd := cmd.(VoiceScreenshareCmd)
	userID := info.UserID
	voiceChID := info.VoiceChannelID

	ratKey := fmt.Sprintf("voice_screenshare:%d", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceScreenshareRateLimit, voiceScreenshareWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many screenshare toggles"}}
	}

	if voiceChID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	// Permission check.
	if r := requirePerm(d.DB, d.Permissions, userID, voiceChID, permissions.ShareScreen, "SHARE_SCREEN"); r != nil {
		return *r
	}

	if err := d.DB.UpdateVoiceScreenshare(userID, ssCmd.Enabled()); err != nil {
		slog.Error("ws handleVoiceScreenshareV2 UpdateVoiceScreenshare", "err", err, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update screenshare state"}}
	}
	slog.Debug("voice screenshare changed", "user_id", userID, "enabled", ssCmd.Enabled(), "channel_id", voiceChID)

	return voiceStateBroadcast(d, userID)
}

// voiceStateBroadcast reads the current voice state from DB and returns a
// BroadcastAll event. Shared by all voice control V2 handlers.
func voiceStateBroadcast(d VoiceDeps, userID int64) Result {
	state, err := d.DB.GetVoiceState(userID)
	if err != nil {
		slog.Error("ws voiceStateBroadcast GetVoiceState", "err", err, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to broadcast voice state update"}}
	}
	if state == nil {
		return Result{} // not in voice — nothing to broadcast
	}
	return Result{Events: []Event{VoiceStateEvent{payload: buildVoiceState(*state)}}}
}
