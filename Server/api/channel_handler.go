package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
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
	proxyNets := parseCIDRList(trustedProxies) // W3-3a: parse once at construction
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIPWithProxies(r, proxyNets)
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

// PurgeBroadcaster is the interface needed to fan a bulk delete out over
// WebSocket from a REST handler. Satisfied by *ws.Hub.
type PurgeBroadcaster interface {
	BroadcastChatBulkDeleted(channelID int64, messageIDs []int64)
}

// MountChannelRoutes registers all channel-related routes onto r.
// All routes require authentication. The limiter is used to rate-limit
// expensive endpoints like search. broadcaster may be nil, in which case a
// purge still commits but no chat_bulk_deleted event is emitted.
func MountChannelRoutes(r chi.Router, database *db.DB, svc *service.Services, limiter *auth.RateLimiter, trustedProxies []string, broadcaster PurgeBroadcaster) {
	r.Route("/api/v1/channels", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Get("/", handleListChannels(svc))
		r.Get("/{id}/messages", handleGetMessages(svc))
		r.Get("/{id}/messages/around/{messageId}", handleGetMessagesAround(svc))
		r.Post("/{id}/messages/purge", handlePurgeMessages(svc, broadcaster))
		r.Get("/{id}/messages/{messageId}/reactions/{emoji}/users", handleGetReactionUsers(svc))
		r.Get("/{id}/pins", handleGetPins(svc))
		r.Post("/{id}/pins/{messageId}", handleSetPinned(svc, true))
		r.Delete("/{id}/pins/{messageId}", handleSetPinned(svc, false))
	})
	r.With(
		AuthMiddleware(svc.Sessions),
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

		channels, err := svc.Channels.ListVisibleChannels(r.Context(), user.ID)
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

		limit, ok := parseLimitParam(w, r)
		if !ok {
			return
		}

		msgs, hasMore, err := svc.Messages.GetMessages(r.Context(), user.ID, channelID, before, limit)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		type response struct {
			Messages []db.MessageAPIResponse `json:"messages"`
			HasMore  bool                    `json:"has_more"`
		}
		writeJSON(w, http.StatusOK, response{Messages: msgs, HasMore: hasMore})
	}
}

// handleGetMessagesAround returns the window of messages centred on a message,
// oldest-first. Used to jump to a message (search hit, pinned entry, reply
// reference, permalink) that is not in the client's loaded history.
func handleGetMessagesAround(svc *service.Services) http.HandlerFunc {
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

		limit, ok := parseLimitParam(w, r)
		if !ok {
			return
		}

		window, err := svc.Messages.GetMessagesAround(r.Context(), user.ID, channelID, messageID, limit)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		writeJSON(w, http.StatusOK, window)
	}
}

// handleGetReactionUsers returns the users who reacted to a message with a
// given emoji, capped server-side at 100. The emoji arrives percent-encoded in
// the path; chi routes on RawPath when it differs from Path, so the param must
// be unescaped here rather than taken verbatim.
func handleGetReactionUsers(svc *service.Services) http.HandlerFunc {
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

		emoji := chi.URLParam(r, "emoji")
		if decoded, decErr := url.PathUnescape(emoji); decErr == nil {
			emoji = decoded
		}

		users, err := svc.Messages.GetReactionUsers(r.Context(), user.ID, channelID, messageID, emoji)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		type response struct {
			Users []db.ReactionUser `json:"users"`
		}
		writeJSON(w, http.StatusOK, response{Users: users})
	}
}

// purgeRequest is the JSON body for POST /api/v1/channels/{id}/messages/purge.
// Before is optional; 0 means "start from the newest message".
type purgeRequest struct {
	Limit  int   `json:"limit"`
	Before int64 `json:"before"`
}

// purgeResponse reports what the purge actually deleted, which can be fewer
// than Limit rows when the channel holds less history.
type purgeResponse struct {
	ChannelID int64   `json:"channel_id"`
	IDs       []int64 `json:"ids"`
	Count     int     `json:"count"`
}

// handlePurgeMessages bulk soft-deletes the newest messages in a channel and
// broadcasts a single chat_bulk_deleted event.
func handlePurgeMessages(svc *service.Services, broadcaster PurgeBroadcaster) http.HandlerFunc {
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

		var req purgeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "BAD_REQUEST", Message: "invalid request body",
			})
			return
		}

		result, err := svc.Messages.PurgeMessages(r.Context(), user.ID, channelID, req.Limit, req.Before)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		// A purge that matched nothing is still a success, but there is no
		// state change to announce.
		if broadcaster != nil && len(result.MessageIDs) > 0 {
			broadcaster.BroadcastChatBulkDeleted(result.ChannelID, result.MessageIDs)
		}

		writeJSON(w, http.StatusOK, purgeResponse{
			ChannelID: result.ChannelID,
			IDs:       result.MessageIDs,
			Count:     len(result.MessageIDs),
		})
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

		limit, ok := parseLimitParam(w, r)
		if !ok {
			return
		}

		results, err := svc.Messages.SearchMessages(r.Context(), user.ID, q, channelID, limit)
		if err != nil {
			if isInvalidSearchQueryError(err) {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error: "BAD_REQUEST", Message: "invalid search query",
				})
				return
			}
			writeServiceError(r.Context(), w, err)
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

		msgs, err := svc.Messages.GetPinnedMessages(r.Context(), user.ID, channelID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
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

		if err := svc.Messages.SetMessagePinned(r.Context(), user.ID, channelID, messageID, pinned); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// writeServiceError maps a service-layer error to an HTTP response.
func writeServiceError(ctx context.Context, w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrRateLimited):
		writeJSON(w, http.StatusTooManyRequests, errorResponse{Error: "RATE_LIMITED", Message: err.Error()})
	case errors.Is(err, service.ErrBadRequest):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "BAD_REQUEST", Message: err.Error()})
	case errors.Is(err, service.ErrNotFound):
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "NOT_FOUND", Message: err.Error()})
	case errors.Is(err, service.ErrTimedOut):
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "TIMED_OUT", Message: err.Error()})
	case errors.Is(err, service.ErrForbidden), errors.Is(err, service.ErrBlocked):
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "FORBIDDEN", Message: err.Error()})
	case errors.Is(err, service.ErrConflict):
		writeJSON(w, http.StatusConflict, errorResponse{Error: "CONFLICT", Message: err.Error()})
	case errors.Is(err, service.ErrInternal):
		// ErrorContext so the enriching handler attaches req_id/trace_id,
		// linking this 500 to its request log line and trace.
		slog.ErrorContext(ctx, "service error", "error", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "INTERNAL_ERROR", Message: "an internal error occurred"})
	default:
		slog.ErrorContext(ctx, "service error", "error", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "INTERNAL_ERROR", Message: "internal error"})
	}
}

// parseLimitParam reads the shared `limit` query parameter, defaulting to
// defaultMessageLimit and clamping at maxMessageLimit. Writes a 400 response
// and returns false when the value is present but not a positive integer.
func parseLimitParam(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return defaultMessageLimit, true
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < 1 {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error: "BAD_REQUEST", Message: "limit must be a positive integer",
		})
		return 0, false
	}
	return min(v, maxMessageLimit), true
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
