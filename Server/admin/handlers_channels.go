package admin

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/owncord/server/db"
)

// ─── Category-Type Validation ────────────────────────────────────────────────

// voiceCategoryNames is the set of canonical category names treated as voice
// sections. Matching is case-insensitive but requires an exact name match
// (not a substring) to prevent false positives like "Invoice Channels".
var voiceCategoryNames = []string{
	"Voice Channels",
}

// isVoiceCategory returns true if the category name is an exact
// (case-insensitive) match for a known voice category name.
func isVoiceCategory(category string) bool {
	for _, name := range voiceCategoryNames {
		if strings.EqualFold(category, name) {
			return true
		}
	}
	return false
}

// allowedChannelTypes returns the set of channel types valid for a category.
func allowedChannelTypes(category string) []string {
	if category == "" {
		return []string{"text", "voice", "announcement"}
	}
	if isVoiceCategory(category) {
		return []string{"voice"}
	}
	return []string{"text", "announcement"}
}

// validateCategoryType checks that the channel type is allowed under the given
// category. Returns an error message if invalid, or empty string if OK.
func validateCategoryType(channelType, category string) string {
	if category == "" {
		return ""
	}
	allowed := allowedChannelTypes(category)
	for _, t := range allowed {
		if t == channelType {
			return ""
		}
	}
	if isVoiceCategory(category) {
		return "only voice channels can be created under a voice category"
	}
	return "voice channels can only be created under a voice category"
}

// ─── Channel Handlers ────────────────────────────────────────────────────────

func handleListChannels(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channels, err := database.ListChannels()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list channels")
			return
		}
		writeJSON(w, http.StatusOK, channels)
	}
}

// createChannelRequest is the JSON body for POST /admin/api/channels.
type createChannelRequest struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Category string `json:"category"`
	Topic    string `json:"topic"`
	Position int    `json:"position"`
}

func handleCreateChannel(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createChannelRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		if strings.TrimSpace(req.Name) == "" {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "name is required")
			return
		}
		if req.Type == "" {
			req.Type = "text"
		}

		if msg := validateCategoryType(req.Type, req.Category); msg != "" {
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", msg)
			return
		}

		id, err := database.AdminCreateChannel(req.Name, req.Type, req.Category, req.Topic, req.Position)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create channel")
			return
		}

		ch, err := database.GetChannel(id)
		if err != nil || ch == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch created channel")
			return
		}
		actor := actorFromContext(r)
		slog.Info("channel created", "actor_id", actor, "channel", req.Name, "type", req.Type)
		_ = database.LogAudit(actor, "channel_create", "channel", id,
			fmt.Sprintf("created #%s (%s)", req.Name, req.Type))
		if hub != nil {
			hub.BroadcastChannelCreate(ch)
		}
		writeJSON(w, http.StatusCreated, ch)
	}
}

// updateChannelRequest is the JSON body for PATCH /admin/api/channels/{id}.
type updateChannelRequest struct {
	Name     string `json:"name"`
	Topic    string `json:"topic"`
	SlowMode int    `json:"slow_mode"`
	Position int    `json:"position"`
	Archived bool   `json:"archived"`
}

func handlePatchChannel(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid channel id")
			return
		}

		existing, err := database.GetChannel(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch channel")
			return
		}
		if existing == nil {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "channel not found")
			return
		}

		// Start from existing values so a partial body is safe.
		req := updateChannelRequest{
			Name:     existing.Name,
			Topic:    existing.Topic,
			SlowMode: existing.SlowMode,
			Position: existing.Position,
			Archived: existing.Archived,
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		if err := database.AdminUpdateChannel(id, req.Name, req.Topic, req.SlowMode, req.Position, req.Archived); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to update channel")
			return
		}

		actor := actorFromContext(r)
		slog.Info("channel updated", "actor_id", actor, "channel_id", id, "name", req.Name)
		_ = database.LogAudit(actor, "channel_update", "channel", id,
			fmt.Sprintf("updated #%s", req.Name))

		updated, err := database.GetChannel(id)
		if err != nil || updated == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch updated channel")
			return
		}
		if hub != nil {
			hub.BroadcastChannelUpdate(updated)
		}
		writeJSON(w, http.StatusOK, updated)
	}
}

func handleDeleteChannel(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid channel id")
			return
		}

		existing, err := database.GetChannel(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch channel")
			return
		}
		if existing == nil {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "channel not found")
			return
		}

		if err := database.AdminDeleteChannel(id); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to delete channel")
			return
		}
		actor := actorFromContext(r)
		slog.Warn("channel deleted", "actor_id", actor, "channel_id", id, "name", existing.Name)
		_ = database.LogAudit(actor, "channel_delete", "channel", id,
			fmt.Sprintf("deleted #%s", existing.Name))
		if hub != nil {
			hub.BroadcastChannelDelete(id)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleGetAuditLog(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := queryInt(r, "limit", 50, 1)
		offset := queryInt(r, "offset", 0, 0)

		entries, err := database.GetAuditLog(limit, offset)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get audit log")
			return
		}
		writeJSON(w, http.StatusOK, entries)
	}
}
