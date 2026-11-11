package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"

	goyaml "go.yaml.in/yaml/v3"
)

// OverridesFileName is the flat JSON file in server.data_dir holding settings changed from the admin panel.
// It sits beside the database, not in config.yaml, because Docker mounts config.yaml read-only. See
// applyOverrideLayer.
const OverridesFileName = "config-overrides.json"

// ErrNotEditable is the sentinel for a key the panel may not set: not a config leaf, server.data_dir (the
// overrides file and key files live inside it) or the two upload-type lists, which the Settings page owns
// live.
var ErrNotEditable = errors.New("config key is not editable from the admin panel")

// ErrInvalidValue is the sentinel for a value failing its key's rule; the panel rejects it where Load
// merely clamps and warns.
var ErrInvalidValue = errors.New("config value is invalid")

// OverridesPath is the overrides file path inside a data directory.
func OverridesPath(dataDir string) string {
	return filepath.Join(dataDir, OverridesFileName)
}

// IsEditable reports whether key is a panel-editable config key (exact, case-sensitive dotted key).
func IsEditable(key string) bool {
	_, ok := editableRules[key]
	return ok
}

// EditableKeys returns the panel-editable keys, sorted.
func EditableKeys() []string {
	keys := make([]string, 0, len(editableRules))
	for key := range editableRules {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

// EnvOverridden reports whether an OWNCORD_* variable names key. The environment applies last, so a saved
// override for it would lose silently at the next boot; the panel refuses it instead.
func EnvOverridden(key string) bool {
	_, ok := os.LookupEnv("OWNCORD_" + strings.ToUpper(strings.ReplaceAll(key, ".", "_")))
	return ok
}

// ReadOverrides reads the overrides file as a flat map of dotted key to value; a missing file is an empty
// map. Values are normalised so a hand-edited file and the admin API carry the same Go types. An editable
// key whose stored value fails its rule is dropped with a warning, so a hand-edit cannot stop startup.
func ReadOverrides(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // G304: path comes from trusted wiring, not request input
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", OverridesFileName, err)
	}
	out := make(map[string]any)
	if len(strings.TrimSpace(string(raw))) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", OverridesFileName, err)
	}
	for key, value := range out {
		normalized := normalizeStored(value)
		rule, editable := editableRules[key]
		if !editable {
			out[key] = normalized
			continue
		}
		validated, err := rule(normalized)
		if err != nil {
			slog.Warn("config: ignoring invalid value in overrides file (wrong type or out of range)", "key", key)
			delete(out, key)
			continue
		}
		out[key] = validated
	}
	return out, nil
}

// SaveOverrides merges changes into the overrides file; a nil value removes its key. Nothing is written
// unless the whole batch validates. The write is atomic, mode 0600, under the mutex config.Save uses.
func SaveOverrides(path string, changes map[string]any) error {
	if len(changes) == 0 {
		return nil
	}
	set, remove, err := validateOverrides(changes)
	if err != nil {
		return err
	}

	saveMu.Lock()
	defer saveMu.Unlock()

	current, err := ReadOverrides(path)
	if err != nil {
		return err
	}
	maps.Copy(current, set)
	for _, key := range remove {
		delete(current, key)
	}
	encoded, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding %s: %w", OverridesFileName, err)
	}
	encoded = append(encoded, '\n')
	return atomicWrite(path, encoded)
}

// ValidateOverrides runs SaveOverrides' syntax pass without writing.
func ValidateOverrides(changes map[string]any) error {
	_, _, err := validateOverrides(changes)
	return err
}

func validateOverrides(changes map[string]any) (map[string]any, []string, error) {
	set := make(map[string]any, len(changes))
	remove := make([]string, 0, len(changes))
	for key, value := range changes {
		if !IsEditable(key) {
			return nil, nil, fmt.Errorf("config key %q: %w", key, ErrNotEditable)
		}
		if value == nil {
			remove = append(remove, key)
			continue
		}
		normalized, err := editableRules[key](value)
		if err != nil {
			return nil, nil, fmt.Errorf("config key %q: %w: %w", key, ErrInvalidValue, err)
		}
		set[key] = normalized
	}
	return set, remove, nil
}

// Preview builds the configuration the NEXT boot would run with if changes were saved (nil removes a key).
// It writes nothing, so a missing config.yaml previews as defaults and is not created.
func Preview(cfgPath, overridesPath string, changes map[string]any) (*Config, error) {
	raw, err := os.ReadFile(cfgPath) //nolint:gosec // G304: path comes from trusted wiring, not request input
	if errors.Is(err, os.ErrNotExist) {
		raw = nil
	} else if err != nil {
		return nil, fmt.Errorf("reading config file %s: %w", cfgPath, err)
	}
	current, err := ReadOverrides(overridesPath)
	if err != nil {
		return nil, err
	}
	if len(changes) > 0 {
		set, remove, err := validateOverrides(changes)
		if err != nil {
			return nil, err
		}
		maps.Copy(current, set)
		for _, key := range remove {
			delete(current, key)
		}
	}
	return loadBytesWith(raw, cfgPath, current)
}

// BaseConfig builds the configuration with the overrides layer left out (defaults, config.yaml,
// environment), writing nothing and generating no LiveKit credential. The offline recovery command uses it
// to find data_dir without reading the file it is about to change.
func BaseConfig(cfgPath string) (*Config, error) {
	raw, err := os.ReadFile(cfgPath) //nolint:gosec // G304: path comes from trusted wiring, not request input
	if errors.Is(err, os.ErrNotExist) {
		raw = nil
	} else if err != nil {
		return nil, fmt.Errorf("reading config file %s: %w", cfgPath, err)
	}
	// An empty, non-nil map selects "no overrides layer"; a nil map would read the overrides file.
	return loadBytesWith(raw, cfgPath, map[string]any{})
}

// Lookup returns the running value of a dotted key and whether it names a config leaf.
func Lookup(cfg *Config, key string) (any, bool) {
	v := leafValue(cfg, key)
	if !v.IsValid() {
		return nil, false
	}
	return v.Interface(), true
}

// leafValue walks cfg by yaml tags to the field a dotted key names, or the zero reflect.Value.
func leafValue(cfg *Config, key string) reflect.Value {
	section, leaf, ok := strings.Cut(key, ".")
	if !ok {
		return reflect.Value{}
	}
	root := reflect.ValueOf(cfg).Elem()
	for i := range root.NumField() {
		field := root.Type().Field(i)
		if field.Tag.Get("yaml") != section {
			continue
		}
		v := root.Field(i)
		if v.Kind() != reflect.Struct {
			return reflect.Value{}
		}
		for j := range v.NumField() {
			if v.Type().Field(j).Tag.Get("yaml") == leaf {
				return v.Field(j)
			}
		}
	}
	return reflect.Value{}
}

// applyOverrideLayer applies the overrides file between config.yaml and the environment. data_dir is
// resolved first (the environment's value wins) so the file is found even when the environment moves it.
func applyOverrideLayer(cfg *Config) error {
	dataDir := cfg.Server.DataDir
	if v := os.Getenv("OWNCORD_SERVER_DATA_DIR"); v != "" {
		dataDir = v
	}
	overrides, err := ReadOverrides(OverridesPath(dataDir))
	if err != nil {
		return err
	}
	return applyOverrides(cfg, overrides)
}

// applyOverrides applies a flat map over cfg. Non-editable keys are warned about and skipped: a
// hand-edited file must not reach a protected key or drop the valid ones.
func applyOverrides(cfg *Config, overrides map[string]any) error {
	nested := make(map[string]map[string]any)
	for key, value := range overrides {
		if !IsEditable(key) {
			slog.Warn("config: ignoring non-editable key in overrides file (typo, or a protected key)", "key", key)
			continue
		}
		section, leaf, ok := strings.Cut(key, ".")
		if !ok {
			continue
		}
		if nested[section] == nil {
			nested[section] = make(map[string]any)
		}
		nested[section][leaf] = value
		slog.Info("config: admin-panel override in effect", "key", key)
	}
	if len(nested) == 0 {
		return nil
	}
	encoded, err := goyaml.Marshal(nested)
	if err != nil {
		return fmt.Errorf("encoding %s: %w", OverridesFileName, err)
	}
	if err := goyaml.Unmarshal(encoded, cfg); err != nil {
		return fmt.Errorf("applying %s: %w", OverridesFileName, err)
	}
	return nil
}

func normalizeStored(value any) any {
	switch t := value.(type) {
	case float64:
		if t == math.Trunc(t) && t >= -1e15 && t <= 1e15 {
			return int(t)
		}
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, entry := range t {
			out = append(out, fmt.Sprint(entry))
		}
		return out
	default:
		return value
	}
}
