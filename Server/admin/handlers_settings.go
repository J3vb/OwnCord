package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Settings Handlers ──────────────────────────────────────────────────────
//
// Thin adapters over service.SettingsService (B3-8 settings/audit family):
// the whitelist, boolean normalization, require_2fa preconditions, atomic
// apply and audit rows all live in the service.

func handleGetSettings(settings *service.SettingsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if settings == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "settings service unavailable")
			return
		}
		all, err := settings.List(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get settings")
			return
		}
		writeJSON(w, http.StatusOK, all)
	}
}

// configFactsResponse is GET /config: the config.yaml values the Settings
// page shows as read-only facts. They come from the configuration the server
// booted with, not from the settings rows of the same name, which only the
// setup wizard writes and which go stale when config.yaml is edited.
type configFactsResponse struct {
	UploadMaxSizeMB int    `json:"upload_max_size_mb"`
	VoiceQuality    string `json:"voice_quality"`
}

func handleGetConfigFacts(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if cfg == nil {
			writeErr(w, http.StatusServiceUnavailable, "CONFIG_UNAVAILABLE", "running configuration unavailable")
			return
		}
		writeJSON(w, http.StatusOK, configFactsResponse{
			UploadMaxSizeMB: cfg.Upload.MaxSizeMB,
			VoiceQuality:    cfg.Voice.Quality,
		})
	}
}

func handlePatchSettings(settings *service.SettingsService, retention *service.RetentionService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if settings == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "settings service unavailable")
			return
		}
		var updates map[string]string
		if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		// The backup policy is owner-only (BPR-072): these keys decide which
		// scheduled copies survive and whether new ones are taken, so a
		// MANAGE_SERVER (or ADMINISTRATOR) non-owner must not reach them even
		// though the rest of the settings page is theirs. Refuse the whole
		// request rather than silently dropping the keys — a partial write
		// would report success for a policy the caller cannot set.
		for key := range updates {
			if service.IsOwnerOnlySettingKey(key) && !isOwnerFromContext(r) {
				writeErr(w, http.StatusForbidden, "FORBIDDEN", "owner role required")
				return
			}
		}

		if value, changing := updates["retention_days"]; changing {
			if retention == nil {
				writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "retention service unavailable")
				return
			}
			days, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil || len(updates) != 1 {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "preview and apply retention_days separately from other settings")
				return
			}
			if err := retention.ApplyChange(r.Context(), actorFromContext(r), service.RetentionChange{Scope: "server", Days: &days}, r.Header.Get("X-Retention-Preview")); err != nil {
				writeRetentionErr(w, err)
				return
			}
			handleGetSettings(settings)(w, r)
			return
		}

		all, err := settings.Patch(r.Context(), actorFromContext(r), updates)
		if errors.Is(err, service.ErrBadRequest) {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to update settings")
			return
		}
		writeJSON(w, http.StatusOK, all)
	}
}
