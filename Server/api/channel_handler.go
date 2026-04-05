package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
)

const (
	defaultMessageLimit = 50
	maxMessageLimit     = 100
)

func isInvalidSearchQueryError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "fts5") ||
		strings.Contains(msg, "unterminated string") ||
		strings.Contains(msg, "malformed") ||
		strings.Contains(msg, "syntax error")
}

func searchRateLimitMiddleware(limiter *auth.RateLimiter, limit int, window time.Duration, trustedProxies []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIPWithProxies(r, trustedProxies)
			if !limiter.Allow("search:"+ip, limit, window) {
				w.Header().Set("Retry-After", strconv.Itoa(int(window.Seconds())))
				writeJSON(w, http.StatusTooManyRequests, errorResponse{
					Error:   "RATE_LIMITED",
					Message: "too many requests, please slow down",
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// MountChannelRoutes registers all channel-related routes onto r.
// All routes require authentication. The limiter is used to rate-limit
// expensive endpoints like search.
func MountChannelRoutes(r chi.Router, database *db.DB, svc *service.Services, limiter *auth.RateLimiter, trustedProxies []string) {
	r.Route("/api/v1/channels", func(r chi.Router) {
		r.Use(AuthMiddleware(database))
		r.Get("/", handleListChannels(svc))
		r.Get("/{id}/messages", handleGetMessages(svc))
		r.Get("/{id}/pins", handleGetPins(svc))
		r.Post("/{id}/pins/{messageId}", handleSetPinned(svc, true))
		r.Delete("/{id}/pins/{messageId}", handleSetPinned(svc, false))
	})
	r.With(
		AuthMiddleware(database),
		searchRateLimitMiddleware(limiter, searchRateLimitPerMinute, time.Minute, trustedProxies),
	).Get("/api/v1/search", handleSearch(svc))
}

// handleListChannels returns all channels the authenticated user can see.
func handleListChannels(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, _ := r.Context().Value(UserKey).(*db.User)
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "authentication required",
			})
			return
		}

		channels, err := svc.Channels.ListVisibleChannels(user.ID)
		if err != nil {
			slog.Error("handleListChannels", "err", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error: "INTERNAL_ERROR", Message: "failed to list channels",
			})
			return
		}
		writeJSON(w, http.StatusOK, channels)
	}
}

// handleGetMessages returns paginated messages for a channel.
func handleGetMessages(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}

		user, _ := r.Context().Value(UserKey).(*db.User)
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "authentication required",
			})
			return
		}

		before := int64(0)
		if raw := r.URL.Query().Get("before"); raw != "" {
			v, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil || v < 0 {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error: "BAD_REQUEST", Message: "before must be a non-negative integer",
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
					Error: "BAD_REQUEST", Message: "limit must be a positive integer",
				})
				return
			}
			if v > maxMessageLimit {
				v = maxMessageLimit
			}
			limit = v
		}

		msgs, hasMore, err := svc.Messages.GetMessages(user.ID, channelID, before, limit)
		if err != nil {
			writeServiceError(w, err)
			return
		}

		type response struct {
			Messages []db.MessageAPIResponse `json:"messages"`
			HasMore  bool                    `json:"has_more"`
		}
		writeJSON(w, http.StatusOK, response{Messages: msgs, HasMore: hasMore})
	}
}

// handleSearch performs a full-text search across messages.
func handleSearch(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		if q == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "BAD_REQUEST", Message: "query parameter 'q' is required",
			})
			return
		}

		user, _ := r.Context().Value(UserKey).(*db.User)
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "authentication required",
			})
			return
		}

		var channelID *int64
		if raw := r.URL.Query().Get("channel_id"); raw != "" {
			v, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil || v <= 0 {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error: "BAD_REQUEST", Message: "channel_id must be a positive integer",
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
					Error: "BAD_REQUEST", Message: "limit must be a positive integer",
				})
				return
			}
			if v > maxMessageLimit {
				v = maxMessageLimit
			}
			limit = v
		}

		results, err := svc.Messages.SearchMessages(user.ID, q, channelID, limit)
		if err != nil {
			if isInvalidSearchQueryError(err) {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error: "BAD_REQUEST", Message: "invalid search query",
				})
				return
			}
			writeServiceError(w, err)
			return
		}
		if results == nil {
			results = []db.MessageSearchResult{}
		}

		type response struct {
			Results []db.MessageSearchResult `json:"results"`
		}
		writeJSON(w, http.StatusOK, response{Results: results})
	}
}

// handleGetPins returns all pinned messages for a channel.
func handleGetPins(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}

		user, _ := r.Context().Value(UserKey).(*db.User)
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "authentication required",
			})
			return
		}

		msgs, err := svc.Messages.GetPinnedMessages(user.ID, channelID)
		if err != nil {
			writeServiceError(w, err)
			return
		}

		type response struct {
			Messages []db.MessageAPIResponse `json:"messages"`
			HasMore  bool                    `json:"has_more"`
		}
		writeJSON(w, http.StatusOK, response{Messages: msgs, HasMore: false})
	}
}

// handleSetPinned pins or unpins a message in a channel.
func handleSetPinned(svc *service.Services, pinned bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}
		messageID, ok := parseIDParam(w, r, "messageId")
		if !ok {
			return
		}

		user, _ := r.Context().Value(UserKey).(*db.User)
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "authentication required",
			})
			return
		}

		if err := svc.Messages.SetMessagePinned(user.ID, channelID, messageID, pinned); err != nil {
			writeServiceError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// writeServiceError maps a service-layer error to an HTTP response.
func writeServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrRateLimited):
		writeJSON(w, http.StatusTooManyRequests, errorResponse{Error: "RATE_LIMITED", Message: err.Error()})
	case errors.Is(err, service.ErrBadRequest):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "BAD_REQUEST", Message: err.Error()})
	case errors.Is(err, service.ErrNotFound):
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "NOT_FOUND", Message: err.Error()})
	case errors.Is(err, service.ErrForbidden), errors.Is(err, service.ErrBlocked):
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "FORBIDDEN", Message: err.Error()})
	case errors.Is(err, service.ErrConflict):
		writeJSON(w, http.StatusConflict, errorResponse{Error: "CONFLICT", Message: err.Error()})
	default:
		slog.Error("service error", "err", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "INTERNAL_ERROR", Message: "internal error"})
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
