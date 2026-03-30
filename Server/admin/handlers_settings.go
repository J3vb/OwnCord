package admin

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

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

		normalizedUpdates, err := normalizeSettingUpdates(updates)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}

		if err := validateRequire2FAUpdate(database, normalizedUpdates); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}

		actor := actorFromContext(r)

		// Apply all settings atomically so a mid-loop failure doesn't leave
		// partial updates.
		tx, err := database.Begin()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to start transaction")
			return
		}
		for key, value := range normalizedUpdates {
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
		for key := range normalizedUpdates {
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

func normalizeSettingUpdates(updates map[string]string) (map[string]string, error) {
	normalized := make(map[string]string, len(updates))
	for key, value := range updates {
		normalized[key] = value
		switch key {
		case "require_2fa", "registration_open":
			parsed, err := parseBooleanSettingValue(value)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", key, err)
			}
			if parsed {
				normalized[key] = "1"
			} else {
				normalized[key] = "0"
			}
		}
	}
	return normalized, nil
}

func validateRequire2FAUpdate(database *db.DB, updates map[string]string) error {
	targetRequire2FA, err := targetBoolSetting(database, updates, "require_2fa")
	if err != nil {
		return err
	}
	if !targetRequire2FA {
		return nil
	}

	registrationOpen, err := targetBoolSetting(database, updates, "registration_open")
	if err != nil {
		return err
	}
	if registrationOpen {
		return fmt.Errorf("require_2fa cannot be enabled while registration is open")
	}

	count, err := database.CountUsersWithoutTOTP()
	if err != nil {
		return fmt.Errorf("failed to validate 2FA enrollment")
	}
	if count > 0 {
		return fmt.Errorf("require_2fa cannot be enabled until all users have 2FA enabled")
	}
	return nil
}

func targetBoolSetting(database *db.DB, updates map[string]string, key string) (bool, error) {
	if value, ok := updates[key]; ok {
		return parseBooleanSettingValue(value)
	}
	value, err := database.GetSetting(key)
	if errors.Is(err, db.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return parseBooleanSettingValue(value)
}

func parseBooleanSettingValue(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true":
		return true, nil
	case "0", "false":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean value %q", value)
	}
}
