package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// settingsStore is what SettingsService reads and writes. *db.DB satisfies it.
type settingsStore interface {
	channelGetter
	db.Auditor
	settingGetter
	ServerRetentionDays(ctx context.Context) (int, error)
	SearchAuditLog(ctx context.Context, action, query string, hideSignins bool, limit, offset int) ([]db.AuditEntry, error)
	ListAuditActions(ctx context.Context, limit int) ([]string, error)
	CountUsersWithoutTOTP(ctx context.Context) (int, error)
	GetAllSettings(ctx context.Context) (map[string]string, error)
	ApplySettings(ctx context.Context, updates map[string]string) error
}

// SettingsService owns the server-settings policy the admin panel writes and the
// server reads: which keys exist, boolean normalization, the require_2fa
// preconditions and the atomic apply. Handlers are thin adapters; the hub reads
// server identity through it.
type SettingsService struct {
	st settingsStore
	mu syncutil.Mutex
}

// NewSettingsService creates a SettingsService.
func NewSettingsService(st settingsStore) *SettingsService {
	return &SettingsService{st: st}
}

// allowedSettingKeys is the whitelist of keys the admin settings PATCH may write.
// The policy lives here so no handler grows its own copy.
var allowedSettingKeys = map[string]struct{}{
	"server_name":       {},
	"server_icon":       {},
	"motd":              {},
	"require_2fa":       {},
	"registration_mode": {},
	"backup_schedule":   {},
	"backup_retention":  {},
	// Server-wide message-retention days: 0 keeps everything, else at least RetentionMinDays.
	db.RetentionDaysKey:        {},
	UploadBlockedExtensionsKey: {},
	UploadAllowedExtensionsKey: {},
	// Idle time before the AFK sweep may move a member; missing means AFKTimeoutDefaultSeconds.
	AFKTimeoutKey:        {},
	VoiceOwnerMovableKey: {},
	// Whether game activity is shown; MANAGE_SERVER may change it.
	GameActivityEnabledKey: {},
	WelcomeChannelKey:      {},
}

// VoiceOwnerMovableKey holds whether MOVE_MEMBERS holders may move the owner
// between voice channels ("true"/"false"); a missing row means true.
const VoiceOwnerMovableKey = "voice_owner_movable"

// VoiceOwnerMovable reads a stored value: true when blank, the parsed boolean
// otherwise, false when unparseable so a damaged row never lets the owner be moved
// on a guess.
func VoiceOwnerMovable(stored string) bool {
	if strings.TrimSpace(stored) == "" {
		return true
	}
	v, err := parseBooleanSettingValue(stored)
	return err == nil && v
}

// GameActivityEnabledKey holds whether game activity is shown ("true"/"false");
// a missing row means true.
const GameActivityEnabledKey = "game_activity_enabled"

// GameActivityEnabled reads a stored value: true when blank, the parsed boolean
// otherwise, false when unparseable so a damaged row never shows a game the admin
// may have hidden.
func GameActivityEnabled(stored string) bool {
	if strings.TrimSpace(stored) == "" {
		return true
	}
	v, err := parseBooleanSettingValue(stored)
	return err == nil && v
}

// GameActivityEnabledFromRead interprets a read of GameActivityEnabledKey: a
// missing row (db.ErrNotFound) means on, a value parses as GameActivityEnabled
// does, and any other error returns ok=false and the error for the caller to fail
// closed on and log.
func GameActivityEnabledFromRead(stored string, err error) (enabled, ok bool, readErr error) {
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return true, true, nil
		}
		return false, false, fmt.Errorf("read %s: %w", GameActivityEnabledKey, err)
	}
	return GameActivityEnabled(stored), true, nil
}

// AFKTimeoutKey is the settings key holding the AFK timeout in seconds.
const AFKTimeoutKey = "afk_timeout_seconds"

// AFKTimeoutDefaultSeconds is the timeout while AFKTimeoutKey is unset.
const AFKTimeoutDefaultSeconds = 300

// afkTimeoutChoices are the only accepted AFK values, the admin card's offers.
var afkTimeoutChoices = []int{60, 300, 900, 1800, 3600}

// inertSettingKeys are rows the setup wizard writes and GET /settings shows but
// no code reads (config.yaml owns the limits); a PATCH is refused rather than
// accepted and ignored.
var inertSettingKeys = map[string]struct{}{
	"max_upload_bytes": {},
	"voice_quality":    {},
}

// ownerOnlySettingKeys decide the owner-only backup policy. They stay readable
// (GET /settings is MANAGE_SERVER) but a PATCH touching them must come from the
// Owner, as they control which of the owner's backups survive: backup_retention is
// what the sweep prunes by and backup_schedule whether copies are taken.
var ownerOnlySettingKeys = map[string]struct{}{
	"backup_schedule":  {},
	"backup_retention": {},
	// The upload file-type policy decides what members can share; owner-only too.
	UploadBlockedExtensionsKey: {},
	UploadAllowedExtensionsKey: {},
	VoiceOwnerMovableKey:       {},
}

// IsOwnerOnlySettingKey reports whether a key changes the owner-only backup
// policy, so the PATCH requires the Owner for just those keys.
func IsOwnerOnlySettingKey(key string) bool {
	_, ok := ownerOnlySettingKeys[key]
	return ok
}

// Backup retention bounds. The minimum is well above 1 so a low value cannot let
// the sweep prune the history to the newest file; the maximum mirrors the
// message-retention ceiling, past which pruneExpiredBackups' -days*24h overflows.
const (
	BackupRetentionMinDays = 7
	BackupRetentionMaxDays = db.RetentionMaxDays
)

// List returns every setting as a key-to-value map.
func (s *SettingsService) List(ctx context.Context) (map[string]string, error) {
	return s.st.GetAllSettings(ctx)
}

// Setting returns one setting's value; a missing key wraps db.ErrNotFound as the
// store reports it (the hub's identity reads and the backup scheduler branch on it).
func (s *SettingsService) Setting(ctx context.Context, key string) (string, error) {
	return s.st.GetSetting(ctx, key)
}

// ServerName returns server_name, or "" when missing or blank so the caller falls
// back to config.yaml's server.name.
func (s *SettingsService) ServerName(ctx context.Context) (string, error) {
	name, err := s.st.GetSetting(ctx, "server_name")
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return "", nil
		}
		return "", fmt.Errorf("ServerName: %w", err)
	}
	return strings.TrimSpace(name), nil
}

// RegistrationMode returns the live policy: invite for a missing setting, fail
// closed for an unparseable one.
func (s *SettingsService) RegistrationMode(ctx context.Context) (RegistrationMode, error) {
	return RegistrationModeOf(ctx, s.st)
}

// Patch validates, normalizes and atomically applies updates, then writes one
// audit row per changed key. The returned map is the full settings table after the
// apply. Validation failures return ErrBadRequest; nothing is written unless every
// key passes.
func (s *SettingsService) Patch(ctx context.Context, actorID int64, updates map[string]string) (map[string]string, error) {
	// One patch at a time: the registration-mode transition row names the value it
	// replaced, true only if nobody applied another between the read and the apply.
	s.mu.Lock()
	defer s.mu.Unlock()
	// Validate all keys before writing anything so the operation is atomic. %.0w
	// wraps ErrBadRequest without its text: the admin response bodies are pinned to
	// exactly these messages, prefix-free.
	for key := range updates {
		if _, inert := inertSettingKeys[key]; inert {
			return nil, fmt.Errorf("%s is set in config.yaml, not here%.0w", key, ErrBadRequest)
		}
		if _, ok := allowedSettingKeys[key]; !ok {
			return nil, fmt.Errorf("unknown setting key: %q%.0w", key, ErrBadRequest)
		}
	}

	normalized, err := normalizeSettingUpdates(updates)
	if err != nil {
		return nil, fmt.Errorf("%w%.0w", err, ErrBadRequest)
	}

	if value, ok := normalized[WelcomeChannelKey]; ok {
		canonical, err := validateWelcomeChannel(ctx, s.st, value)
		if err != nil {
			// A store fault is the server's, not a bad request.
			if errors.Is(err, ErrInternal) {
				return nil, err
			}
			return nil, fmt.Errorf("%w%.0w", err, ErrBadRequest)
		}
		normalized[WelcomeChannelKey] = canonical
	}

	if err := s.validateRequire2FAUpdate(ctx, normalized); err != nil {
		// A store fault is the server's, not a bad request.
		if errors.Is(err, ErrInternal) {
			return nil, err
		}
		return nil, fmt.Errorf("%w%.0w", err, ErrBadRequest)
	}

	// Read the mode before the apply so the transition row names both ends.
	previousMode := ""
	if _, changingMode := normalized[registrationModeKey]; changingMode {
		mode, err := registrationModeSetting(ctx, s.st)
		if err != nil {
			return nil, fmt.Errorf("Patch: %w", err)
		}
		previousMode = string(mode)
	}
	// Likewise the retention window, audited old -> new.
	previousRetention := ""
	if _, changing := normalized[db.RetentionDaysKey]; changing {
		days, err := s.st.ServerRetentionDays(ctx)
		if err != nil {
			return nil, fmt.Errorf("Patch: %w", err)
		}
		previousRetention = strconv.Itoa(days)
	}

	if err := s.st.ApplySettings(ctx, normalized); err != nil {
		return nil, fmt.Errorf("Patch: %w", err)
	}
	for key := range normalized {
		slog.Info("setting changed", "actor_id", actorID, "key", key)
		// A registration-mode transition is audited by name (old and new), not as
		// "updated".
		if key == registrationModeKey && previousMode != normalized[key] {
			db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "registration_mode_change", "setting", 0,
				fmt.Sprintf("registration_mode %s -> %s", previousMode, normalized[key]))
			continue
		}
		if key == db.RetentionDaysKey {
			db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "retention_policy_change", "setting", 0,
				fmt.Sprintf("retention_days %s -> %s", previousRetention, normalized[key]))
			continue
		}
		db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "setting_change", "setting", 0,
			fmt.Sprintf("%s updated", key))
	}

	return s.st.GetAllSettings(ctx)
}

func normalizeSettingUpdates(updates map[string]string) (map[string]string, error) {
	normalized := make(map[string]string, len(updates))
	for key, value := range updates {
		normalized[key] = value
		if v, ok, err := normalizeValueSetting(key, value); ok {
			if err != nil {
				return nil, err
			}
			normalized[key] = v
			continue
		}
		switch key {
		case "require_2fa":
			parsed, err := parseSettingsPatchBool(value)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", key, err)
			}
			if parsed {
				normalized[key] = "1"
			} else {
				normalized[key] = "0"
			}
		case registrationModeKey:
			mode, ok := ParseRegistrationMode(value)
			if !ok {
				return nil, fmt.Errorf("%s: must be one of closed, invite, approval, open", key)
			}
			normalized[key] = string(mode)
		case db.RetentionDaysKey:
			days, err := normalizeRetentionDays(key, value, RetentionMinDays, RetentionMaxDays)
			if err != nil {
				return nil, err
			}
			normalized[key] = days
		case "backup_retention":
			days, err := normalizeRetentionDays(key, value, BackupRetentionMinDays, BackupRetentionMaxDays)
			if err != nil {
				return nil, err
			}
			normalized[key] = days
		case UploadBlockedExtensionsKey, UploadAllowedExtensionsKey:
			list, err := storage.ParseExtensionList(value)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", key, err)
			}
			normalized[key] = strings.Join(list, ",")
		case AFKTimeoutKey:
			secs, err := normalizeAFKTimeout(key, value)
			if err != nil {
				return nil, err
			}
			normalized[key] = secs
		case "backup_schedule":
			schedule := strings.ToLower(strings.TrimSpace(value))
			switch schedule {
			case "off", "daily", "weekly":
				normalized[key] = schedule
			default:
				return nil, fmt.Errorf("%s: must be one of off, daily, weekly", key)
			}
		}
	}
	return normalized, nil
}

// AFKTimeoutSeconds reads a stored value: the seconds when allowed,
// AFKTimeoutDefaultSeconds for anything else (unset, blank, hand-edited).
func AFKTimeoutSeconds(stored string) int {
	secs, err := strconv.Atoi(strings.TrimSpace(stored))
	if err != nil || !slices.Contains(afkTimeoutChoices, secs) {
		return AFKTimeoutDefaultSeconds
	}
	return secs
}

// normalizeAFKTimeout accepts only afkTimeoutChoices, in canonical decimal form.
func normalizeAFKTimeout(key, value string) (string, error) {
	secs, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || !slices.Contains(afkTimeoutChoices, secs) {
		return "", fmt.Errorf("%s: must be one of 60, 300, 900, 1800, 3600", key)
	}
	return strconv.Itoa(secs), nil
}

// normalizeRetentionDays accepts 0 (keep forever) or [minDays, maxDays], in
// canonical decimal form.
func normalizeRetentionDays(key, value string, minDays, maxDays int) (string, error) {
	days, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || days < 0 || (days != 0 && days < minDays) || days > maxDays {
		return "", fmt.Errorf("%s: must be 0 (keep forever) or between %d and %d", key, minDays, maxDays)
	}
	return strconv.Itoa(days), nil
}

func (s *SettingsService) validateRequire2FAUpdate(ctx context.Context, updates map[string]string) error {
	targetRequire2FA, err := s.targetBoolSetting(ctx, updates, "require_2fa")
	if err != nil {
		return err
	}
	if !targetRequire2FA {
		return nil
	}

	// The preconditions matter only when this request touches require_2fa or the
	// registration mode. Otherwise an unrelated PATCH inherits require_2fa's current
	// value via targetBoolSetting's DB fallback and is rejected for a value it never
	// touches, wedging the settings page once any non-banned user without TOTP exists.
	_, changingRequire2FA := updates["require_2fa"]
	_, changingMode := updates[registrationModeKey]
	if !changingRequire2FA && !changingMode {
		return nil
	}

	// Nobody can enrol before their first login, so a server admitting new accounts
	// cannot demand 2FA of everyone: the mode must be closed, and stay closed while
	// require_2fa is on.
	mode, err := s.targetRegistrationMode(ctx, updates)
	if err != nil {
		return err
	}
	if mode != RegistrationClosed {
		return fmt.Errorf("require_2fa cannot be enabled unless registration is closed")
	}

	// The enrollment count only matters when turning require_2fa on.
	if !changingRequire2FA {
		return nil
	}

	count, err := s.st.CountUsersWithoutTOTP(ctx)
	if err != nil {
		return fmt.Errorf("%w: failed to validate 2FA enrollment: %w", ErrInternal, err)
	}
	if count > 0 {
		return fmt.Errorf("require_2fa cannot be enabled until all users have 2FA enabled")
	}
	return nil
}

// targetRegistrationMode is the mode after this patch: the update's (normalized)
// value, else the live setting.
func (s *SettingsService) targetRegistrationMode(ctx context.Context, updates map[string]string) (RegistrationMode, error) {
	if value, ok := updates[registrationModeKey]; ok {
		mode, ok := ParseRegistrationMode(value)
		if !ok {
			return "", fmt.Errorf("%s: must be one of closed, invite, approval, open", registrationModeKey)
		}
		return mode, nil
	}
	mode, err := registrationModeSetting(ctx, s.st)
	if err != nil {
		return "", fmt.Errorf("%w: failed to read registration mode: %w", ErrInternal, err)
	}
	return mode, nil
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
		return false, fmt.Errorf("%w: failed to read %s: %w", ErrInternal, key, err)
	}
	return parseSettingsPatchBool(value)
}

// parseSettingsPatchBool is auth.go's parseBooleanSettingValue with the admin
// PATCH's own error wording. Both messages are pinned by their sides' tests, so
// the twins stay separate.
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

// AuditLog returns a page of the audit trail for the admin log view. action and
// query narrow it as db.SearchAuditLog describes (empty returns every row);
// hideSignins drops sign-in and connection rows.
func (s *SettingsService) AuditLog(ctx context.Context, action, query string, hideSignins bool, limit, offset int) ([]db.AuditEntry, error) {
	return s.st.SearchAuditLog(ctx, action, query, hideSignins, limit, offset)
}

// AuditActions returns up to limit distinct action names in the audit log, sorted.
func (s *SettingsService) AuditActions(ctx context.Context, limit int) ([]string, error) {
	return s.st.ListAuditActions(ctx, limit)
}
