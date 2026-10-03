package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

// configEnumOptions lists the allowed values of the four enum keys, so the
// panel can render a select. Kept beside the handlers rather than in config
// because it is an API presentation detail; config only enforces membership.
var configEnumOptions = map[string][]string{
	"logging.level":       {"debug", "info", "warn", "error"},
	"server.waf_crs_mode": {"off", "detect", "block"},
	"telemetry.exporter":  {"none", "prometheus", "otlp"},
	"voice.quality":       {"low", "medium", "high"},
}

// confirmHeader names the lock-out-capable keys a PATCH deliberately changes.
// The panel sends it after the owner types the confirmation.
const confirmHeader = "X-OwnCord-Confirm"

// configSettingRow is one editable key in GET/PATCH /config/settings. A secret
// row carries no value or override: only configured/override_set booleans.
type configSettingRow struct {
	Key                  string   `json:"key"`
	Type                 string   `json:"type"`
	Value                any      `json:"value"`
	Override             any      `json:"override"`
	Fallback             any      `json:"fallback,omitempty"`
	EnvLocked            bool     `json:"env_locked"`
	Options              []string `json:"options,omitempty"`
	RequiresConfirmation bool     `json:"requires_confirmation"`
	Configured           *bool    `json:"configured,omitempty"`
	OverrideSet          *bool    `json:"override_set,omitempty"`
}

type configSettingsResponse struct {
	RestartPending bool               `json:"restart_pending"`
	Settings       []configSettingRow `json:"settings"`
}

// buildConfigSettings renders one row per editable key, in EditableKeys order.
// It iterates EditableKeys only — never the whole config — so secrets and the
// other excluded keys can never reach this response.
func buildConfigSettings(cfg, fallback *config.Config, overrides map[string]any, pending bool) configSettingsResponse {
	keys := config.EditableKeys()
	rows := make([]configSettingRow, 0, len(keys))
	for _, key := range keys {
		envLocked := config.EnvOverridden(key)
		row := configSettingRow{
			Key:                  key,
			EnvLocked:            envLocked,
			RequiresConfirmation: config.RequiresConfirmation(key),
		}
		if config.IsSecret(key) {
			// Never place a secret value in the row: the panel only needs to
			// know whether one is configured and whether an override is set.
			configured := secretConfigured(cfg, key)
			overrideSet := overrides[key] != nil
			row.Type = "secret"
			row.Configured = &configured
			row.OverrideSet = &overrideSet
		} else {
			value, _ := config.Lookup(cfg, key)
			value = normalizeSettingValue(value)
			row.Type = configValueType(value)
			row.Value = value
			if override, ok := overrides[key]; ok && !envLocked {
				row.Override = override
			}
			// The value a reset would fall back to (config.yaml plus env),
			// so the panel can show the post-restart address after a reset.
			if fallback != nil {
				if fv, ok := config.Lookup(fallback, key); ok {
					row.Fallback = normalizeSettingValue(fv)
				}
			}
		}
		if options, ok := configEnumOptions[key]; ok {
			row.Options = options
		}
		rows = append(rows, row)
	}
	return configSettingsResponse{RestartPending: pending, Settings: rows}
}

// secretConfigured reports whether the running config holds a non-empty value
// for a secret key, without ever returning the value itself.
func secretConfigured(cfg *config.Config, key string) bool {
	value, _ := config.Lookup(cfg, key)
	s, _ := value.(string)
	return s != ""
}

// unconfirmedKeys returns the lock-out-capable keys in a PATCH body that the
// comma-separated confirmation header does not name, sorted.
func unconfirmedKeys(changes map[string]any, header string) []string {
	confirmed := make(map[string]bool)
	for key := range strings.SplitSeq(header, ",") {
		if key = strings.TrimSpace(key); key != "" {
			confirmed[key] = true
		}
	}
	var missing []string
	for key := range changes {
		if config.RequiresConfirmation(key) && !confirmed[key] {
			missing = append(missing, key)
		}
	}
	slices.Sort(missing)
	return missing
}

// configAuditDetail names the key and the verb only, never the value: a secret
// value or an operator's contact address must not reach the audit log.
func configAuditDetail(key string, value any) string {
	if value == nil {
		return key + " reset"
	}
	if s, ok := value.(string); ok && s == "" && config.IsSecret(key) {
		return key + " cleared"
	}
	return key + " updated"
}

func guardDatabasePath(ctx context.Context, w http.ResponseWriter, g guardContext) bool {
	if !g.has("database.path") || samePath(g.next.Database.Path, g.opts.RunningCfg.Database.Path) {
		return true
	}
	if containerOutsideDataDir(g, g.next.Database.Path, "database.path", w) {
		return false
	}
	info, err := os.Stat(g.next.Database.Path)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "database.path must name an existing database file")
		return false
	}
	if err := db.CheckBackupIntegrity(ctx, g.next.Database.Path); err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "database.path is not a readable OwnCord database")
		return false
	}
	ahead, err := db.CheckBackupSchemaAhead(ctx, g.next.Database.Path)
	if err != nil || len(ahead) > 0 {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "database.path holds a database a newer server wrote")
		return false
	}
	if !dirWritable(filepath.Dir(g.next.Database.Path)) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "database.path: the directory is not writable (SQLite needs its WAL beside the file)")
		return false
	}
	return true
}

// normalizeSettingValue turns a nil slice into an empty one, so a list key
// with no running value serialises as [] rather than null. The panel reads a
// null list as an empty list and would otherwise write a spurious [] override
// on any save.
func normalizeSettingValue(value any) any {
	rv := reflect.ValueOf(value)
	if rv.Kind() == reflect.Slice && rv.IsNil() {
		return reflect.MakeSlice(rv.Type(), 0, 0).Interface()
	}
	return value
}

func configValueType(value any) string {
	if value == nil {
		return "string"
	}
	switch reflect.TypeOf(value).Kind() {
	case reflect.Bool:
		return "bool"
	case reflect.Int:
		return "int"
	case reflect.Float64:
		return "float"
	case reflect.Slice:
		return "list"
	default:
		return "string"
	}
}

func handleGetConfigOverrides(opts SetupOptions, pending *atomic.Bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cfg := opts.RunningCfg
		if cfg == nil {
			writeErr(w, http.StatusServiceUnavailable, "CONFIG_UNAVAILABLE", "running configuration unavailable")
			return
		}
		overrides, err := config.ReadOverrides(config.OverridesPath(cfg.Server.DataDir))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not read configuration overrides")
			return
		}
		writeJSON(w, http.StatusOK, buildConfigSettings(cfg, fallbackConfig(opts.ConfigPath, config.OverridesPath(cfg.Server.DataDir), overrides), overrides, pending.Load()))
	}
}

// fallbackConfig builds the configuration as it would be without any panel
// override, so a row can report the value a reset falls back to. Preview with
// every current override removed yields config.yaml plus the environment; on
// error the rows simply carry no fallback.
func fallbackConfig(cfgPath, overridesPath string, overrides map[string]any) *config.Config {
	stripped := make(map[string]any, len(overrides))
	for key := range overrides {
		stripped[key] = nil
	}
	fallback, err := config.Preview(cfgPath, overridesPath, stripped)
	if err != nil {
		return nil
	}
	return fallback
}

func handlePatchConfigOverrides(database *db.DB, opts SetupOptions, pending *atomic.Bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cfg := opts.RunningCfg
		if cfg == nil {
			writeErr(w, http.StatusServiceUnavailable, "CONFIG_UNAVAILABLE", "running configuration unavailable")
			return
		}
		var changes map[string]any
		if err := json.NewDecoder(r.Body).Decode(&changes); err != nil || len(changes) == 0 {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "a JSON object of config keys is required")
			return
		}
		// The environment applies last, so a saved value would lose at the
		// next boot; refuse the whole request rather than accept it silently.
		for key := range changes {
			if config.EnvOverridden(key) {
				writeErr(w, http.StatusConflict, "ENV_OVERRIDDEN",
					"config key "+key+" is set by the environment and cannot be changed here")
				return
			}
		}
		if err := config.ValidateOverrides(changes); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
		if missing := unconfirmedKeys(changes, r.Header.Get(confirmHeader)); len(missing) > 0 {
			writeErr(w, http.StatusPreconditionRequired, "CONFIRMATION_REQUIRED",
				"these keys need a typed confirmation: "+strings.Join(missing, ","))
			return
		}

		path := config.OverridesPath(cfg.Server.DataDir)
		next, err := config.Preview(opts.ConfigPath, path, changes)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
		if !runConfigGuards(context.WithoutCancel(r.Context()), w, r, opts, next, changes) {
			return
		}
		if err := config.SaveOverrides(path, changes); err != nil {
			switch {
			case errors.Is(err, config.ErrNotEditable), errors.Is(err, config.ErrInvalidValue):
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			default:
				writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not save configuration")
			}
			return
		}

		pending.Store(true)
		actor := actorFromContext(r)
		for key, value := range changes {
			db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "config_override_change", "config", 0, configAuditDetail(key, value))
		}

		overrides, err := config.ReadOverrides(path)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not read configuration overrides")
			return
		}
		writeJSON(w, http.StatusOK, buildConfigSettings(cfg, fallbackConfig(opts.ConfigPath, path, overrides), overrides, pending.Load()))
	}
}

// handleRestartForConfig restarts the server to apply saved overrides, through
// the same restart machinery update, restore and the setup wizard use.
func handleRestartForConfig(database *db.DB, opts SetupOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !tryDirectRestartPending() {
			writeRestartConflict(w)
			return
		}
		actor := actorFromContext(r)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "server_restart_requested", "server", 0, "config_change")
		writeJSON(w, http.StatusAccepted, map[string]bool{"restarting": true})
		restartFn := opts.Restart
		if restartFn == nil {
			restartFn = requestRestart
		}
		go restartFn("config_change")
	}
}
