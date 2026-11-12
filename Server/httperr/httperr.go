// Package httperr writes the standard JSON error reply {"error": CODE, "message": text} for handlers
// outside api and admin (plugin assets, LiveKit webhook, WebSocket upgrade), matching REST errors.
package httperr

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

type body struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// Write answers status with the JSON error envelope.
func Write(w http.ResponseWriter, status int, code Code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body{Error: string(code), Message: msg}); err != nil {
		slog.Error("httperr: failed to encode error reply", "error", err)
	}
}
