package admin

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Channel Handlers ────────────────────────────────────────────────────────
//
// Thin adapters over service.ChannelService: the
// name/topic/category contract, the type whitelist, the numeric bounds, the
// audit rows and the delete ordering all live in the service. The handlers
// decode, resolve through the one guild-channel policy, delegate, and fan out to the
// hub from the rows the service returns.

// resolveGuildChannel adapts service.ChannelService.ResolveGuildChannel — the
// one non-DM resolution policy — to this surface: a missing channel
// and a DM id answer an identical 404 (A-2026-08-02). Returns nil when a
// response has already been written.
func resolveGuildChannel(channels *service.ChannelService, w http.ResponseWriter, r *http.Request) *db.Channel {
	if channels == nil {
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "channel service unavailable")
		return nil
	}
	id, err := pathInt64(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid channel id")
		return nil
	}
	ch, err := channels.ResolveGuildChannel(r.Context(), id)
	if err != nil {
		writeChannelErr(w, err)
		return nil
	}
	return ch
}

// writeChannelErr maps ChannelService errors onto admin API responses.
// Validation failures answer INVALID_INPUT with the service's own message —
// the service's validation wording is the response body.
func writeChannelErr(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrPermsChanged) {
		writeErr(w, http.StatusConflict, httperr.CodePermissionsChanged, err.Error())
		return
	}
	if errors.Is(err, service.ErrConflict) {
		writeErr(w, http.StatusConflict, httperr.CodeChannelNameTaken, err.Error())
		return
	}
	writeSvcErr(w, err, "channel not found", httperr.CodeInvalidInput, "channel action failed")
}

func handleListChannels(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if channels == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "channel service unavailable")
			return
		}
		guildChannels, err := channels.AdminListChannelsSynced(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to list channels")
			return
		}
		writeJSON(w, http.StatusOK, guildChannels)
	}
}

// createChannelRequest is the JSON body for POST /admin/api/channels.
type createChannelRequest struct {
	Name string `json:"name"`
	Type string `json:"type"`
	// CategoryID places the channel in that category (0 = none); an unknown id
	// answers 400. Category is the legacy free-text name (matched ignoring
	// case, created when missing, empty = none). category_id wins when both
	// are sent.
	CategoryID int64  `json:"category_id"`
	Category   string `json:"category"`
	Topic      string `json:"topic"`
	Position   int    `json:"position"`
}

// createChannelPostCommitHook, when non-nil, runs synchronously right after
// the create commit, before the post-commit re-read and hub fan-out — so
// tests can land a caller cancellation in that exact window.
var createChannelPostCommitHook func()

func handleCreateChannel(channels *service.ChannelService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if channels == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "channel service unavailable")
			return
		}
		var req createChannelRequest
		if !decodeJSON(w, r, &req) {
			return
		}

		ch, newCats, err := channels.AdminCreateChannel(r.Context(), actorFromContext(r), service.AdminChannelCreate{
			Name:       req.Name,
			Type:       req.Type,
			CategoryID: req.CategoryID,
			Category:   req.Category,
			Topic:      req.Topic,
			Position:   req.Position,
		}, createChannelPostCommitHook)
		if err != nil {
			writeChannelErr(w, err)
			return
		}
		if hub != nil {
			hub.BroadcastChannelCreate(ch)
			// A category made by the legacy category string: managers get
			// the list after the channel frame (see BroadcastChannelCategories
			// on ordering).
			if newCats != nil {
				hub.BroadcastChannelCategories(newCats)
			}
		}
		writeJSON(w, http.StatusCreated, ch)
	}
}

// updateChannelRequest is the JSON body for PATCH /admin/api/channels/{id}.
type updateChannelRequest struct {
	Name  string `json:"name"`
	Topic string `json:"topic"`
	// CategoryID moves the channel into that category (0 = uncategorized);
	// an unknown id answers 400. Category is the legacy free-text name
	// (matched ignoring case, created when missing, empty = none). Neither
	// sent leaves the category alone, and category_id wins when both are.
	CategoryID *int64  `json:"category_id"`
	Category   *string `json:"category"`
	SlowMode   int     `json:"slow_mode"`
	Position   int     `json:"position"`
	Archived   bool    `json:"archived"`
	// NSFW is stored, broadcast and audited; it changes no server-side content
	// behaviour (see migration 025). Clients decide how to present it.
	NSFW bool `json:"nsfw"`
	// Voice capacity limits, enforced on voice join by the ws layer.
	// 0 = unlimited.
	VoiceMaxUsers int `json:"voice_max_users"`
	VoiceMaxVideo int `json:"voice_max_video"`
	// SyncPermissions replaces the channel's overrides with the template of the
	// category it ends up in and marks it synced. Without it, moving
	// a channel to another category keeps its overrides and unsyncs it.
	SyncPermissions bool `json:"sync_permissions"`
}

// patchChannelPostCommitHook mirrors createChannelPostCommitHook for the
// update path's post-commit window.
var patchChannelPostCommitHook func()

func handlePatchChannel(channels *service.ChannelService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		existing := resolveGuildChannel(channels, w, r)
		if existing == nil {
			return
		}

		// Start from existing values so a partial body is safe.
		req := updateChannelRequest{
			Name:          existing.Name,
			Topic:         existing.Topic,
			SlowMode:      existing.SlowMode,
			Position:      existing.Position,
			Archived:      existing.Archived,
			NSFW:          existing.NSFW,
			VoiceMaxUsers: existing.VoiceMaxUsers,
			VoiceMaxVideo: existing.VoiceMaxVideo,
		}
		if !decodeJSON(w, r, &req) {
			return
		}

		// Keep the category unless the body names one: category_id wins, then
		// the legacy name; neither sent leaves the channel where it is.
		categoryID, legacyName, keepCategory := existing.CategoryID, (*string)(nil), true
		switch {
		case req.CategoryID != nil:
			categoryID, keepCategory = *req.CategoryID, false
		case req.Category != nil:
			categoryID, legacyName, keepCategory = 0, req.Category, false
		}

		updated, newCats, err := channels.AdminUpdateChannel(r.Context(), actorFromContext(r), existing, service.AdminChannelUpdate{
			Name:          req.Name,
			Topic:         req.Topic,
			CategoryID:    categoryID,
			Category:      legacyName,
			KeepCategory:  keepCategory,
			SlowMode:      req.SlowMode,
			Position:      req.Position,
			Archived:      req.Archived,
			NSFW:          req.NSFW,
			VoiceMaxUsers: req.VoiceMaxUsers,
			VoiceMaxVideo: req.VoiceMaxVideo,

			SyncPermissions: req.SyncPermissions,
			ActorRole:       actorRoleFromContext(r),
		}, patchChannelPostCommitHook)
		if err != nil {
			writeChannelErr(w, err)
			return
		}
		if hub != nil {
			hub.BroadcastChannelUpdate(updated)
			if newCats != nil {
				hub.BroadcastChannelCategories(newCats)
			}
			// Archiving/unarchiving changes who sees the channel, not just its
			// metadata — send targeted channel_create/channel_delete so
			// connected clients re-sync without a reconnect. Archiving also
			// hides a voice channel the way deleting does, so live
			// participants are evicted first, matching the delete ordering.
			if existing.Archived != updated.Archived {
				if !existing.Archived && updated.Archived {
					hub.CleanupVoiceForChannel(existing.ID)
				}
				hub.RefreshChannelVisibility(updated)
			}
		}
		writeJSON(w, http.StatusOK, updated)
	}
}

func handleDeleteChannel(channels *service.ChannelService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		existing := resolveGuildChannel(channels, w, r)
		if existing == nil {
			return
		}

		var evict func(int64)
		if hub != nil {
			evict = hub.CleanupVoiceForChannel
		}
		archivedRow, err := channels.AdminDeleteChannel(r.Context(), actorFromContext(r), existing, evict)
		if err != nil {
			// The service archived the channel before the delete failed — tell
			// connected clients about the state that did change instead of
			// leaving them stuck on a live channel that now 403s everywhere.
			if hub != nil && archivedRow != nil {
				hub.BroadcastChannelUpdate(archivedRow)
				hub.RefreshChannelVisibility(archivedRow)
			}
			writeChannelErr(w, err)
			return
		}
		if hub != nil {
			hub.BroadcastChannelDelete(existing.ID)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// Longest audit search text and action filter the log view accepts. Real
// action names are short snake_case identifiers; the search is a phrase an
// operator types.
const (
	maxAuditQueryRunes = 100
	maxAuditActionLen  = 64
	maxAuditActions    = 200
)

func handleGetAuditLog(settings *service.SettingsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if settings == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "settings service unavailable")
			return
		}
		limit := queryInt(r, "limit", 50, 1, 500)
		offset := queryInt(r, "offset", 0, 0, math.MaxInt32)
		// q searches the whole log (actor, action, target type, detail) and
		// action narrows it to one action, so the panel's search is not
		// limited to the page it happened to fetch. hide_signins=1 drops the
		// sign-in and connection rows (the panel's Sign-ins chip, off by
		// default).
		query := strings.TrimSpace(r.URL.Query().Get("q"))
		action := r.URL.Query().Get("action")
		hideSignins := r.URL.Query().Get("hide_signins") == "1"
		if !utf8.ValidString(query) || utf8.RuneCountInString(query) > maxAuditQueryRunes {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, fmt.Sprintf("q must be valid text of at most %d characters", maxAuditQueryRunes))
			return
		}
		if !utf8.ValidString(action) || len(action) > maxAuditActionLen {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, fmt.Sprintf("action must be valid text of at most %d bytes", maxAuditActionLen))
			return
		}

		entries, err := settings.AuditLog(r.Context(), action, query, hideSignins, limit, offset)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to get audit log")
			return
		}
		// The first page also names every action in the whole log, so the
		// panel's action filter is not limited to the rows it has fetched.
		// A header, because the body is a bare array.
		if offset == 0 {
			actions, err := settings.AuditActions(r.Context(), maxAuditActions)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to get audit log")
				return
			}
			names, err := json.Marshal(actions)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to get audit log")
				return
			}
			w.Header().Set("X-Audit-Actions", string(names))
		}
		writeJSON(w, http.StatusOK, entries)
	}
}
