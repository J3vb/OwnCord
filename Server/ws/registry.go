package ws

import (
	"context"
	"fmt"
	"log/slog"
	"runtime"
)

// handlerV2Entry pairs a V2 handler with its domain-specific dependency struct.
type handlerV2Entry struct {
	handler HandlerV2
	deps    any // concrete deps struct for this handler's domain
}

// HandlerRegistry maps message type strings to their typed V2 handlers.
// It is not safe for concurrent use after initialization; all RegisterV2
// calls must happen before any DispatchV2 calls.
type HandlerRegistry struct {
	handlersV2 map[string]handlerV2Entry
}

// NewHandlerRegistry creates an empty handler registry.
func NewHandlerRegistry() *HandlerRegistry {
	return &HandlerRegistry{
		handlersV2: make(map[string]handlerV2Entry),
	}
}

// RegisterV2 registers a V2 handler for the given command type.
// PANICS if cmdType is already registered (duplicate guard).
func (r *HandlerRegistry) RegisterV2(cmdType string, handler HandlerV2, deps any) {
	if _, exists := r.handlersV2[cmdType]; exists {
		panic(fmt.Sprintf("RegisterV2: cmdType %q already registered", cmdType))
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
