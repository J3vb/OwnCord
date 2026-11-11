package ws

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

func handlePingV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(PingDeps)
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("ping", info.UserID), 2, time.Second) {
		return Result{} // rate limited: silent drop
	}
	return Result{Reply: buildJSON(map[string]any{"type": MsgTypePong})}
}

func registerPingHandler(r *HandlerRegistry, deps PingDeps) {
	r.RegisterV2(MsgTypePing, handlePingV2, deps)
}
