package ws

import (
	"log/slog"

	"nhooyr.io/websocket"
)

// OriginAcceptOptions builds a *websocket.AcceptOptions that enforces origin
// checking according to the provided allowed-origins list.
//
// Rules:
//   - nil or empty list  → InsecureSkipVerify = false (deny all cross-origin; safe default)
//   - list contains "*"  → InsecureSkipVerify = true  (explicit opt-in for any origin)
//   - any other list     → OriginPatterns set to the list; origin checking active
//
// The Tauri desktop client uses a Rust WS proxy that does not send an Origin
// header, so the default deny-all does not block desktop connections.
// Set allowed_origins: ["*"] in config to explicitly allow any origin.
func OriginAcceptOptions(allowedOrigins []string) *websocket.AcceptOptions {
	if len(allowedOrigins) == 0 {
		slog.Info("ws: no allowed_origins configured — denying cross-origin connections (safe default)")
		return &websocket.AcceptOptions{InsecureSkipVerify: false}
	}

	for _, o := range allowedOrigins {
		if o == "*" {
			slog.Warn("ws: allowed_origins contains wildcard '*' — accepting connections from ANY origin (insecure)")
			return &websocket.AcceptOptions{InsecureSkipVerify: true}
		}
	}

	return &websocket.AcceptOptions{
		OriginPatterns: allowedOrigins,
	}
}
