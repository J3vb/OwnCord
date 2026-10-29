// Package httperr writes the standard JSON error reply,
// {"error": CODE, "message": text}, for HTTP handlers outside api and admin
// (the plugin asset server, the LiveKit webhook, the WebSocket upgrade), so
// every error the server answers has the same shape as a REST error.
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
func Write(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body{Error: code, Message: msg}); err != nil {
		slog.Error("httperr: failed to encode error reply", "error", err)
	}
}
