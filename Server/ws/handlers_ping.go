package ws

import (
	"context"
	"encoding/json"
)

// registerPingHandler registers the ping/pong handler.
func registerPingHandler(r *HandlerRegistry) {
	r.Register(MsgTypePing, func(_ context.Context, _ *Hub, c *Client, _ string, _ json.RawMessage) {
		c.sendMsg(buildJSON(map[string]any{"type": MsgTypePong}))
	})
}
