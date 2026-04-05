package ws

import (
	"context"
	"fmt"
	"time"
)

// handlePingV2 is the V2 handler for ping (heartbeat) messages.
// It rate-limits and returns a pong reply on success.
func handlePingV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PingDeps)
	if d.Limiter != nil && !d.Limiter.Allow(fmt.Sprintf("ping:%d", info.UserID), 2, time.Second) {
		return Result{} // rate limited: silent drop
	}
	return Result{Reply: buildJSON(map[string]any{"type": MsgTypePong})}
}

// registerPingHandler registers the ping/pong handler (V2).
func registerPingHandler(r *HandlerRegistry, deps PingDeps) {
	r.RegisterV2(MsgTypePing, handlePingV2, deps)
}
