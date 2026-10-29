package api

import (
	"net/http"
	"strconv"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// MountThreadRoutes registers the thread list under
// /api/v1/channels/{id}/threads (WP 6.9c). It lives apart from MountChannelRoutes
// because that file is at its size ceiling.
func MountThreadRoutes(r chi.Router, svc *service.Services) {
	r.With(AuthMiddleware(svc.Sessions)).Get("/api/v1/channels/{id}/threads", handleListThreads(svc))
}

// handleListThreads lists a channel's threads, newest activity first.
// archived=0|1 (default 0) picks the state, before is the previous page's
// next_before cursor, limit defaults to ThreadListDefaultLimit. sort=activity
// (default) or created reorders; tag=<id>, repeated up to db.MaxPostTags times,
// keeps the posts of a forum carrying any of those tags. The parent's read gate
// applies in the service.
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
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "archived must be 0 or 1")
			return
		}
		params := service.ThreadListParams{Archived: archived, Sort: q.Get("sort")}
		switch params.Sort {
		case "":
		case service.ThreadSortActivity, service.ThreadSortCreated:
		default:
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "sort must be activity or created")
			return
		}
		for _, raw := range q["tag"] {
			id, perr := strconv.ParseInt(raw, 10, 64)
			if perr != nil || id < 1 {
				writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "tag must be a positive tag id")
				return
			}
			params.TagIDs = append(params.TagIDs, id)
		}
		after, err := service.ParseThreadCursorFor(params.Sort, q.Get("before"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "before must be a next_before value from a previous page")
			return
		}
		limit := service.ThreadListDefaultLimit
		if raw := q.Get("limit"); raw != "" {
			v, err := strconv.Atoi(raw)
			if err != nil || v < 1 {
				writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "limit must be a positive integer")
				return
			}
			limit = min(v, service.ThreadListMaxLimit)
		}
		threads, next, hasMore, err := svc.Threads.List(r.Context(), user.ID, parentID, params, after, limit)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		if threads == nil {
			threads = []service.ThreadInfo{}
		}
		nextBefore := ""
		if hasMore {
			nextBefore = service.FormatThreadCursorFor(params.Sort, next)
		}
		writeJSON(w, http.StatusOK, struct {
			Threads    []service.ThreadInfo `json:"threads"`
			HasMore    bool                 `json:"has_more"`
			NextBefore string               `json:"next_before"`
		}{threads, hasMore, nextBefore})
	}
}
