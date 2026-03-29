package ws

import "encoding/json"

// registerVoiceHandlers registers all voice-related message handlers.
// The handler methods themselves live in voice_join.go, voice_leave.go,
// voice_controls.go, and voice_broadcast.go — this function only wires
// them into the registry.
func registerVoiceHandlers(r *HandlerRegistry) {
	r.Register(MsgTypeVoiceJoin, func(h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceJoin(c, payload)
	})
	r.Register(MsgTypeVoiceLeave, func(h *Hub, c *Client, _ string, _ json.RawMessage) {
		h.handleVoiceLeave(c)
	})
	r.Register(MsgTypeVoiceTokenRefresh, func(h *Hub, c *Client, _ string, _ json.RawMessage) {
		h.handleVoiceTokenRefresh(c)
	})
	r.Register(MsgTypeVoiceMute, func(h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceMute(c, payload)
	})
	r.Register(MsgTypeVoiceDeafen, func(h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceDeafen(c, payload)
	})
	r.Register(MsgTypeVoiceCamera, func(h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceCamera(c, payload)
	})
	r.Register(MsgTypeVoiceScreenshare, func(h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceScreenshare(c, payload)
	})
}
