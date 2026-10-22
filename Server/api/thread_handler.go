package api

import (
	"net/http"
	"strconv"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// MountThreadRoutes registers the thread list under
// /api/v1/channels/{id}/threads (WP 6.9c). It lives apart from MountChannelRoutes
// because that file is at its size ceiling.
func MountThreadRoutes(r chi.Router, svc *service.Services) {
	r.With(AuthMiddleware(svc.Sessions)).Get("/api/v1/channels/{id}/threads", handleListThreads(svc))
}

// handleListThreads lists a text channel's threads, newest activity first.
// archived=0|1 (default 0) picks the state, before is the previous page's
// next_before cursor, limit defaults to ThreadListDefaultLimit. The parent's
// read gate applies in the service.
func handleListThreads(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		parentID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		q := r.URL.Query()
		archived := false
		switch q.Get("archived") {
		case "", "0":
		case "1":
			archived = true
		default:
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "archived must be 0 or 1")
			return
		}
		after, err := service.ParseThreadCursor(q.Get("before"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "before must be a next_before value from a previous page")
			return
		}
		limit := service.ThreadListDefaultLimit
		if raw := q.Get("limit"); raw != "" {
			v, err := strconv.Atoi(raw)
			if err != nil || v < 1 {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "limit must be a positive integer")
				return
			}
			limit = min(v, service.ThreadListMaxLimit)
		}
		threads, next, hasMore, err := svc.Threads.List(r.Context(), user.ID, parentID, archived, after, limit)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		if threads == nil {
			threads = []service.ThreadInfo{}
		}
		nextBefore := ""
		if hasMore {
			nextBefore = service.FormatThreadCursor(next)
		}
		writeJSON(w, http.StatusOK, struct {
			Threads    []service.ThreadInfo `json:"threads"`
			HasMore    bool                 `json:"has_more"`
			NextBefore string               `json:"next_before"`
		}{threads, hasMore, nextBefore})
	}
}
