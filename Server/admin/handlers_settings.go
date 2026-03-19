package admin

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/owncord/server/db"
)

// ─── Settings Handlers ──────────────────────────────────────────────────────

func handleGetSettings(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		settings, err := database.GetAllSettings()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get settings")
			return
		}
		writeJSON(w, http.StatusOK, settings)
	}
}

func handlePatchSettings(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var updates map[string]string
		if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		// Validate all keys against the whitelist before writing anything so
		// the operation is atomic from the caller's perspective.
		for key := range updates {
			if _, ok := allowedSettingKeys[key]; !ok {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST",
					fmt.Sprintf("unknown setting key: %q", key))
				return
			}
		}

		actor := actorFromContext(r)

		// Apply all settings atomically so a mid-loop failure doesn't leave
		// partial updates.
		tx, err := database.Begin()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to start transaction")
			return
		}
		for key, value := range updates {
			if _, txErr := tx.Exec(
				`INSERT INTO settings (key, value) VALUES (?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				key, value,
			); txErr != nil {
				_ = tx.Rollback()
				writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to update setting: "+key)
				return
			}
		}
		if err := tx.Commit(); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to commit settings")
			return
		}
		for key := range updates {
			slog.Info("setting changed", "actor_id", actor, "key", key)
			_ = database.LogAudit(actor, "setting_change", "setting", 0,
				fmt.Sprintf("%s updated", key))
		}

		settings, err := database.GetAllSettings()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch settings")
			return
		}
		writeJSON(w, http.StatusOK, settings)
	}
}
