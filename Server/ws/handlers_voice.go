package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/auth"
)

// registerVoiceControlsV2 registers the voice V2 handlers: control toggles, E2EE
// relays, token refresh and join/leave dispatch. handleVoiceJoin/handleVoiceLeave
// stay hub-internal (leave is also called un-throttled on disconnect and channel
// switch, join calls leave on a switch); only the message dispatch moved to V2.
func registerVoiceControlsV2(r *HandlerRegistry, deps VoiceDeps) {
	r.RegisterV2(MsgTypeVoiceJoin, handleVoiceJoinV2, deps)
	r.RegisterV2(MsgTypeVoiceLeave, handleVoiceLeaveV2, deps)
	r.RegisterV2(MsgTypeVoiceMute, handleVoiceMuteV2, deps)
	r.RegisterV2(MsgTypeVoiceDeafen, handleVoiceDeafenV2, deps)
	r.RegisterV2(MsgTypeVoiceCamera, handleVoiceCameraV2, deps)
	r.RegisterV2(MsgTypeVoiceScreenshare, handleVoiceScreenshareV2, deps)
	r.RegisterV2(MsgTypeVoiceE2EEAnnounce, handleVoiceE2EEAnnounceV2, deps)
	r.RegisterV2(MsgTypeVoiceE2EEOffer, handleVoiceE2EEOfferV2, deps)
	r.RegisterV2(MsgTypeVoiceWatch, handleVoiceWatchV2, deps)
	r.RegisterV2(MsgTypeVoiceTokenRefresh, handleVoiceTokenRefreshV2, deps)
	registerVoiceModerationV2(r, deps)
}

// handleVoiceJoinV2 hands off to the hub's handleVoiceJoin via the applier; the
// rate limit and side effects live there, and it re-reads channel_id from the
// validated payload.
func handleVoiceJoinV2(_ context.Context, _ Command, _ ClientInfo, _ any) Result {
	return Result{JoinVoice: true}
}

// handleVoiceLeaveV2 rate-limits only the explicit client leave
// (disconnect/switch callers must never be throttled), then hands off to
// handleVoiceLeave.
func handleVoiceLeaveV2(_ context.Context, cmd Command, _ ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	ratKey := auth.Key("voice_leave", cmd.UserID())
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceLeaveRateLimit, voiceLeaveWindow) {
		// LeaveVoice stays set on this refusal: a client that already tore down
		// its local session must not be left with server state pointing at the
		// channel. handleVoiceLeave is a no-op when the client is not in voice,
		// so spurious refusals cost nothing.
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many voice leave attempts"}, LeaveVoice: true, LeaveVoiceReason: voiceLeaveReasonClient}
	}
	return Result{LeaveVoice: true, LeaveVoiceReason: voiceLeaveReasonClient}
}
