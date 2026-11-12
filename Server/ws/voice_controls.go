package ws

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// voiceSelfToggle parameterises voice_mute and voice_deafen so a fix cannot land on one and not the other
// (the asymmetric moderator gate).
type voiceSelfToggle struct {
	rateKey    string // auth.Key namespace, "voice_mute" / "voice_deafen"
	rateLimit  int
	rateWindow time.Duration
	rateMsg    string
	// serverDeafen picks which moderator flag refuseIfServerSilenced consults: false = ServerMuted (blocks
	// self-unmute), true = ServerDeafened (blocks self-undeafen).
	serverDeafen bool
	update       func(ctx context.Context, userID int64, on bool) error
	updateLog    string // slog.Error message when update fails
	failMsg      string
	changedLog   string // slog.Debug message once applied
	stateKey     string // slog key carrying the new value
}

func voiceSelfToggleV2(ctx context.Context, d VoiceDeps, info ClientInfo, on bool, t voiceSelfToggle) Result {
	userID := info.UserID

	ratKey := auth.Key(t.rateKey, userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, t.rateLimit, t.rateWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: t.rateMsg}}
	}

	if info.VoiceChannelID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	// A moderator-imposed mute/deafen is not the user's to lift. Only the clearing direction reads the row;
	// silencing oneself is always allowed.
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

	return voiceStateBroadcast(context.WithoutCancel(ctx), d, userID)
}

func handleVoiceMuteV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	muteCmd := cmd.(VoiceMuteCmd)
	return voiceSelfToggleV2(ctx, d, info, muteCmd.Muted, voiceSelfToggle{
		rateKey:      "voice_mute",
		rateLimit:    voiceMuteRateLimit,
		rateWindow:   voiceMuteWindow,
		rateMsg:      "too many mute toggles",
		serverDeafen: false,
		update:       func(ctx context.Context, userID int64, on bool) error { return d.Voice.SetSelfMute(ctx, userID, on) },
		updateLog:    "ws handleVoiceMuteV2 UpdateVoiceMute",
		failMsg:      "failed to update mute state",
		changedLog:   "voice mute changed",
		stateKey:     "muted",
	})
}

func handleVoiceDeafenV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	deafenCmd := cmd.(VoiceDeafenCmd)
	return voiceSelfToggleV2(ctx, d, info, deafenCmd.Deafened, voiceSelfToggle{
		rateKey:      "voice_deafen",
		rateLimit:    voiceDeafenRateLimit,
		rateWindow:   voiceDeafenWindow,
		rateMsg:      "too many deafen toggles",
		serverDeafen: true,
		update:       func(ctx context.Context, userID int64, on bool) error { return d.Voice.SetSelfDeafen(ctx, userID, on) },
		updateLog:    "ws handleVoiceDeafenV2 UpdateVoiceDeafen",
		failMsg:      "failed to update deafen state",
		changedLog:   "voice deafen changed",
		stateKey:     "deafened",
	})
}

// voiceStreamToggle parameterises voice_camera and voice_screenshare: both draw from one
// per-channel voice_max_video budget, which broke when the two paths drifted apart.
type voiceStreamToggle struct {
	rateKey    string // auth.Key namespace, "voice_camera" / "voice_screenshare"
	rateLimit  int
	rateWindow time.Duration
	rateMsg    string
	perm       int64  // permission required to ENABLE the stream
	permLabel  string // its name, for the refusal
	// tryReserve is the atomic under-cap check-and-set for this stream's column; update is the
	// plain unconditional write. Both go to enableVideoSlot, which owns the shared-budget rule.
	// Handlers fill them with closures over the deps, not method values off d.Voice: a method
	// value evaluates its receiver where written, so a bare VoiceDeps fixture would fault at
	// handler entry instead of at the write the handler may never reach.
	tryReserve func(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)
	update     func(ctx context.Context, userID int64, enabled bool) error
	logPrefix  string // handler name, for slog messages
	kind       string // "camera" / "screenshare", used in operator-facing text
	disableLog string // slog.Error message when the disable update fails
	changedLog string // slog.Debug message once applied
}

// voiceStreamToggleV2 is the shared body of handleVoiceCameraV2 and handleVoiceScreenshareV2.
// Only the enable direction is gated on the permission (like mute/deafen): once a moderator
// revokes it mid-call the user must still be able to turn the stream off, or
// voice_states.camera / screenshare stays stuck at 1 (camera permanently burns a
// voice_max_video slot; screenshare advertises a stream nobody can watch).
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
		if r := requirePerm(ctx, d.Reader, d.Permissions, d.PermSvc, userID, voiceChID, t.perm, t.permLabel); r != nil {
			return *r
		}
		// Enforce the shared voice_max_video budget atomically: enableVideoSlot counts camera = 1 OR
		// screenshare = 1 rows, so neither kind occupies a slot meant to be denied or hides from the other's
		// count.
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

	return voiceStateBroadcast(context.WithoutCancel(ctx), d, userID)
}

func handleVoiceCameraV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	cameraCmd := cmd.(VoiceCameraCmd)
	return voiceStreamToggleV2(ctx, d, info, cameraCmd.Enabled, voiceStreamToggle{
		rateKey:    "voice_camera",
		rateLimit:  voiceCameraRateLimit,
		rateWindow: voiceCameraWindow,
		rateMsg:    "too many camera toggles",
		perm:       permissions.UseVideo,
		permLabel:  "USE_VIDEO",
		tryReserve: func(ctx context.Context, userID, chID int64, max int) (bool, error) {
			return d.Voice.ReserveCamera(ctx, userID, chID, max)
		},
		update:     func(ctx context.Context, userID int64, on bool) error { return d.Voice.SetCamera(ctx, userID, on) },
		logPrefix:  "handleVoiceCameraV2",
		kind:       "camera",
		disableLog: "ws handleVoiceCameraV2 UpdateVoiceCamera",
		changedLog: "voice camera changed",
	})
}

func handleVoiceScreenshareV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	ssCmd := cmd.(VoiceScreenshareCmd)
	return voiceStreamToggleV2(ctx, d, info, ssCmd.Enabled, voiceStreamToggle{
		rateKey:    "voice_screenshare",
		rateLimit:  voiceScreenshareRateLimit,
		rateWindow: voiceScreenshareWindow,
		rateMsg:    "too many screenshare toggles",
		perm:       permissions.ShareScreen,
		permLabel:  "SHARE_SCREEN",
		tryReserve: func(ctx context.Context, userID, chID int64, max int) (bool, error) {
			return d.Voice.ReserveScreenshare(ctx, userID, chID, max)
		},
		update:     func(ctx context.Context, userID int64, on bool) error { return d.Voice.SetScreenshare(ctx, userID, on) },
		logPrefix:  "handleVoiceScreenshareV2",
		kind:       "screenshare",
		disableLog: "ws handleVoiceScreenshareV2 UpdateVoiceScreenshare",
		changedLog: "voice screenshare changed",
	})
}

// enableVideoSlot enforces the shared voice_max_video budget before a camera or screenshare
// enable. tryReserve is the atomic check-and-update for the field being enabled;
// unconditionalSet applies the plain update when the channel has no cap.
func enableVideoSlot(
	ctx context.Context,
	d VoiceDeps,
	userID, voiceChID int64,
	tryReserve func(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error),
	unconditionalSet func(ctx context.Context, userID int64, enabled bool) error,
	logPrefix, kind string,
) *Result {
	ch, chErr := d.Reader.GetChannel(ctx, voiceChID)
	if chErr != nil || ch == nil {
		// Fail closed: an unreadable OR missing channel row is not "no cap configured"; the
		// unconditional enable would bypass the limit. GetChannel returns (nil, nil) for a channel
		// deleted mid-call, which must refuse like the error case.
		slog.Error("ws enableVideoSlot GetChannel", "handler", logPrefix, "err", chErr, "channel_id", voiceChID)
		return &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to check video limit"}}
	}
	if ch.VoiceMaxVideo > 0 {
		ok, limitErr := tryReserve(ctx, userID, voiceChID, ch.VoiceMaxVideo)
		if limitErr != nil {
			slog.Error("ws enableVideoSlot EnableIfUnderLimit", "handler", logPrefix, "err", limitErr, "channel_id", voiceChID)
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
		slog.Error("ws enableVideoSlot unconditional enable", "handler", logPrefix, "kind", kind, "err", err, "user_id", userID)
		return &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update " + kind + " state"}}
	}
	return nil
}

// refuseIfServerSilenced refuses a self-unmute (deafen=false) or self-undeafen (deafen=true)
// while the matching moderator flag is set. A read error is reported as INTERNAL, not as a
// permission-shaped refusal.
func refuseIfServerSilenced(ctx context.Context, d VoiceDeps, userID int64, deafen bool) *Result {
	state, err := d.Voice.State(ctx, userID)
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

// voiceStateBroadcast reads the current voice state from the DB and returns a BroadcastAll event.
func voiceStateBroadcast(ctx context.Context, d VoiceDeps, userID int64) Result {
	state, err := d.Voice.State(ctx, userID)
	if err != nil {
		slog.Error("ws voiceStateBroadcast GetVoiceState", "err", err, "user_id", userID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to broadcast voice state update"}}
	}
	if state == nil {
		return Result{} // not in voice — nothing to broadcast
	}
	return Result{Events: []Event{VoiceStateEvent{
		voiceChannelID: state.ChannelID,
		userID:         userID,
		payload:        buildVoiceState(*state),
	}}}
}
