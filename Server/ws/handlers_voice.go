package ws

import (
	"context"
	"fmt"
)

// registerVoiceControlsV2 registers all voice V2 handlers: the control toggles,
// E2EE relays, token refresh, and the join/leave dispatch.
//
// voice_join and voice_leave return a Result that triggers the hub's
// handleVoiceJoin / handleVoiceLeave routines via the applier in handleMessage.
// Those routines stay hub-internal: handleVoiceLeave is also called un-throttled
// on disconnect and channel-switch (serve.go, voice_join.go), and handleVoiceJoin
// is a large, hub-coupled sequence that itself calls handleVoiceLeave on a switch.
// Only the message dispatch moved to V2, not the imperative effect.
func registerVoiceControlsV2(r *HandlerRegistry, deps VoiceDeps) {
	r.RegisterV2(MsgTypeVoiceJoin, handleVoiceJoinV2, deps)
	r.RegisterV2(MsgTypeVoiceLeave, handleVoiceLeaveV2, deps)
	r.RegisterV2(MsgTypeVoiceMute, handleVoiceMuteV2, deps)
	r.RegisterV2(MsgTypeVoiceDeafen, handleVoiceDeafenV2, deps)
	r.RegisterV2(MsgTypeVoiceCamera, handleVoiceCameraV2, deps)
	r.RegisterV2(MsgTypeVoiceScreenshare, handleVoiceScreenshareV2, deps)
	r.RegisterV2(MsgTypeVoiceE2EEAnnounce, handleVoiceE2EEAnnounceV2, deps)
	r.RegisterV2(MsgTypeVoiceE2EEOffer, handleVoiceE2EEOfferV2, deps)
	r.RegisterV2(MsgTypeVoiceTokenRefresh, handleVoiceTokenRefreshV2, deps)
}

// handleVoiceJoinV2 gates parsing via the VoiceJoinCmd constructor (which
// rejects a malformed or non-positive channel_id with a BAD_REQUEST) and hands
// off to the hub's handleVoiceJoin routine via the applier. The rate-limit and
// all side effects live in handleVoiceJoin, which re-reads channel_id from the
// already-validated envelope payload.
func handleVoiceJoinV2(_ context.Context, _ Command, _ ClientInfo, _ any) Result {
	return Result{JoinVoice: true}
}

// handleVoiceLeaveV2 rate-limits the explicit client-initiated leave (the
// disconnect/switch callers of handleVoiceLeave must never be throttled) and
// then hands off to the hub's handleVoiceLeave routine via the applier.
func handleVoiceLeaveV2(_ context.Context, cmd Command, _ ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	ratKey := fmt.Sprintf("voice_leave:%d", cmd.UserID())
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceLeaveRateLimit, voiceLeaveWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many voice leave attempts"}}
	}
	return Result{LeaveVoice: true}
}
