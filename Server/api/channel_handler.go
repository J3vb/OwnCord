package api

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

const (
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
		r.Get("/{id}/pins", handleGetPins(database))
		r.Post("/{id}/pins/{messageId}", handleSetPinned(database, true))
		r.Delete("/{id}/pins/{messageId}", handleSetPinned(database, false))
	})
	r.With(AuthMiddleware(database)).Get("/api/v1/search", handleSearch(database))
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
				Error:   "INTERNAL",
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
					Error:   "INTERNAL",
					Message: "failed to fetch channel permissions",
				})
				return
			}
		}

		// Filter channels by READ_MESSAGES permission.
		var visible []db.Channel
		for _, ch := range channels {
			if hasChannelPermBatch(role, overrides, ch.ID, permissions.ReadMessages) {
				visible = append(visible, ch)
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
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "not a participant in this DM",
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
			slog.Error("handleSearch SearchMessages", "err", err, "query", q)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL",
				Message: "search failed",
			})
			return
		}

		// Batch-fetch overrides and post-filter results by READ_MESSAGES.
		role, _ := r.Context().Value(RoleKey).(*db.Role)
		user, _ := r.Context().Value(UserKey).(*db.User)
		overrides := map[int64]db.ChannelOverride{}
		if role != nil && !permissions.HasAdmin(role.Permissions) {
			var oErr error
			overrides, oErr = database.GetAllChannelPermissionsForRole(role.ID)
			if oErr != nil {
				slog.Error("handleSearch GetAllChannelPermissionsForRole", "err", oErr)
			}
		}

		// Build a cache of channel types so we can detect DM channels without
		// repeated queries for the same channel ID.
		channelTypeCache := map[int64]string{}
		for _, res := range results {
			if _, seen := channelTypeCache[res.ChannelID]; !seen {
				ch, chErr := database.GetChannel(res.ChannelID)
				if chErr != nil || ch == nil {
					channelTypeCache[res.ChannelID] = ""
					continue
				}
				channelTypeCache[res.ChannelID] = ch.Type
			}
		}

		var filtered []db.MessageSearchResult
		for _, res := range results {
			chType := channelTypeCache[res.ChannelID]
			if chType == "dm" {
				// DM channels require participant-based auth.
				if user == nil {
					continue
				}
				ok, dmErr := database.IsDMParticipant(user.ID, res.ChannelID)
				if dmErr != nil || !ok {
					continue
				}
			} else {
				if !hasChannelPermBatch(role, overrides, res.ChannelID, permissions.ReadMessages) {
					continue
				}
			}
			filtered = append(filtered, res)
		}
		if filtered == nil {
			filtered = []db.MessageSearchResult{}
		}

		type response struct {
			Results []db.MessageSearchResult `json:"results"`
		}
		writeJSON(w, http.StatusOK, response{Results: filtered})
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
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "not a participant in this DM",
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
				Error:   "INTERNAL",
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
				writeJSON(w, http.StatusForbidden, errorResponse{
					Error:   "FORBIDDEN",
					Message: "not a participant in this DM",
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
				Error:   "INTERNAL",
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
				Error:   "INTERNAL",
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
