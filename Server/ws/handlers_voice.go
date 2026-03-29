package ws

import (
	"context"
	"encoding/json"
)

// registerVoiceHandlers registers all voice-related message handlers.
// The handler methods themselves live in voice_join.go, voice_leave.go,
// voice_controls.go, and voice_broadcast.go — this function only wires
// them into the registry.
func registerVoiceHandlers(r *HandlerRegistry) {
	r.Register(MsgTypeVoiceJoin, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceJoin(ctx, c, payload)
	})
	r.Register(MsgTypeVoiceLeave, func(ctx context.Context, h *Hub, c *Client, _ string, _ json.RawMessage) {
		h.handleVoiceLeave(ctx, c)
	})
	r.Register(MsgTypeVoiceTokenRefresh, func(ctx context.Context, h *Hub, c *Client, _ string, _ json.RawMessage) {
		h.handleVoiceTokenRefresh(ctx, c)
	})
	r.Register(MsgTypeVoiceMute, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceMute(ctx, c, payload)
	})
	r.Register(MsgTypeVoiceDeafen, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceDeafen(ctx, c, payload)
	})
	r.Register(MsgTypeVoiceCamera, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceCamera(ctx, c, payload)
	})
	r.Register(MsgTypeVoiceScreenshare, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceScreenshare(ctx, c, payload)
	})
}
