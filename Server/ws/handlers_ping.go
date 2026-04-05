package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// registerPingHandler registers the ping/pong handler.
func registerPingHandler(r *HandlerRegistry) {
	r.Register(MsgTypePing, func(_ context.Context, h *Hub, c *Client, _ string, _ json.RawMessage) {
		if !h.limiter.Allow(fmt.Sprintf("ping:%d", c.userID), 2, time.Second) {
			return
		}
		c.sendMsg(buildJSON(map[string]any{"type": MsgTypePong}))
	})
}
