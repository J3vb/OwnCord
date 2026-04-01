package admin

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

type errorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("writeJSON: failed to encode response", "error", err)
	}
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, errorResponse{Error: code, Message: msg})
}

func pathInt64(r *http.Request, param string) (int64, error) { //nolint:unparam // kept generic for future URL params
	raw := chi.URLParam(r, param)
	return strconv.ParseInt(raw, 10, 64)
}

// queryInt parses an integer query parameter with a minimum and maximum bound.
// Use minVal=1 for limit parameters, minVal=0 for offset parameters.
func queryInt(r *http.Request, key string, defaultVal, minVal int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return defaultVal
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < minVal {
		return defaultVal
	}
	// Cap to prevent unbounded result sets exhausting memory.
	const maxLimit = 500
	if n > maxLimit {
		return maxLimit
	}
	return n
}

// actorFromContext returns the authenticated user's ID stored in the request
// context by adminAuthMiddleware. Returns 0 if called outside that middleware
// (should not happen in production).
func actorFromContext(r *http.Request) int64 {
	user, ok := r.Context().Value(adminUserKey).(*db.User)
	if !ok || user == nil {
		return 0
	}
	return user.ID
}
