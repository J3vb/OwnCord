package ws

import (
	"log/slog"

	"nhooyr.io/websocket"
)

// OriginAcceptOptions builds a *websocket.AcceptOptions that enforces origin
// checking according to the provided allowed-origins list.
//
// Rules:
//   - nil or empty list  → InsecureSkipVerify = true  (same as the old default)
//   - list contains "*"  → InsecureSkipVerify = true  (explicit opt-in)
//   - any other list     → OriginPatterns set to the list; origin checking active
//
// The wildcard cases preserve backward compatibility: if a deployment has not
// set allowed_origins the server continues to work exactly as before.
func OriginAcceptOptions(allowedOrigins []string) *websocket.AcceptOptions {
	if len(allowedOrigins) == 0 {
		slog.Warn("ws: no allowed_origins configured — accepting connections from ANY origin (insecure)")
		return &websocket.AcceptOptions{InsecureSkipVerify: true}
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
