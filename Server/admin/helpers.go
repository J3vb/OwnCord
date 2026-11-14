package admin

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

type errorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	httperr.WriteJSON(w, status, v)
}

func writeErr(w http.ResponseWriter, status int, code httperr.Code, msg string) {
	writeJSON(w, status, errorResponse{Error: string(code), Message: msg})
}

// writeSvcErr maps a service sentinel error onto an admin API response. notFound overrides the 404 text,
// badReqCode the 400 code (default BAD_REQUEST); fallback is the 500 text for anything else. Every mapper
// answers ErrForbidden with 403.
func writeSvcErr(w http.ResponseWriter, err error, notFound string, badReqCode httperr.Code, fallback string) {
	switch {
	case errors.Is(err, service.ErrForbidden):
		writeErr(w, http.StatusForbidden, httperr.CodeForbidden, err.Error())
	case errors.Is(err, service.ErrNotFound):
		writeErr(w, http.StatusNotFound, httperr.CodeNotFound, cmp.Or(notFound, err.Error()))
	case errors.Is(err, service.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, cmp.Or(badReqCode, httperr.CodeBadRequest), err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, fallback)
	}
}

var errPathID = errors.New("id must be a positive integer")

// pathInt64 reads a numeric id from the URL. Ids start at 1, so 0 and negatives are refused once here, not at
// every caller; the path-id invariant keeps raw strconv.ParseInt(chi.URLParam(...)) out of admin and api.
func pathInt64(r *http.Request, param string) (int64, error) {
	id, err := strconv.ParseInt(chi.URLParam(r, param), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("path id %q: %w", param, err)
	}
	if id <= 0 {
		return 0, fmt.Errorf("path id %q: %w", param, errPathID)
	}
	return id, nil
}

// queryInt parses an integer query parameter within [minVal, maxVal]. maxVal caps limit parameters; offset
// callers pass a large bound, since clamping offset to the limit cap would stop pagination advancing past
// maxVal+limit.
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

// actorFromContext returns the user ID adminAuthMiddleware stored; 0 outside that middleware.
func actorFromContext(r *http.Request) int64 {
	return ActorIDFromContext(r.Context())
}

// ActorIDFromContext returns the admin principal's user ID that RequireAdminAuth stored, or 0 outside it.
// Exported so handlers mounted behind it from other packages (api's plugin admin surface) audit the real
// actor.
func ActorIDFromContext(ctx context.Context) int64 {
	user, ok := ctx.Value(adminUserKey).(*db.User)
	if !ok || user == nil {
		return 0
	}
	return user.ID
}

// actorUserFromContext returns the *db.User adminAuthMiddleware stored, or nil outside it.
func actorUserFromContext(r *http.Request) *db.User {
	user, ok := r.Context().Value(adminUserKey).(*db.User)
	if !ok {
		return nil
	}
	return user
}

// actorRoleFromContext returns the *db.Role adminAuthMiddleware stored, or nil outside it so callers can fail
// closed.
func actorRoleFromContext(r *http.Request) *db.Role {
	role, ok := r.Context().Value(adminRoleKey).(*db.Role)
	if !ok {
		return nil
	}
	return role
}

// isOwnerFromContext reports whether the principal holds the Owner role (the ownerOnlyMiddleware predicate);
// a missing role fails closed. For handlers gating individual keys or fields, not a whole route.
func isOwnerFromContext(r *http.Request) bool {
	role := actorRoleFromContext(r)
	return role != nil && permissions.IsOwner(role.ID, role.Position)
}

// supportSession refuses API-token principals and binds previews to the exact
// login credential already authenticated by the middleware on every request.
func supportSession(r *http.Request) (string, bool) {
	sess, ok := r.Context().Value(adminSessionKey).(*db.Session)
	if !ok || sess == nil {
		return "", false
	}
	hash, ok := r.Context().Value(adminTokenHashKey).(string)
	return hash, ok && hash != ""
}
