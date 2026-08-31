package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// SettingsService owns the server-settings policy the admin panel writes and
// the rest of the server reads: which keys exist, how boolean values are
// normalized, the require_2fa preconditions, and the atomic apply. Handlers
// are thin adapters over it (B3-8 settings/audit family); the hub reads
// server identity through it instead of the raw handle.
type SettingsService struct {
	st Store
}

// NewSettingsService creates a SettingsService.
func NewSettingsService(st Store) *SettingsService {
	return &SettingsService{st: st}
}

// allowedSettingKeys is the whitelist of keys that may be written via the
// admin settings PATCH. Derived from the settings table in SCHEMA.md. The
// policy lives here so no handler can grow its own copy.
var allowedSettingKeys = map[string]struct{}{
	"server_name":       {},
	"server_icon":       {},
	"motd":              {},
	"max_upload_bytes":  {},
	"voice_quality":     {},
	"require_2fa":       {},
	"registration_open": {},
	"backup_schedule":   {},
	"backup_retention":  {},
}

// List returns every setting as a key→value map.
func (s *SettingsService) List(ctx context.Context) (map[string]string, error) {
	return s.st.GetAllSettings(ctx)
}

// Setting returns one setting's value. Errors wrap db.ErrNotFound for a
// missing key, exactly as the store reports it — the hub's identity reads
// and the backup scheduler both branch on that.
func (s *SettingsService) Setting(ctx context.Context, key string) (string, error) {
	return s.st.GetSetting(ctx, key)
}

// Patch validates, normalizes and atomically applies updates, then writes
// one audit row per changed key attributed to actorID. The returned map is
// the full settings table after the apply (the admin panel re-renders from
// it). Validation failures return ErrBadRequest with the reason; nothing is
// written unless every key passes.
func (s *SettingsService) Patch(ctx context.Context, actorID int64, updates map[string]string) (map[string]string, error) {
	// Validate all keys against the whitelist before writing anything so the
	// operation is atomic from the caller's perspective. The %.0w verb wraps
	// ErrBadRequest without adding its text: the admin surface's response
	// bodies are pinned to exactly these messages, prefix-free.
	for key := range updates {
		if _, ok := allowedSettingKeys[key]; !ok {
			return nil, fmt.Errorf("unknown setting key: %q%.0w", key, ErrBadRequest)
		}
	}

	normalized, err := normalizeSettingUpdates(updates)
	if err != nil {
		return nil, fmt.Errorf("%s%.0w", err.Error(), ErrBadRequest)
	}

	if err := s.validateRequire2FAUpdate(ctx, normalized); err != nil {
		return nil, fmt.Errorf("%s%.0w", err.Error(), ErrBadRequest)
	}

	if err := s.st.ApplySettings(ctx, normalized); err != nil {
		return nil, fmt.Errorf("Patch: %w", err)
	}
	for key := range normalized {
		slog.Info("setting changed", "actor_id", actorID, "key", key)
		db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "setting_change", "setting", 0,
			fmt.Sprintf("%s updated", key))
	}

	return s.st.GetAllSettings(ctx)
}

func normalizeSettingUpdates(updates map[string]string) (map[string]string, error) {
	normalized := make(map[string]string, len(updates))
	for key, value := range updates {
		normalized[key] = value
		switch key {
		case "require_2fa", "registration_open":
			parsed, err := parseSettingsPatchBool(value)
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

func (s *SettingsService) validateRequire2FAUpdate(ctx context.Context, updates map[string]string) error {
	targetRequire2FA, err := s.targetBoolSetting(ctx, updates, "require_2fa")
	if err != nil {
		return err
	}
	if !targetRequire2FA {
		return nil
	}

	registrationOpen, err := s.targetBoolSetting(ctx, updates, "registration_open")
	if err != nil {
		return err
	}
	if registrationOpen {
		return fmt.Errorf("require_2fa cannot be enabled while registration is open")
	}

	// The enrollment count only matters when this request is actually turning
	// require_2fa on. Without this guard, an unrelated PATCH (motd, server
	// name, backup settings, ...) inherits require_2fa's *current* value via
	// targetBoolSetting's DB fallback and gets rejected by a precondition
	// about a value it never touches — wedging the whole settings page once
	// any non-banned user without TOTP exists.
	if _, changingRequire2FA := updates["require_2fa"]; !changingRequire2FA {
		return nil
	}

	count, err := s.st.CountUsersWithoutTOTP(ctx)
	if err != nil {
		return fmt.Errorf("failed to validate 2FA enrollment")
	}
	if count > 0 {
		return fmt.Errorf("require_2fa cannot be enabled until all users have 2FA enabled")
	}
	return nil
}

func (s *SettingsService) targetBoolSetting(ctx context.Context, updates map[string]string, key string) (bool, error) {
	if value, ok := updates[key]; ok {
		return parseSettingsPatchBool(value)
	}
	value, err := s.st.GetSetting(ctx, key)
	if errors.Is(err, db.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return parseSettingsPatchBool(value)
}

// parseSettingsPatchBool is auth.go's parseBooleanSettingValue with the
// admin PATCH's own error wording ("invalid boolean value", no "setting").
// Both messages are pinned by their sides' tests, so the twins stay
// separate rather than either surface changing its reply.
func parseSettingsPatchBool(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true":
		return true, nil
	case "0", "false":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean value %q", value)
	}
}

// AuditLog returns a page of the audit trail — the settings/audit family
// owns the read the admin panel's log view uses.
func (s *SettingsService) AuditLog(ctx context.Context, limit, offset int) ([]db.AuditEntry, error) {
	return s.st.GetAuditLog(ctx, limit, offset)
}
