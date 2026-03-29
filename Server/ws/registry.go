package ws

import (
	"context"
	"encoding/json"
)

// MessageHandler is the function signature for all WebSocket message handlers.
// It receives a context (derived from the client's WS connection), the hub,
// the sending client, the request ID from the envelope, and the raw JSON payload.
type MessageHandler func(ctx context.Context, h *Hub, c *Client, reqID string, payload json.RawMessage)

// HandlerRegistry maps message type strings to their handler functions.
// It is not safe for concurrent use after initialization; all Register
// calls must happen before any Dispatch calls.
type HandlerRegistry struct {
	handlers map[string]MessageHandler
}

// NewHandlerRegistry creates an empty handler registry.
func NewHandlerRegistry() *HandlerRegistry {
	return &HandlerRegistry{
		handlers: make(map[string]MessageHandler),
	}
}

// Register associates a message type with a handler function.
func (r *HandlerRegistry) Register(msgType string, handler MessageHandler) {
	r.handlers[msgType] = handler
}

// Dispatch looks up the handler for msgType and invokes it. Returns true if a
// handler was found and called, false if no handler is registered for the type.
func (r *HandlerRegistry) Dispatch(ctx context.Context, msgType string, h *Hub, c *Client, reqID string, payload json.RawMessage) bool {
	handler, ok := r.handlers[msgType]
	if !ok {
		return false
	}
	handler(ctx, h, c, reqID, payload)
	return true
}

// RegisteredTypes returns all registered message types (unordered).
// Intended for testing and diagnostics.
func (r *HandlerRegistry) RegisteredTypes() []string {
	types := make([]string, 0, len(r.handlers))
	for t := range r.handlers {
		types = append(types, t)
	}
	return types
}
