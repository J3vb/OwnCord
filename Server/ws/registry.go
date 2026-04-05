package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"runtime"
)

// MessageHandler is the function signature for all WebSocket message handlers.
// It receives a context (derived from the client's WS connection), the hub,
// the sending client, the request ID from the envelope, and the raw JSON payload.
type MessageHandler func(ctx context.Context, h *Hub, c *Client, reqID string, payload json.RawMessage)

// handlerV2Entry pairs a V2 handler with its domain-specific dependency struct.
type handlerV2Entry struct {
	handler HandlerV2
	deps    any // concrete deps struct for this handler's domain
}

// HandlerRegistry maps message type strings to their handler functions.
// It is not safe for concurrent use after initialization; all Register
// calls must happen before any Dispatch calls.
type HandlerRegistry struct {
	handlers   map[string]MessageHandler // V1 — unchanged
	handlersV2 map[string]handlerV2Entry // V2 — new
}

// NewHandlerRegistry creates an empty handler registry.
func NewHandlerRegistry() *HandlerRegistry {
	return &HandlerRegistry{
		handlers:   make(map[string]MessageHandler),
		handlersV2: make(map[string]handlerV2Entry),
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

// RegisterV2 registers a V2 handler for the given command type.
// PANICS if cmdType is already registered in V1 (shadowing guard) or V2 (duplicate guard).
// The shadowing guard prevents accidentally having both V1 and V2 handlers for the
// same type. When migrating a handler, remove V1 registration BEFORE adding V2.
func (r *HandlerRegistry) RegisterV2(cmdType string, handler HandlerV2, deps any) {
	if _, exists := r.handlers[cmdType]; exists {
		panic(fmt.Sprintf("RegisterV2: cmdType %q already registered in V1 (remove V1 first)", cmdType))
	}
	if _, exists := r.handlersV2[cmdType]; exists {
		panic(fmt.Sprintf("RegisterV2: cmdType %q already registered in V2", cmdType))
	}
	r.handlersV2[cmdType] = handlerV2Entry{handler: handler, deps: deps}
}

// DispatchV2 looks up a V2 handler and calls it.
// Returns (result, true) if found, (Result{}, false) if not.
// Recovers from panics (e.g. bad type assertions on cmd or deps) to prevent
// a single malformed message from crashing the entire server.
func (r *HandlerRegistry) DispatchV2(ctx context.Context, cmd Command, info ClientInfo) (result Result, ok bool) {
	entry, found := r.handlersV2[cmd.Type()]
	if !found {
		return Result{}, false
	}
	defer func() {
		if rec := recover(); rec != nil {
			buf := make([]byte, 4096)
			n := runtime.Stack(buf, false)
			// TODO: stack trace may contain sensitive function arguments
			// (e.g. encrypted keys). Consider scrubbing or limiting frames.
			slog.Error("DispatchV2 panic recovered",
				"type", cmd.Type(),
				"user_id", info.UserID,
				"panic", rec,
				"stack", string(buf[:n]),
			)
			result = Result{Error: ClientError{Code: ErrCodeInternal, Message: "internal error"}}
			ok = true
		}
	}()
	return entry.handler(ctx, cmd, info, entry.deps), true
}

// RegisteredV2Types returns all V2-registered message types (unordered).
// Intended for testing and diagnostics.
func (r *HandlerRegistry) RegisteredV2Types() []string {
	types := make([]string, 0, len(r.handlersV2))
	for t := range r.handlersV2 {
		types = append(types, t)
	}
	return types
}

// hasV2 reports whether a V2 handler is registered for msgType.
func (r *HandlerRegistry) hasV2(msgType string) bool {
	_, ok := r.handlersV2[msgType]
	return ok
}

// IsRegisteredV1 checks if a type is registered in the V1 map.
func (r *HandlerRegistry) IsRegisteredV1(msgType string) bool {
	_, ok := r.handlers[msgType]
	return ok
}
