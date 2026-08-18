package ws

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/permissions"
)

// voiceSelfToggle parameterises the two self-toggle handlers, voice_mute and
// voice_deafen. They were verbatim duplicates of each other, differing only in
// the fields below; a fix landing on one and not the other — the asymmetric
// moderator gate is exactly such a fix — is the failure mode this collapse
// removes.
type voiceSelfToggle struct {
	rateKey      string // auth.Key namespace, "voice_mute" / "voice_deafen"
	rateLimit    int
	rateWindow   time.Duration
	rateMsg      string
	serverDeafen bool // which moderator flag refuseIfServerSilenced consults
	update       func(ctx context.Context, userID int64, on bool) error
	updateLog    string // slog.Error message when update fails
	failMsg      string
	changedLog   string // slog.Debug message once applied
	stateKey     string // slog key carrying the new value
}

// voiceSelfToggleV2 is the shared body of handleVoiceMuteV2 and
// handleVoiceDeafenV2.
func voiceSelfToggleV2(ctx context.Context, d VoiceDeps, info ClientInfo, on bool, t voiceSelfToggle) Result {
	userID := info.UserID

	ratKey := auth.Key(t.rateKey, userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, t.rateLimit, t.rateWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: t.rateMsg}}
	}

	if info.VoiceChannelID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	// A moderator-imposed mute/deafen is not the user's to lift. Only the
	// clearing direction reads the row: silencing oneself is always allowed.
	if !on {
		if r := refuseIfServerSilenced(ctx, d, userID, t.serverDeafen); r != nil {
			return *r
		}
	}

	if err := t.update(ctx, userID, on); err != nil {
		slog.Error(t.updateLog, "err", err, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: t.failMsg}}
	}
	slog.Debug(t.changedLog, "user_id", userID, t.stateKey, on, "channel_id", info.VoiceChannelID)

	return voiceStateBroadcast(ctx, d, userID)
}

// handleVoiceMuteV2 processes a voice_mute command.
func handleVoiceMuteV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	muteCmd := cmd.(VoiceMuteCmd)
	return voiceSelfToggleV2(ctx, d, info, muteCmd.Muted(), voiceSelfToggle{
		rateKey:      "voice_mute",
		rateLimit:    voiceMuteRateLimit,
		rateWindow:   voiceMuteWindow,
		rateMsg:      "too many mute toggles",
		serverDeafen: false,
		update:       d.DB.UpdateVoiceMute,
		updateLog:    "ws handleVoiceMuteV2 UpdateVoiceMute",
		failMsg:      "failed to update mute state",
		changedLog:   "voice mute changed",
		stateKey:     "muted",
	})
}

// handleVoiceDeafenV2 processes a voice_deafen command.
func handleVoiceDeafenV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	deafenCmd := cmd.(VoiceDeafenCmd)
	return voiceSelfToggleV2(ctx, d, info, deafenCmd.Deafened(), voiceSelfToggle{
		rateKey:      "voice_deafen",
		rateLimit:    voiceDeafenRateLimit,
		rateWindow:   voiceDeafenWindow,
		rateMsg:      "too many deafen toggles",
		serverDeafen: true,
		update:       d.DB.UpdateVoiceDeafen,
		updateLog:    "ws handleVoiceDeafenV2 UpdateVoiceDeafen",
		failMsg:      "failed to update deafen state",
		changedLog:   "voice deafen changed",
		stateKey:     "deafened",
	})
}

// voiceStreamToggle parameterises the two video-stream handlers, voice_camera
// and voice_screenshare. Like the self-toggles above they were verbatim
// duplicates. Keeping them one function is not only tidier: camera and
// screenshare draw from a single per-channel voice_max_video budget (OC-0023),
// and that bug existed precisely because the two paths had drifted apart.
type voiceStreamToggle struct {
	rateKey    string // auth.Key namespace, "voice_camera" / "voice_screenshare"
	rateLimit  int
	rateWindow time.Duration
	rateMsg    string
	perm       int64  // permission required to ENABLE the stream
	permLabel  string // its name, for the refusal
	// tryReserve is the atomic under-cap check-and-set for this stream's
	// column; update is its plain unconditional write. Both are handed to
	// enableVideoSlot, which owns the shared-budget rule.
	tryReserve func(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)
	update     func(ctx context.Context, userID int64, enabled bool) error
	logPrefix  string // handler name, for slog messages
	kind       string // "camera" / "screenshare", used in operator-facing text
	disableLog string // slog.Error message when the disable update fails
	changedLog string // slog.Debug message once applied
}

// voiceStreamToggleV2 is the shared body of handleVoiceCameraV2 and
// handleVoiceScreenshareV2.
//
// Only the enable direction is gated on the permission — once a moderator
// revokes it mid-call the user must still be able to turn the stream off, or
// the column stays stuck at 1: for camera that permanently burns a
// voice_max_video slot, and for screenshare every subsequent voice_state keeps
// advertising a stream nobody can watch. Nothing else ever clears either one
// short of leaving voice.
func voiceStreamToggleV2(ctx context.Context, d VoiceDeps, info ClientInfo, enabled bool, t voiceStreamToggle) Result {
	userID := info.UserID
	voiceChID := info.VoiceChannelID

	ratKey := auth.Key(t.rateKey, userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, t.rateLimit, t.rateWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: t.rateMsg}}
	}

	if voiceChID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	if enabled {
		if r := requirePerm(ctx, d.DB, d.Permissions, d.PermSvc, userID, voiceChID, t.perm, t.permLabel); r != nil {
			return *r
		}
		// Enforce the channel's shared voice_max_video budget atomically.
		if r := enableVideoSlot(ctx, d, userID, voiceChID, t.tryReserve, t.update, t.logPrefix, t.kind); r != nil {
			return *r
		}
	} else {
		if err := t.update(ctx, userID, false); err != nil {
			slog.Error(t.disableLog, "err", err, "user_id", userID)
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update " + t.kind + " state"}}
		}
	}
	slog.Debug(t.changedLog, "user_id", userID, "enabled", enabled, "channel_id", voiceChID)

	return voiceStateBroadcast(ctx, d, userID)
}

// handleVoiceCameraV2 processes a voice_camera command.
func handleVoiceCameraV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	cameraCmd := cmd.(VoiceCameraCmd)
	return voiceStreamToggleV2(ctx, d, info, cameraCmd.Enabled(), voiceStreamToggle{
		rateKey:    "voice_camera",
		rateLimit:  voiceCameraRateLimit,
		rateWindow: voiceCameraWindow,
		rateMsg:    "too many camera toggles",
		perm:       permissions.UseVideo,
		permLabel:  "USE_VIDEO",
		tryReserve: d.DB.EnableCameraIfUnderLimit,
		update:     d.DB.UpdateVoiceCamera,
		logPrefix:  "handleVoiceCameraV2",
		kind:       "camera",
		disableLog: "ws handleVoiceCameraV2 UpdateVoiceCamera",
		changedLog: "voice camera changed",
	})
}

// handleVoiceScreenshareV2 processes a voice_screenshare command.
func handleVoiceScreenshareV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	ssCmd := cmd.(VoiceScreenshareCmd)
	return voiceStreamToggleV2(ctx, d, info, ssCmd.Enabled(), voiceStreamToggle{
		rateKey:    "voice_screenshare",
		rateLimit:  voiceScreenshareRateLimit,
		rateWindow: voiceScreenshareWindow,
		rateMsg:    "too many screenshare toggles",
		perm:       permissions.ShareScreen,
		permLabel:  "SHARE_SCREEN",
		tryReserve: d.DB.EnableScreenshareIfUnderLimit,
		update:     d.DB.UpdateVoiceScreenshare,
		logPrefix:  "handleVoiceScreenshareV2",
		kind:       "screenshare",
		disableLog: "ws handleVoiceScreenshareV2 UpdateVoiceScreenshare",
		changedLog: "voice screenshare changed",
	})
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
