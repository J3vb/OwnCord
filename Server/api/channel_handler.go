package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
)

const (
	// Permission bits (from SCHEMA.md).
	permReadMessages   = int64(0x0400)
	permAdministrator  = int64(0x40000000)

	defaultMessageLimit = 50
	maxMessageLimit     = 100
)

// MountChannelRoutes registers all channel-related routes onto r.
// All routes require authentication.
func MountChannelRoutes(r chi.Router, database *db.DB) {
	r.Route("/api/v1/channels", func(r chi.Router) {
		r.Use(AuthMiddleware(database))
		r.Get("/", handleListChannels(database))
		r.Get("/{id}/messages", handleGetMessages(database))
	})
	r.With(AuthMiddleware(database)).Get("/api/v1/search", handleSearch(database))
}

// handleListChannels returns all channels the authenticated user can see.
func handleListChannels(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channels, err := database.ListChannels()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL",
				Message: "failed to list channels",
			})
			return
		}
		writeJSON(w, http.StatusOK, channels)
	}
}

// handleGetMessages returns paginated messages for a channel.
// Query params: before (int64, message ID for pagination), limit (1-100, default 50).
func handleGetMessages(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}

		ch, err := database.GetChannel(channelID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL",
				Message: "failed to look up channel",
			})
			return
		}
		if ch == nil {
			writeJSON(w, http.StatusNotFound, errorResponse{
				Error:   "NOT_FOUND",
				Message: "channel not found",
			})
			return
		}

		// Parse query params.
		before := int64(0)
		if raw := r.URL.Query().Get("before"); raw != "" {
			v, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil || v < 0 {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error:   "BAD_REQUEST",
					Message: "before must be a non-negative integer",
				})
				return
			}
			before = v
		}

		limit := defaultMessageLimit
		if raw := r.URL.Query().Get("limit"); raw != "" {
			v, parseErr := strconv.Atoi(raw)
			if parseErr != nil || v < 1 {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error:   "BAD_REQUEST",
					Message: "limit must be a positive integer",
				})
				return
			}
			if v > maxMessageLimit {
				v = maxMessageLimit
			}
			limit = v
		}

		// Fetch one extra to determine has_more.
		msgs, err := database.GetMessages(channelID, before, limit+1)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL",
				Message: "failed to fetch messages",
			})
			return
		}

		hasMore := false
		if len(msgs) > limit {
			hasMore = true
			msgs = msgs[:limit]
		}

		type response struct {
			Messages []db.MessageWithUser `json:"messages"`
			HasMore  bool                 `json:"has_more"`
		}
		writeJSON(w, http.StatusOK, response{Messages: msgs, HasMore: hasMore})
	}
}

// handleSearch performs a full-text search across messages.
// Query params: q (required), channel_id (optional), limit (optional, 1-100).
func handleSearch(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		if q == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: "query parameter 'q' is required",
			})
			return
		}

		var channelID *int64
		if raw := r.URL.Query().Get("channel_id"); raw != "" {
			v, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil || v <= 0 {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error:   "BAD_REQUEST",
					Message: "channel_id must be a positive integer",
				})
				return
			}
			channelID = &v
		}

		limit := defaultMessageLimit
		if raw := r.URL.Query().Get("limit"); raw != "" {
			v, parseErr := strconv.Atoi(raw)
			if parseErr != nil || v < 1 {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error:   "BAD_REQUEST",
					Message: "limit must be a positive integer",
				})
				return
			}
			if v > maxMessageLimit {
				v = maxMessageLimit
			}
			limit = v
		}

		results, err := database.SearchMessages(q, channelID, limit)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL",
				Message: "search failed",
			})
			return
		}

		type response struct {
			Results []db.MessageSearchResult `json:"results"`
		}
		writeJSON(w, http.StatusOK, response{Results: results})
	}
}

// parseIDParam extracts and validates a chi URL param as int64.
// Writes a 400 response and returns false on failure.
func parseIDParam(w http.ResponseWriter, r *http.Request, param string) (int64, bool) {
	raw := chi.URLParam(r, param)
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error:   "BAD_REQUEST",
			Message: param + " must be a positive integer",
		})
		return 0, false
	}
	return id, true
}
