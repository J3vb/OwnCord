package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"strings"

	"github.com/owncord/server/db"
)

// ─── Channel Type Validation ─────────────────────────────────────────────────

// validChannelTypes is the set of channel types a create request may name.
// A channel's CATEGORY deliberately constrains nothing: categories are free
// text, and pinning "only voice channels live under a category whose name
// matches 'Voice Channels'" made every other category name a second-class one —
// a voice channel could not be created under "Gaming", and renaming the
// category silently changed what could be created there. Grouping is a display
// concern (the client groups by whatever category a channel carries), so the
// server validates the type alone.
var validChannelTypes = []string{"text", "voice", "announcement"}

// validateChannelType returns an error message when the type is not one of the
// three real channel types, or an empty string when it is.
func validateChannelType(channelType string) string {
	if slices.Contains(validChannelTypes, channelType) {
		return ""
	}
	return "type must be one of text, voice, announcement"
}

// ─── Channel Handlers ────────────────────────────────────────────────────────

// getAdminChannel loads the channel targeted by an admin channel mutation and
// writes the error response when it is missing — or when it is a DM. DMs and
// group DMs share the channels table and id space with guild channels, but
// they belong to their participants, not to MANAGE_CHANNELS holders: listing,
// renaming or deleting one from the admin surface would leak or destroy a
// private conversation (A-2026-08-02). A DM id answers 404 rather than 403 so
// the surface does not confirm which ids are private conversations. Returns
// nil when a response has already been written.
func getAdminChannel(database *db.DB, w http.ResponseWriter, r *http.Request) *db.Channel {
	id, err := pathInt64(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid channel id")
		return nil
	}
	ch, err := database.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch channel")
		return nil
	}
	if ch == nil || ch.Type == "dm" {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "channel not found")
		return nil
	}
	return ch
}

func handleListChannels(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channels, err := database.ListChannels(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list channels")
			return
		}
		// The admin surface manages guild channels. DM rows live in the same
		// table but are private conversations — enumerating them here exposed
		// ids and user-chosen group names to any MANAGE_CHANNELS holder
		// (A-2026-08-02). Filtered in Go because the sqlc ListChannels query is
		// shared with the ready path, which applies its own visibility rules.
		guildChannels := make([]db.Channel, 0, len(channels))
		for i := range channels {
			if channels[i].Type != "dm" {
				guildChannels = append(guildChannels, channels[i])
			}
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

		if msg := validateChannelType(req.Type); msg != "" {
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", msg)
			return
		}

		id, err := database.AdminCreateChannel(r.Context(), req.Name, req.Type, req.Category, req.Topic, req.Position)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create channel")
			return
		}

		ch, err := database.GetChannel(r.Context(), id)
		if err != nil || ch == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch created channel")
			return
		}
		actor := actorFromContext(r)
		slog.Info("channel created", "actor_id", actor, "channel", req.Name, "type", req.Type)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "channel_create", "channel", id,
			fmt.Sprintf("created #%s (%s)", req.Name, req.Type))
		if hub != nil {
			hub.BroadcastChannelCreate(ch)
		}
		writeJSON(w, http.StatusCreated, ch)
	}
}

// Bounds for the numeric channel settings a PATCH may set.
//
// They are validated here rather than left to the database because SQLite
// would happily store a slow mode of six years or a user limit of -3, and the
// only place that would surface is a client rendering nonsense. The values
// match what the clients offer: Discord's 6-hour slow-mode ceiling, and a
// two-digit voice capacity (0 = unlimited in both voice cases).
const (
	maxSlowModeSeconds = 21600
	maxVoiceLimit      = 99
)

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

// validate reports the first out-of-range numeric field, or "" when the
// request is acceptable. Negative values are rejected rather than clamped: a
// caller sending -1 meant something, and silently storing 0 would hide it.
func (r updateChannelRequest) validate() string {
	switch {
	case strings.TrimSpace(r.Name) == "":
		return "name is required"
	case r.SlowMode < 0 || r.SlowMode > maxSlowModeSeconds:
		return fmt.Sprintf("slow_mode must be between 0 and %d seconds", maxSlowModeSeconds)
	case r.VoiceMaxUsers < 0 || r.VoiceMaxUsers > maxVoiceLimit:
		return fmt.Sprintf("voice_max_users must be between 0 and %d", maxVoiceLimit)
	case r.VoiceMaxVideo < 0 || r.VoiceMaxVideo > maxVoiceLimit:
		return fmt.Sprintf("voice_max_video must be between 0 and %d", maxVoiceLimit)
	}
	return ""
}

// nsfwAuditSuffix names an NSFW transition in the audit detail, or returns ""
// when the flag did not move. An age-gate flag flipping is the one part of a
// channel edit an operator may need to answer for later, and "updated #foo"
// alone would not record it.
func nsfwAuditSuffix(before, after bool) string {
	if before == after {
		return ""
	}
	if after {
		return " (marked NSFW)"
	}
	return " (unmarked NSFW)"
}

func handlePatchChannel(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		existing := getAdminChannel(database, w, r)
		if existing == nil {
			return
		}
		id := existing.ID

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

		if msg := req.validate(); msg != "" {
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", msg)
			return
		}

		if err := database.AdminUpdateChannel(r.Context(), id, db.ChannelUpdate{
			Name:          req.Name,
			Topic:         req.Topic,
			Category:      strings.TrimSpace(req.Category),
			SlowMode:      req.SlowMode,
			Position:      req.Position,
			Archived:      req.Archived,
			NSFW:          req.NSFW,
			VoiceMaxUsers: req.VoiceMaxUsers,
			VoiceMaxVideo: req.VoiceMaxVideo,
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to update channel")
			return
		}

		actor := actorFromContext(r)
		slog.Info("channel updated", "actor_id", actor, "channel_id", id, "name", req.Name, "nsfw", req.NSFW)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "channel_update", "channel", id,
			fmt.Sprintf("updated #%s%s", req.Name, nsfwAuditSuffix(existing.NSFW, req.NSFW)))

		updated, err := database.GetChannel(r.Context(), id)
		if err != nil || updated == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch updated channel")
			return
		}
		if hub != nil {
			hub.BroadcastChannelUpdate(updated)
			// Archiving/unarchiving changes who sees the channel, not just its
			// metadata — send targeted channel_create/channel_delete so
			// connected clients re-sync without a reconnect.
			if existing.Archived != updated.Archived {
				// Archiving hides a voice channel the same way deleting it
				// does — nobody can see it or reach it afterward — so live
				// participants must be evicted the same way handleDeleteChannel
				// evicts them, or they keep their DB row, VoiceTopic
				// subscription and LiveKit session in a room nothing shows.
				// Order matches handleDeleteChannel: evict before the
				// visibility change so a voice_leave lands on clients that
				// still have the channel subscribed.
				if !existing.Archived && updated.Archived {
					hub.CleanupVoiceForChannel(id)
				}
				hub.RefreshChannelVisibility(updated)
			}
		}
		writeJSON(w, http.StatusOK, updated)
	}
}

func handleDeleteChannel(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		existing := getAdminChannel(database, w, r)
		if existing == nil {
			return
		}
		id := existing.ID

		// Mark the channel archived BEFORE evicting participants, mirroring the
		// archive path (handlePatchChannel): CleanupVoiceForChannel snapshots
		// voice participants ONCE, up front, so a voice_join racing this delete
		// could otherwise read the still-live channel row, pass the archived
		// gate (ws/voice_join.go), and insert a voice_states row after the
		// snapshot but before AdminDeleteChannel's cascade — leaving that
		// joiner's hub-side voice state and LiveKit session orphaned with no
		// DB row left for any sweep to find (OC-0035). Persisting archived=1
		// first makes voice_join's existing archived check refuse that join
		// outright, the same way it already refuses one racing an archive.
		if !existing.Archived {
			if err := database.AdminUpdateChannel(r.Context(), id, db.ChannelUpdate{
				Name:          existing.Name,
				Topic:         existing.Topic,
				Category:      existing.Category,
				SlowMode:      existing.SlowMode,
				Position:      existing.Position,
				Archived:      true,
				NSFW:          existing.NSFW,
				VoiceMaxUsers: existing.VoiceMaxUsers,
				VoiceMaxVideo: existing.VoiceMaxVideo,
			}); err != nil {
				writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to delete channel")
				return
			}
		}

		// Evict voice participants BEFORE deleting the row: the voice_states
		// FK cascade wipes the rows the cleanup reads, and the stale sweeper
		// cannot recover participants of a channel that no longer exists.
		if hub != nil {
			hub.CleanupVoiceForChannel(id)
		}

		if err := database.AdminDeleteChannel(r.Context(), id); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to delete channel")
			return
		}
		actor := actorFromContext(r)
		slog.Warn("channel deleted", "actor_id", actor, "channel_id", id, "name", existing.Name)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "channel_delete", "channel", id,
			fmt.Sprintf("deleted #%s", existing.Name))
		if hub != nil {
			hub.BroadcastChannelDelete(id)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleGetAuditLog(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := queryInt(r, "limit", 50, 1, 500)
		offset := queryInt(r, "offset", 0, 0, math.MaxInt32)

		entries, err := database.GetAuditLog(r.Context(), limit, offset)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get audit log")
			return
		}
		writeJSON(w, http.StatusOK, entries)
	}
}
