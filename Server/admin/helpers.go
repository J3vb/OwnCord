package admin

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/go-chi/chi/v5"
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
// Use minVal=1 for limit parameters, minVal=0 for offset parameters. maxVal
// caps limit parameters to prevent unbounded result sets; offset callers pass
// a large bound — clamping offset with the limit cap would make pagination
// unable to advance past row maxVal+limit.
func queryInt(r *http.Request, key string, defaultVal, minVal, maxVal int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return defaultVal
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < minVal {
		return defaultVal
	}
	if n > maxVal {
		return maxVal
	}
	return n
}

// actorFromContext returns the authenticated user's ID stored in the request
// context by adminAuthMiddleware. Returns 0 if called outside that middleware
// (should not happen in production).
func actorFromContext(r *http.Request) int64 {
	return ActorIDFromContext(r.Context())
}

// ActorIDFromContext returns the admin principal's user ID that
// RequireAdminAuth stored in ctx, or 0 outside that middleware. Exported for
// handlers mounted behind RequireAdminAuth from other packages (the plugin
// admin surface in api) so their audit rows name the real actor.
func ActorIDFromContext(ctx context.Context) int64 {
	user, ok := ctx.Value(adminUserKey).(*db.User)
	if !ok || user == nil {
		return 0
	}
	return user.ID
}

// actorRoleFromContext returns the authenticated principal's *db.Role stored
// in the request context by adminAuthMiddleware. Returns nil if called
// outside that middleware (should not happen in production) so callers can
// fail closed.
func actorRoleFromContext(r *http.Request) *db.Role {
	role, ok := r.Context().Value(adminRoleKey).(*db.Role)
	if !ok {
		return nil
	}
	return role
}
