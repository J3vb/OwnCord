package admin

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Channel Handlers ────────────────────────────────────────────────────────
//
// Thin adapters over service.ChannelService (B3-8 channel family): the S-03
// name/topic/category contract, the type whitelist, the numeric bounds, the
// audit rows and the delete ordering all live in the service. The handlers
// decode, resolve through the one S-04 policy, delegate, and fan out to the
// hub from the rows the service returns.

// resolveGuildChannel adapts service.ChannelService.ResolveGuildChannel — the
// one non-DM resolution policy (S-04) — to this surface: a missing channel
// and a DM id answer an identical 404 (A-2026-08-02). Returns nil when a
// response has already been written.
func resolveGuildChannel(channels *service.ChannelService, w http.ResponseWriter, r *http.Request) *db.Channel {
	id, err := pathInt64(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid channel id")
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
// the S-03 contract's wording is the response body.
func writeChannelErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "channel not found")
	case errors.Is(err, service.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, "INVALID_INPUT", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "channel action failed")
	}
}

func handleListChannels(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		guildChannels, err := channels.AdminListChannels(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list channels")
			return
		}
		writeJSON(w, http.StatusOK, guildChannels)
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

// createChannelPostCommitHook, when non-nil, runs synchronously right after
// the create commit, before the post-commit re-read and hub fan-out — so
// tests can land a caller cancellation in that exact window (OC-0158).
var createChannelPostCommitHook func()

func handleCreateChannel(channels *service.ChannelService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createChannelRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		ch, err := channels.AdminCreateChannel(r.Context(), actorFromContext(r), service.AdminChannelCreate{
			Name:     req.Name,
			Type:     req.Type,
			Category: req.Category,
			Topic:    req.Topic,
			Position: req.Position,
		}, createChannelPostCommitHook)
		if err != nil {
			writeChannelErr(w, err)
			return
		}
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
	Category string `json:"category"`
	SlowMode int    `json:"slow_mode"`
	Position int    `json:"position"`
	Archived bool   `json:"archived"`
	// NSFW is stored, broadcast and audited; it changes no server-side content
	// behaviour (see migration 025). Clients decide how to present it.
	NSFW bool `json:"nsfw"`
	// Voice capacity limits, enforced on voice join by the ws layer.
	// 0 = unlimited.
	VoiceMaxUsers int `json:"voice_max_users"`
	VoiceMaxVideo int `json:"voice_max_video"`
}

// patchChannelPostCommitHook mirrors createChannelPostCommitHook for the
// update path's post-commit window (OC-0158).
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
			Category:      existing.Category,
			SlowMode:      existing.SlowMode,
			Position:      existing.Position,
			Archived:      existing.Archived,
			NSFW:          existing.NSFW,
			VoiceMaxUsers: existing.VoiceMaxUsers,
			VoiceMaxVideo: existing.VoiceMaxVideo,
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		updated, err := channels.AdminUpdateChannel(r.Context(), actorFromContext(r), existing, service.AdminChannelUpdate{
			Name:          req.Name,
			Topic:         req.Topic,
			Category:      req.Category,
			SlowMode:      req.SlowMode,
			Position:      req.Position,
			Archived:      req.Archived,
			NSFW:          req.NSFW,
			VoiceMaxUsers: req.VoiceMaxUsers,
			VoiceMaxVideo: req.VoiceMaxVideo,
		}, patchChannelPostCommitHook)
		if err != nil {
			writeChannelErr(w, err)
			return
		}

		if hub != nil {
			hub.BroadcastChannelUpdate(updated)
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

func handleGetAuditLog(settings *service.SettingsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := queryInt(r, "limit", 50, 1, 500)
		offset := queryInt(r, "offset", 0, 0, math.MaxInt32)

		entries, err := settings.AuditLog(r.Context(), limit, offset)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get audit log")
			return
		}
		writeJSON(w, http.StatusOK, entries)
	}
}
