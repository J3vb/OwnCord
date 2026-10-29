package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
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

// PurgeBroadcaster is the interface needed to fan a bulk delete out over
// WebSocket from a REST handler. Satisfied by *ws.Hub.
type PurgeBroadcaster interface {
	BroadcastChatBulkDeleted(channelID int64, messageIDs []int64)
	BroadcastMessagePinned(channelID, messageID int64, pinned bool)
	PinEventRow(ctx context.Context, res *service.PinEventResult)
}

// MountChannelRoutes registers all channel-related routes onto r.
// All routes require authentication. The limiter is used to rate-limit
// expensive endpoints like search. broadcaster may be nil, in which case a
// purge still commits but no chat_bulk_deleted event is emitted.
func MountChannelRoutes(r chi.Router, svc *service.Services, limiter *auth.RateLimiter, trustedProxies []string, broadcaster PurgeBroadcaster) {
	r.Route("/api/v1/channels", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))
		r.Get("/", handleListChannels(svc))
		r.Get("/{id}/messages", handleGetMessages(svc))
		r.Get("/{id}/messages/around/{messageId}", handleGetMessagesAround(svc))
		r.Post("/{id}/messages/purge", handlePurgeMessages(svc, broadcaster))
		r.Get("/{id}/messages/{messageId}/reactions/{emoji}/users", handleGetReactionUsers(svc))
		r.Get("/{id}/pins", handleGetPins(svc))
		r.Post("/{id}/pins/{messageId}", handleSetPinned(svc, broadcaster, true))
		r.Delete("/{id}/pins/{messageId}", handleSetPinned(svc, broadcaster, false))
	})
	r.With(
		AuthMiddleware(svc.Sessions),
		RateLimitMiddleware(limiter, "search:", searchRateLimitPerMinute, time.Minute, trustedProxies),
	).Get("/api/v1/search", handleSearch(svc))
}

// handleListChannels returns all channels the authenticated user can see.
func handleListChannels(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		channels, err := svc.Channels.ListVisibleChannels(r.Context(), user.ID)
		if err != nil {
			slog.Error("handleListChannels", "err", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list channels")
			return
		}
		writeJSON(w, http.StatusOK, channels)
	}
}

// handleGetMessages returns paginated messages for a channel: newest-first
// pages behind `before` (the default), or the oldest-first page that follows
// `after`.
func handleGetMessages(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}

		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		before := int64(0)
		if raw := r.URL.Query().Get("before"); raw != "" {
			v, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil || v < 0 {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "before must be a non-negative integer")
				return
			}
			before = v
		}

		// `after` pages downward from a detached around-window toward the live
		// tail. It is a different direction from `before`, so the two cannot be
		// combined.
		after := int64(0)
		if raw := r.URL.Query().Get("after"); raw != "" {
			if r.URL.Query().Get("before") != "" {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "after and before cannot be combined")
				return
			}
			v, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil || v <= 0 {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "after must be a positive integer")
				return
			}
			after = v
		}

		limit, ok := parseLimitParam(w, r)
		if !ok {
			return
		}

		var (
			msgs    []db.MessageAPIResponse
			hasMore bool
			err     error
		)
		if after > 0 {
			msgs, hasMore, err = svc.Messages.GetMessagesAfter(r.Context(), user.ID, channelID, after, limit)
		} else {
			msgs, hasMore, err = svc.Messages.GetMessages(r.Context(), user.ID, channelID, before, limit)
		}
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

		user, ok := requireUser(w, r)
		if !ok {
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

		user, ok := requireUser(w, r)
		if !ok {
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

		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		var req purgeRequest
		if !decodeJSON(w, r, &req) {
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
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "query parameter 'q' is required")
			return
		}

		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		var channelID *int64
		if raw := r.URL.Query().Get("channel_id"); raw != "" {
			v, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil || v <= 0 {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "channel_id must be a positive integer")
				return
			}
			channelID = &v
		}

		limit, ok := parseLimitParam(w, r)
		if !ok {
			return
		}
		page := db.SearchPage{Limit: limit}

		switch r.URL.Query().Get("sort") {
		case "", "relevance":
		case "recent":
			page.Recent = true
		default:
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "sort must be 'relevance' or 'recent'")
			return
		}
		if raw := r.URL.Query().Get("before"); raw != "" {
			v, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil || v <= 0 {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "before must be a positive integer")
				return
			}
			// A message-id cursor only walks a newest-first list.
			if !page.Recent {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "before requires sort=recent")
				return
			}
			page.Before = v
		}

		results, nextBefore, err := svc.Messages.SearchMessages(r.Context(), user.ID, service.SearchRequest{
			Query:     q,
			ChannelID: channelID,
			TZ:        r.URL.Query().Get("tz"),
			Page:      page,
		})
		if err != nil {
			if isInvalidSearchQueryError(err) {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid search query")
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
			// NextBefore is the before= cursor for the next sort=recent page;
			// null when there is none.
			NextBefore *int64 `json:"next_before"`
		}
		resp := response{Results: results}
		if nextBefore > 0 {
			resp.NextBefore = &nextBefore
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// handleGetPins returns all pinned messages for a channel.
func handleGetPins(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}

		user, ok := requireUser(w, r)
		if !ok {
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
		// Report the real cap state rather than a hardcoded false: with more
		// than MaxPinnedMessages pins the rest are truncated, and the caller
		// must be able to tell (F23).
		hasMore := len(msgs) > db.MaxPinnedMessages
		if hasMore {
			msgs = msgs[:db.MaxPinnedMessages]
		}
		writeJSON(w, http.StatusOK, response{
			Messages: msgs,
			HasMore:  hasMore,
		})
	}
}

// handleSetPinned pins or unpins a message. The change is broadcast to every
// reader so no client shows stale pins (F5); a pin may also fan out a pin row.
func handleSetPinned(svc *service.Services, broadcaster PurgeBroadcaster, pinned bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}
		messageID, ok := parseIDParam(w, r, "messageId")
		if !ok {
			return
		}

		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		pinRow, err := svc.Messages.SetMessagePinned(r.Context(), user.ID, channelID, messageID, pinned)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		if broadcaster != nil {
			broadcaster.BroadcastMessagePinned(channelID, messageID, pinned)
			if pinRow != nil { // detached: the pin committed, a dropped pinner must not cost the room the row
				broadcaster.PinEventRow(context.WithoutCancel(r.Context()), pinRow)
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// writeServiceError maps a service-layer error to an HTTP response.
func writeServiceError(ctx context.Context, w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrRateLimited):
		writeErr(w, http.StatusTooManyRequests, "RATE_LIMITED", err.Error())
	case errors.Is(err, service.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
	case errors.Is(err, service.ErrNotFound):
		writeErr(w, http.StatusNotFound, "NOT_FOUND", err.Error())
	case errors.Is(err, permissions.ErrNSFWUnacknowledged):
		// B5-7: the response carries the code and nothing else.
		writeErr(w, http.StatusForbidden, "NSFW_ACKNOWLEDGEMENT_REQUIRED", "")
	case errors.Is(err, service.ErrTimedOut):
		writeErr(w, http.StatusForbidden, "TIMED_OUT", err.Error())
	case errors.Is(err, service.ErrForbidden), errors.Is(err, service.ErrBlocked):
		writeErr(w, http.StatusForbidden, "FORBIDDEN", err.Error())
	case errors.Is(err, service.ErrDeletedMessage):
		// The target is already gone — a state, not a failure. 404 would be
		// wrong here: the moderation client clears the report on 404, which
		// would hide the removal's own outcome. 409 ALREADY_DELETED is the
		// "already in the requested end state" twin of DUPLICATE_REPORT, so
		// the caller gets a clean typed refusal instead of a 500.
		writeErr(w, http.StatusConflict, "ALREADY_DELETED", err.Error())
	case errors.Is(err, service.ErrGroupDMFull):
		// Before ErrConflict, which it wraps: the group has no room left.
		writeErr(w, http.StatusConflict, "GROUP_DM_FULL", err.Error())
	case errors.Is(err, service.ErrConflict):
		writeErr(w, http.StatusConflict, "CONFLICT", err.Error())
	case errors.Is(err, service.ErrInternal):
		// ErrorContext so the enriching handler attaches req_id/trace_id,
		// linking this 500 to its request log line and trace.
		slog.ErrorContext(ctx, "service error", "error", err)
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "an internal error occurred")
	default:
		slog.ErrorContext(ctx, "service error", "error", err)
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "internal error")
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
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "limit must be a positive integer")
		return 0, false
	}
	return min(v, maxMessageLimit), true
}

// parseIDParam extracts and validates a chi URL param as int64.
// Writes a 400 response and returns false on failure.
func parseIDParam(w http.ResponseWriter, r *http.Request, param string) (int64, bool) {
	id, ok := pathID(r, param)
	if !ok {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", param+" must be a positive integer")
		return 0, false
	}
	return id, true
}
