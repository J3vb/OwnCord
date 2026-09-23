package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

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
