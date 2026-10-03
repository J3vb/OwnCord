package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
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

// configSettingRow is one editable key in GET/PATCH /config/settings.
type configSettingRow struct {
	Key       string   `json:"key"`
	Type      string   `json:"type"`
	Value     any      `json:"value"`
	Override  any      `json:"override"`
	EnvLocked bool     `json:"env_locked"`
	Options   []string `json:"options,omitempty"`
}

type configSettingsResponse struct {
	RestartPending bool               `json:"restart_pending"`
	Settings       []configSettingRow `json:"settings"`
}

// buildConfigSettings renders one row per editable key, in EditableKeys order.
// It iterates EditableKeys only — never the whole config — so secrets and the
// other excluded keys can never reach this response.
func buildConfigSettings(cfg *config.Config, overrides map[string]any, pending bool) configSettingsResponse {
	keys := config.EditableKeys()
	rows := make([]configSettingRow, 0, len(keys))
	for _, key := range keys {
		value, _ := config.Lookup(cfg, key)
		value = normalizeSettingValue(value)
		envLocked := config.EnvOverridden(key)
		row := configSettingRow{
			Key:       key,
			Type:      configValueType(value),
			Value:     value,
			EnvLocked: envLocked,
		}
		if override, ok := overrides[key]; ok && !envLocked {
			row.Override = override
		}
		if options, ok := configEnumOptions[key]; ok {
			row.Options = options
		}
		rows = append(rows, row)
	}
	return configSettingsResponse{RestartPending: pending, Settings: rows}
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
		writeJSON(w, http.StatusOK, buildConfigSettings(cfg, overrides, pending.Load()))
	}
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

		path := config.OverridesPath(cfg.Server.DataDir)
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
			detail := key + " updated"
			if value == nil {
				detail = key + " reset"
			}
			db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "config_override_change", "config", 0, detail)
		}

		overrides, err := config.ReadOverrides(path)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not read configuration overrides")
			return
		}
		writeJSON(w, http.StatusOK, buildConfigSettings(cfg, overrides, pending.Load()))
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
