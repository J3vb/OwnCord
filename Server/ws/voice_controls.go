package ws

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/permissions"
)

// handleVoiceMuteV2 processes a voice_mute command.
func handleVoiceMuteV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	muteCmd := cmd.(VoiceMuteCmd)
	userID := info.UserID

	ratKey := auth.Key("voice_mute", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceMuteRateLimit, voiceMuteWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many mute toggles"}}
	}

	if info.VoiceChannelID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	// A moderator-imposed mute is not the user's to lift. Only the unmute
	// direction reads the row: muting oneself is always allowed.
	if !muteCmd.Muted() {
		if r := refuseIfServerSilenced(ctx, d, userID, false); r != nil {
			return *r
		}
	}

	if err := d.DB.UpdateVoiceMute(ctx, userID, muteCmd.Muted()); err != nil {
		slog.Error("ws handleVoiceMuteV2 UpdateVoiceMute", "err", err, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update mute state"}}
	}
	slog.Debug("voice mute changed", "user_id", userID, "muted", muteCmd.Muted(), "channel_id", info.VoiceChannelID)

	return voiceStateBroadcast(ctx, d, userID)
}

// handleVoiceDeafenV2 processes a voice_deafen command.
func handleVoiceDeafenV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	deafenCmd := cmd.(VoiceDeafenCmd)
	userID := info.UserID

	ratKey := auth.Key("voice_deafen", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceDeafenRateLimit, voiceDeafenWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many deafen toggles"}}
	}

	if info.VoiceChannelID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	// See handleVoiceMuteV2: server deafen is the moderator's to lift.
	if !deafenCmd.Deafened() {
		if r := refuseIfServerSilenced(ctx, d, userID, true); r != nil {
			return *r
		}
	}

	if err := d.DB.UpdateVoiceDeafen(ctx, userID, deafenCmd.Deafened()); err != nil {
		slog.Error("ws handleVoiceDeafenV2 UpdateVoiceDeafen", "err", err, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update deafen state"}}
	}
	slog.Debug("voice deafen changed", "user_id", userID, "deafened", deafenCmd.Deafened(), "channel_id", info.VoiceChannelID)

	return voiceStateBroadcast(ctx, d, userID)
}

// handleVoiceCameraV2 processes a voice_camera command.
func handleVoiceCameraV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	cameraCmd := cmd.(VoiceCameraCmd)
	userID := info.UserID
	voiceChID := info.VoiceChannelID

	ratKey := auth.Key("voice_camera", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceCameraRateLimit, voiceCameraWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many camera toggles"}}
	}

	if voiceChID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	enabled := cameraCmd.Enabled()

	// Only the enable direction is gated on USE_VIDEO — mirrors
	// handleVoiceMuteV2/handleVoiceDeafenV2's asymmetric gate: once a
	// moderator revokes the permission mid-call, the user must still be able
	// to turn their camera off, or voice_states.camera stays stuck at 1 —
	// permanently burning a voice_max_video slot — until they leave voice,
	// since nothing else ever clears it.
	if enabled {
		if r := requirePerm(ctx, d.DB, d.Permissions, d.PermSvc, userID, voiceChID, permissions.UseVideo, "USE_VIDEO"); r != nil {
			return *r
		}
	}

	// Enforce MaxVideo limit when enabling camera using an atomic check-and-update.
	// Camera and screenshare draw from the same voice_max_video budget
	// (OC-0023), so this gate is shared with handleVoiceScreenshareV2 below.
	if enabled {
		if r := enableVideoSlot(ctx, d, userID, voiceChID, d.DB.EnableCameraIfUnderLimit, d.DB.UpdateVoiceCamera, "handleVoiceCameraV2", "camera"); r != nil {
			return *r
		}
	} else {
		if err := d.DB.UpdateVoiceCamera(ctx, userID, false); err != nil {
			slog.Error("ws handleVoiceCameraV2 UpdateVoiceCamera", "err", err, "user_id", userID)
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update camera state"}}
		}
	}
	slog.Debug("voice camera changed", "user_id", userID, "enabled", enabled, "channel_id", voiceChID)

	return voiceStateBroadcast(ctx, d, userID)
}

// handleVoiceScreenshareV2 processes a voice_screenshare command.
func handleVoiceScreenshareV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	ssCmd := cmd.(VoiceScreenshareCmd)
	userID := info.UserID
	voiceChID := info.VoiceChannelID

	ratKey := auth.Key("voice_screenshare", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceScreenshareRateLimit, voiceScreenshareWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many screenshare toggles"}}
	}

	if voiceChID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	enabled := ssCmd.Enabled()

	// Only the enable direction is gated on SHARE_SCREEN — mirrors
	// handleVoiceMuteV2/handleVoiceDeafenV2's asymmetric gate: once a
	// moderator revokes the permission mid-share, the user must still be able
	// to stop sharing, or voice_states.screenshare stays stuck at 1 — every
	// subsequent voice_state keeps advertising a stream nobody can watch —
	// until they leave voice.
	if enabled {
		if r := requirePerm(ctx, d.DB, d.Permissions, d.PermSvc, userID, voiceChID, permissions.ShareScreen, "SHARE_SCREEN"); r != nil {
			return *r
		}
	}

	// Enforce the same voice_max_video budget handleVoiceCameraV2 enforces —
	// camera and screenshare are both "video streams" against one cap
	// (OC-0023): a screenshare must not be able to occupy a slot the cap
	// intended to deny it, and must not be invisible to the camera gate's
	// count either (enableVideoSlot's atomic query counts both fields).
	if enabled {
		if r := enableVideoSlot(ctx, d, userID, voiceChID, d.DB.EnableScreenshareIfUnderLimit, d.DB.UpdateVoiceScreenshare, "handleVoiceScreenshareV2", "screenshare"); r != nil {
			return *r
		}
	} else {
		if err := d.DB.UpdateVoiceScreenshare(ctx, userID, false); err != nil {
			slog.Error("ws handleVoiceScreenshareV2 UpdateVoiceScreenshare", "err", err, "user_id", userID)
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update screenshare state"}}
		}
	}
	slog.Debug("voice screenshare changed", "user_id", userID, "enabled", enabled, "channel_id", voiceChID)

	return voiceStateBroadcast(ctx, d, userID)
}

// enableVideoSlot enforces the channel's shared voice_max_video budget
// before applying a camera or screenshare enable (OC-0023: camera and
// screenshare draw from the same per-channel slot count, so neither publish
// kind can bypass the cap by hiding from the other's count). tryReserve is
// the atomic check-and-update for the specific field being enabled —
// EnableCameraIfUnderLimit or EnableScreenshareIfUnderLimit, both of which
// count `camera = 1 OR screenshare = 1` rows against the cap. unconditionalSet
// applies the same field's plain update when the channel carries no cap.
func enableVideoSlot(
	ctx context.Context,
	d VoiceDeps,
	userID, voiceChID int64,
	tryReserve func(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error),
	unconditionalSet func(ctx context.Context, userID int64, enabled bool) error,
	logPrefix, kind string,
) *Result {
	ch, chErr := d.DB.GetChannel(ctx, voiceChID)
	if chErr != nil {
		// Fail closed: an unreadable channel row is not "no cap
		// configured" — falling through to the unconditional enable
		// bypasses the per-channel video limit.
		slog.Error(logPrefix+" GetChannel", "err", chErr, "channel_id", voiceChID)
		return &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to check video limit"}}
	}
	if ch != nil && ch.VoiceMaxVideo > 0 {
		ok, limitErr := tryReserve(ctx, userID, voiceChID, ch.VoiceMaxVideo)
		if limitErr != nil {
			slog.Error(logPrefix+" EnableIfUnderLimit", "err", limitErr, "channel_id", voiceChID)
			return &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to check video limit"}}
		}
		if !ok {
			return &Result{Error: ClientError{
				Code:    ErrCodeVideoLimit,
				Message: fmt.Sprintf("maximum %d video streams reached", ch.VoiceMaxVideo),
			}}
		}
		return nil
	}
	if err := unconditionalSet(ctx, userID, true); err != nil {
		slog.Error("ws "+logPrefix+" "+kind+" unconditional enable", "err", err, "user_id", userID)
		return &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update " + kind + " state"}}
	}
	return nil
}

// refuseIfServerSilenced refuses a self-unmute (deafen=false) or self-undeafen
// (deafen=true) while the corresponding moderator-imposed flag is set. A read
// error is not a denial: it is reported as INTERNAL so an operator sees it
// rather than the user seeing a permission-shaped refusal.
func refuseIfServerSilenced(ctx context.Context, d VoiceDeps, userID int64, deafen bool) *Result {
	state, err := d.DB.GetVoiceState(ctx, userID)
	if err != nil {
		slog.Error("ws refuseIfServerSilenced GetVoiceState", "err", err, "user_id", userID)
		return &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to read voice state"}}
	}
	if state == nil {
		return nil
	}
	if deafen && state.ServerDeafened {
		return &Result{Error: ClientError{
			Code:    ErrCodeServerDeafened,
			Message: "you were deafened by a moderator",
		}}
	}
	if !deafen && state.ServerMuted {
		return &Result{Error: ClientError{
			Code:    ErrCodeServerMuted,
			Message: "you were muted by a moderator",
		}}
	}
	return nil
}

// voiceStateBroadcast reads the current voice state from DB and returns a
// BroadcastAll event. Shared by all voice control V2 handlers.
func voiceStateBroadcast(ctx context.Context, d VoiceDeps, userID int64) Result {
	state, err := d.DB.GetVoiceState(ctx, userID)
	if err != nil {
		slog.Error("ws voiceStateBroadcast GetVoiceState", "err", err, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to broadcast voice state update"}}
	}
	if state == nil {
		return Result{} // not in voice — nothing to broadcast
	}
	return Result{Events: []Event{VoiceStateEvent{
		voiceChannelID: state.ChannelID,
		payload:        buildVoiceState(*state),
	}}}
}
