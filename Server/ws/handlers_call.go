package ws

import (
	"context"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/service"
)

// Ringing is rate limited per user rather than per (user, channel): the abuse
// it exists to stop is spamming *someone* with call banners, and a per-channel
// key would let one user ring five different DMs a second. One ring every three
// seconds is far below what a human does and far above what a redial costs.
const (
	callRingRateLimit = 1
	callRingWindow    = 3 * time.Second
)

// registerCallHandlers registers the DM call signalling handlers.
//
// There is deliberately no call state on the server. A "call" in a DM is
// nothing more than somebody being present in that DM's voice channel — which
// voice_state already broadcasts — and a ring is a transient nudge to come
// look. Persisting a call row would add a thing that a crashed client can
// leave dangling, in exchange for information the presence already carries.
func registerCallHandlers(r *HandlerRegistry, deps CallDeps) {
	r.RegisterV2(MsgTypeCallRing, handleCallRingV2, deps)
	r.RegisterV2(MsgTypeCallDecline, handleCallDeclineV2, deps)
}

// handleCallRingV2 forwards a call_ring to the DM's other participants as
// call_incoming. Only a participant of the DM may ring it; the fan-out reaches
// whichever of them are connected, because a targeted event to an offline user
// is a no-op by construction.
func handleCallRingV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(CallDeps)
	ringCmd := cmd.(CallRingCmd)

	ratKey := auth.Key("call_ring", info.UserID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, callRingRateLimit, callRingWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many call attempts"}}
	}

	targets, err := d.DMSvc.RingTargets(ctx, info.UserID, ringCmd.ChannelID())
	if err != nil {
		return serviceErrorToResult(err)
	}

	payload := buildCallSignal(MsgTypeCallIncoming, ringCmd.ChannelID(), info.UserID, info.Username)
	events := make([]Event, 0, len(targets))
	for _, pid := range targets {
		events = append(events, CallSignalEvent{
			eventType:    MsgTypeCallIncoming,
			targetUserID: pid,
			payload:      payload,
		})
	}
	return Result{Events: events}
}

// handleCallDeclineV2 tells the DM's other participants that the caller is not
// picking up, so a ringing client can stop ringing before the 30s timeout.
//
// It is addressed to every other participant rather than to "the ringer"
// because the server does not know who that was — no call state, by design —
// and in a group DM more than one person may be ringing anyway. The decline is
// advisory: a client that has already been answered ignores it.
func handleCallDeclineV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(CallDeps)
	declineCmd := cmd.(CallDeclineCmd)

	// Same cost shape as call_ring (participant + block lookups, fan-out to
	// every other participant), so it carries the same limit.
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("call_decline", info.UserID), callRingRateLimit, callRingWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many call actions"}}
	}

	targets, err := d.DMSvc.RingTargets(ctx, info.UserID, declineCmd.ChannelID())
	if err != nil {
		return serviceErrorToResult(err)
	}

	payload := buildCallSignal(MsgTypeCallDeclined, declineCmd.ChannelID(), info.UserID, info.Username)
	events := make([]Event, 0, len(targets))
	for _, pid := range targets {
		events = append(events, CallSignalEvent{
			eventType:    MsgTypeCallDeclined,
			targetUserID: pid,
			payload:      payload,
		})
	}
	return Result{Events: events}
}

// CallDeps holds dependencies for the DM call signalling handlers.
type CallDeps struct {
	Limiter *auth.RateLimiter
	DMSvc   *service.DMService
}
