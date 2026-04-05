package api

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
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
func MountChannelRoutes(r chi.Router, database *db.DB, limiter *auth.RateLimiter, trustedProxies []string) {
	r.Route("/api/v1/channels", func(r chi.Router) {
		r.Use(AuthMiddleware(database))
		r.Get("/", handleListChannels(database))
		r.Get("/{id}/messages", handleGetMessages(database))
		r.Get("/{id}/pins", handleGetPins(database))
		r.Post("/{id}/pins/{messageId}", handleSetPinned(database, true))
		r.Delete("/{id}/pins/{messageId}", handleSetPinned(database, false))
	})
	r.With(
		AuthMiddleware(database),
		searchRateLimitMiddleware(limiter, searchRateLimitPerMinute, time.Minute, trustedProxies),
	).Get("/api/v1/search", handleSearch(database))
}

// hasChannelPermREST checks whether the role has the given permission on the channel,
// accounting for Administrator bypass and channel overrides.
func hasChannelPermREST(database *db.DB, role *db.Role, channelID, perm int64) bool {
	if role == nil {
		return false
	}
	if permissions.HasAdmin(role.Permissions) {
		return true
	}
	allow, deny, err := database.GetChannelPermissions(channelID, role.ID)
	if err != nil {
		return false
	}
	effective := permissions.EffectivePerms(role.Permissions, allow, deny)
	return effective&perm == perm
}

// hasChannelPermBatch checks permission using a pre-fetched overrides map,
// eliminating N+1 queries when filtering multiple channels.
func hasChannelPermBatch(role *db.Role, overrides map[int64]db.ChannelOverride, channelID, perm int64) bool {
	if role == nil {
		return false
	}
	if permissions.HasAdmin(role.Permissions) {
		return true
	}
	o := overrides[channelID] // zero-value (0,0) when no override exists
	effective := permissions.EffectivePerms(role.Permissions, o.Allow, o.Deny)
	return effective&perm == perm
}

// handleListChannels returns all channels the authenticated user can see.
func handleListChannels(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		role, _ := r.Context().Value(RoleKey).(*db.Role)

		channels, err := database.ListChannels()
		if err != nil {
			slog.Error("handleListChannels ListChannels", "err", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to list channels",
			})
			return
		}

		// Batch-fetch all channel permission overrides for this role in one query.
		overrides := map[int64]db.ChannelOverride{}
		if role != nil && !permissions.HasAdmin(role.Permissions) {
			var oErr error
			overrides, oErr = database.GetAllChannelPermissionsForRole(role.ID)
			if oErr != nil {
				slog.Error("handleListChannels GetAllChannelPermissionsForRole", "err", oErr)
				writeJSON(w, http.StatusInternalServerError, errorResponse{
					Error:   "INTERNAL_ERROR",
					Message: "failed to fetch channel permissions",
				})
				return
			}
		}

		// Filter channels by READ_MESSAGES permission.
		// DM channels are excluded — they are delivered via the separate DM endpoints.
		var visible []db.Channel
		for i := range channels {
			if channels[i].Type == "dm" {
				continue
			}
			if hasChannelPermBatch(role, overrides, channels[i].ID, permissions.ReadMessages) {
				visible = append(visible, channels[i])
			}
		}
		if visible == nil {
			visible = []db.Channel{}
		}
		writeJSON(w, http.StatusOK, visible)
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
			slog.Error("handleGetMessages GetChannel", "err", err, "channel_id", channelID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
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

		// DM channels use participant-based auth instead of role-based permissions.
		if ch.Type == "dm" {
			user, _ := r.Context().Value(UserKey).(*db.User)
			if user == nil {
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "authentication required",
				})
				return
			}
			ok, dmErr := database.IsDMParticipant(user.ID, channelID)
			if dmErr != nil || !ok {
				writeJSON(w, http.StatusNotFound, errorResponse{
					Error:   "NOT_FOUND",
					Message: "channel not found",
				})
				return
			}
		} else {
			role, _ := r.Context().Value(RoleKey).(*db.Role)
			if !hasChannelPermREST(database, role, channelID, permissions.ReadMessages) {
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "no permission to view this channel",
				})
				return
			}
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

		// Extract requesting user ID for reaction "me" flag.
		var userID int64
		if user, ok := r.Context().Value(UserKey).(*db.User); ok && user != nil {
			userID = user.ID
		}

		// Fetch one extra to determine has_more.
		msgs, err := database.GetMessagesForAPI(channelID, before, limit+1, userID)
		if err != nil {
			slog.Error("handleGetMessages GetMessagesForAPI", "err", err, "channel_id", channelID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
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
			Messages []db.MessageAPIResponse `json:"messages"`
			HasMore  bool                    `json:"has_more"`
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

			// Pre-check: verify the user can read this channel before running
			// the FTS query, preventing timing-oracle information leakage.
			ch, chErr := database.GetChannel(v)
			if chErr != nil || ch == nil {
				writeJSON(w, http.StatusNotFound, errorResponse{
					Error:   "NOT_FOUND",
					Message: "channel not found",
				})
				return
			}
			if ch.Type == "dm" {
				user, _ := r.Context().Value(UserKey).(*db.User)
				if user == nil {
					writeJSON(w, http.StatusForbidden, errorResponse{
						Error: "FORBIDDEN", Message: "no permission to search this channel",
					})
					return
				}
				ok, dmErr := database.IsDMParticipant(user.ID, v)
				if dmErr != nil || !ok {
					writeJSON(w, http.StatusForbidden, errorResponse{
						Error: "FORBIDDEN", Message: "no permission to search this channel",
					})
					return
				}
			} else {
				role, _ := r.Context().Value(RoleKey).(*db.Role)
				if !hasChannelPermREST(database, role, v, permissions.ReadMessages) {
					writeJSON(w, http.StatusForbidden, errorResponse{
						Error: "FORBIDDEN", Message: "no permission to search this channel",
					})
					return
				}
			}
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

		var results []db.MessageSearchResult

		if channelID != nil {
			// Single-channel search: permission already checked above.
			var err error
			results, err = database.SearchMessages(q, channelID, limit)
			if err != nil {
				if isInvalidSearchQueryError(err) {
					writeJSON(w, http.StatusBadRequest, errorResponse{
						Error:   "BAD_REQUEST",
						Message: "invalid search query",
					})
					return
				}
				slog.Error("handleSearch SearchMessages", "err", err, "query", q)
				writeJSON(w, http.StatusInternalServerError, errorResponse{
					Error:   "INTERNAL_ERROR",
					Message: "search failed",
				})
				return
			}
		} else {
			// Global search: pre-compute the set of accessible channel IDs
			// so the DB query never touches restricted content.
			role, _ := r.Context().Value(RoleKey).(*db.Role)
			user, _ := r.Context().Value(UserKey).(*db.User)

			// 1. Guild channels the user can read.
			allChannels, chErr := database.ListChannels()
			if chErr != nil {
				slog.Error("handleSearch ListChannels", "err", chErr)
				writeJSON(w, http.StatusInternalServerError, errorResponse{
					Error:   "INTERNAL_ERROR",
					Message: "search failed",
				})
				return
			}

			overrides := map[int64]db.ChannelOverride{}
			if role != nil && !permissions.HasAdmin(role.Permissions) {
				var oErr error
				overrides, oErr = database.GetAllChannelPermissionsForRole(role.ID)
				if oErr != nil {
					slog.Error("handleSearch GetAllChannelPermissionsForRole", "err", oErr)
					writeJSON(w, http.StatusInternalServerError, errorResponse{
						Error:   "INTERNAL_ERROR",
						Message: "search failed",
					})
					return
				}
			}

			var accessibleIDs []int64
			for i := range allChannels {
				if allChannels[i].Type == "dm" {
					continue // DM channels handled separately below.
				}
				if hasChannelPermBatch(role, overrides, allChannels[i].ID, permissions.ReadMessages) {
					accessibleIDs = append(accessibleIDs, allChannels[i].ID)
				}
			}

			// 2. DM channels the user participates in.
			if user != nil {
				dmChannels, dmErr := database.GetUserDMChannels(user.ID)
				if dmErr != nil {
					slog.Error("handleSearch GetUserDMChannels", "err", dmErr)
					writeJSON(w, http.StatusInternalServerError, errorResponse{
						Error:   "INTERNAL_ERROR",
						Message: "search failed",
					})
					return
				}
				for _, dm := range dmChannels {
					accessibleIDs = append(accessibleIDs, dm.ChannelID)
				}
			}

			if len(accessibleIDs) == 0 {
				results = []db.MessageSearchResult{}
			} else {
				var err error
				results, err = database.SearchMessagesInChannels(q, accessibleIDs, limit)
				if err != nil {
					if isInvalidSearchQueryError(err) {
						writeJSON(w, http.StatusBadRequest, errorResponse{
							Error:   "BAD_REQUEST",
							Message: "invalid search query",
						})
						return
					}
					slog.Error("handleSearch SearchMessagesInChannels", "err", err, "query", q)
					writeJSON(w, http.StatusInternalServerError, errorResponse{
						Error:   "INTERNAL_ERROR",
						Message: "search failed",
					})
					return
				}
			}
		}

		type response struct {
			Results []db.MessageSearchResult `json:"results"`
		}
		writeJSON(w, http.StatusOK, response{Results: results})
	}
}

// handleGetPins returns all pinned messages for a channel.
func handleGetPins(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}

		ch, err := database.GetChannel(channelID)
		if err != nil {
			slog.Error("handleGetPins GetChannel", "err", err, "channel_id", channelID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
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

		// DM channels use participant-based auth instead of role-based permissions.
		if ch.Type == "dm" {
			user, _ := r.Context().Value(UserKey).(*db.User)
			if user == nil {
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "authentication required",
				})
				return
			}
			ok, dmErr := database.IsDMParticipant(user.ID, channelID)
			if dmErr != nil || !ok {
				writeJSON(w, http.StatusNotFound, errorResponse{
					Error:   "NOT_FOUND",
					Message: "channel not found",
				})
				return
			}
		} else {
			// Permission check: user must have READ_MESSAGES on this channel.
			role, _ := r.Context().Value(RoleKey).(*db.Role)
			if !hasChannelPermREST(database, role, channelID, permissions.ReadMessages) {
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "no permission to view this channel",
				})
				return
			}
		}

		// Extract requesting user ID for reaction "me" flag.
		var userID int64
		if user, ok := r.Context().Value(UserKey).(*db.User); ok && user != nil {
			userID = user.ID
		}

		msgs, err := database.GetPinnedMessages(channelID, userID)
		if err != nil {
			slog.Error("handleGetPins GetPinnedMessages", "err", err, "channel_id", channelID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to fetch pinned messages",
			})
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
func handleSetPinned(database *db.DB, pinned bool) http.HandlerFunc {
	action := "pin"
	if !pinned {
		action = "unpin"
	}
	return func(w http.ResponseWriter, r *http.Request) {
		channelID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}

		messageID, ok := parseIDParam(w, r, "messageId")
		if !ok {
			return
		}

		// Look up the channel to check if it's a DM.
		ch, chErr := database.GetChannel(channelID)
		if chErr != nil {
			slog.Error("handleSetPinned GetChannel", "err", chErr, "channel_id", channelID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
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

		// DM channels use participant-based auth instead of role-based permissions.
		if ch.Type == "dm" {
			user, _ := r.Context().Value(UserKey).(*db.User)
			if user == nil {
				writeJSON(w, http.StatusUnauthorized, errorResponse{
					Error:   "UNAUTHORIZED",
					Message: "authentication required",
				})
				return
			}
			ok, dmErr := database.IsDMParticipant(user.ID, channelID)
			if dmErr != nil || !ok {
				writeJSON(w, http.StatusNotFound, errorResponse{
					Error:   "NOT_FOUND",
					Message: "channel not found",
				})
				return
			}
		} else {
			// Permission check: user must have MANAGE_MESSAGES on this channel.
			role, _ := r.Context().Value(RoleKey).(*db.Role)
			if !hasChannelPermREST(database, role, channelID, permissions.ManageMessages) {
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "no permission to manage messages in this channel",
				})
				return
			}
		}

		// Verify message exists and belongs to this channel.
		msg, err := database.GetMessage(messageID)
		if err != nil {
			slog.Error("handleSetPinned GetMessage", "err", err, "action", action, "message_id", messageID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to look up message",
			})
			return
		}
		if msg == nil || msg.ChannelID != channelID {
			writeJSON(w, http.StatusNotFound, errorResponse{
				Error:   "NOT_FOUND",
				Message: "message not found",
			})
			return
		}

		if err := database.SetMessagePinned(messageID, pinned); err != nil {
			slog.Error("handleSetPinned SetMessagePinned", "err", err, "action", action, "message_id", messageID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to " + action + " message",
			})
			return
		}

		w.WriteHeader(http.StatusNoContent)
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
