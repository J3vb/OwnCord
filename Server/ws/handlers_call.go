package ws

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// Ringing is rate limited per user, not per (user, channel): the abuse is
// spamming someone with call banners, and a per-channel key would let one user
// ring five DMs a second.
const (
	callRingRateLimit = 1
	callRingWindow    = 3 * time.Second
)

// registerCallHandlers registers the DM call signalling handlers. There is
// deliberately no server call state: a "call" is someone present in the DM's
// voice channel (voice_state already says so) and a ring is a transient nudge; a
// call row could dangle after a client crash.
func registerCallHandlers(r *HandlerRegistry, deps CallDeps) {
	r.RegisterV2(MsgTypeCallRing, handleCallRingV2, deps)
	r.RegisterV2(MsgTypeCallDecline, handleCallDeclineV2, deps)
}

// handleCallRingV2 forwards a call_ring to the DM's other participants as
// call_incoming. Only a participant may ring; a targeted event to an offline user
// is a no-op.
func handleCallRingV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(CallDeps)
	ringCmd := cmd.(CallRingCmd)

	ratKey := auth.Key("call_ring", info.UserID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, callRingRateLimit, callRingWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many call attempts"}}
	}

	targets, err := d.DMSvc.RingTargets(ctx, info.UserID, ringCmd.ChannelID)
	if err != nil {
		return serviceErrorToResult(err)
	}

	// A ring from someone not in the DM's voice channel would let the callee
	// accept a call that does not exist. Checked after RingTargets so non-
	// participant, block and timeout refusals keep their own codes.
	if info.VoiceChannelID != ringCmd.ChannelID {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "join the call before ringing"}}
	}

	payload := buildCallSignal(MsgTypeCallIncoming, ringCmd.ChannelID, info.UserID, info.Username)
	events := make([]Event, 0, 2*len(targets))
	// A callee who had closed the DM gets it back before the ring, as in a chat
	// send, so the client already has the channel.
	reopens := d.DMSvc.OpenForRing(ctx, ringCmd.ChannelID, targets)
	for i := range reopens {
		events = append(events, DMChannelOpenEvent{
			targetUserID: reopens[i].UserID,
			payload:      buildJSON(wsMsg{Type: MsgTypeDMChannelOpen, Payload: reopens[i].Summary}),
		})
	}
	for _, pid := range targets {
		events = append(events, CallSignalEvent{
			eventType:    MsgTypeCallIncoming,
			targetUserID: pid,
			payload:      payload,
		})
	}
	return Result{Events: events}
}

// handleCallDeclineV2 tells the DM's other participants the caller is not picking
// up. Addressed to everyone else because there is no call state to say who was
// ringing; advisory, ignored by a client already answered. It also reaches the
// decliner's own call_sync sockets, so a device of theirs still ringing stops.
func handleCallDeclineV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(CallDeps)
	declineCmd := cmd.(CallDeclineCmd)

	// Same cost shape as call_ring, so the same limit.
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("call_decline", info.UserID), callRingRateLimit, callRingWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many call actions"}}
	}

	targets, err := d.DMSvc.DeclineTargets(ctx, info.UserID, declineCmd.ChannelID)
	if err != nil {
		return serviceErrorToResult(err)
	}

	payload := buildCallSignal(MsgTypeCallDeclined, declineCmd.ChannelID, info.UserID, info.Username)
	events := make([]Event, 0, len(targets)+1)
	for _, pid := range targets {
		events = append(events, CallSignalEvent{
			eventType:    MsgTypeCallDeclined,
			targetUserID: pid,
			payload:      payload,
		})
	}
	// The decliner's other signed-in devices stop ringing too. The declining
	// socket may get it as well; its client has already ended that ring.
	events = append(events, CallSignalEvent{
		eventType:    MsgTypeCallDeclined,
		targetUserID: info.UserID,
		payload:      payload,
		ownDevices:   true,
	})
	return Result{Events: events}
}

// CallDeps holds dependencies for the DM call signalling handlers.
type CallDeps struct {
	Limiter *auth.RateLimiter
	DMSvc   *service.DMService
}
