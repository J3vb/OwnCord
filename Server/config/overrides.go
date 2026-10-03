package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"

	goyaml "go.yaml.in/yaml/v3"
)

// OverridesFileName is the flat JSON file, inside server.data_dir, that holds
// the settings an owner changed from the admin panel. It lives beside the
// database rather than inside config.yaml because Docker mounts config.yaml
// read-only; data_dir is the writable volume. The values are applied at boot,
// below config.yaml and above the compiled defaults, so the panel is the newer
// and more specific intent (see applyOverrideLayer).
const OverridesFileName = "config-overrides.json"

// ErrNotEditable is the sentinel for a key the panel may not set: it is either
// not a config leaf or one of the protected groups (secrets, host paths, the
// listener/TLS identity, the panel's own perimeter, the update source,
// pprof, or a key a live settings row already owns).
var ErrNotEditable = errors.New("config key is not editable from the admin panel")

// ErrInvalidValue is the sentinel for a value that fails its key's rule
// (wrong JSON type, out of range, bad enum, bad CIDR, control characters).
// The panel rejects a bad value; Load merely clamps and warns.
var ErrInvalidValue = errors.New("config value is invalid")

// OverridesPath is the overrides file path inside a data directory.
func OverridesPath(dataDir string) string {
	return filepath.Join(dataDir, OverridesFileName)
}

// IsEditable reports whether key is one of the panel-editable config keys.
// It is an exact, case-sensitive dotted key.
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

// EnvOverridden reports whether an OWNCORD_* environment variable names key.
// The environment applies last, so a saved override for such a key would lose
// silently at the next boot; the panel refuses it instead.
func EnvOverridden(key string) bool {
	_, ok := os.LookupEnv("OWNCORD_" + strings.ToUpper(strings.ReplaceAll(key, ".", "_")))
	return ok
}

// ReadOverrides reads the overrides file as a flat map of dotted key to value.
// A missing file is an empty map, not an error. Values are normalised on read
// (whole JSON numbers to int, JSON arrays to []string) so a round-trip through
// a hand-edited file and the admin API carry the same Go types. An editable
// key whose stored value fails its rule is dropped with a warning, so a
// hand-edited wrong-typed value cannot stop the server from starting.
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

// SaveOverrides merges changes into the overrides file. A nil value removes
// its key; any other value sets it. Every key and value is validated first:
// nothing is written unless the whole batch passes, so a bad key never drops
// the valid ones. The file is written atomically with mode 0600, under the
// same mutex config.Save uses, so the read-modify-write cannot interleave.
func SaveOverrides(path string, changes map[string]any) error {
	if len(changes) == 0 {
		return nil
	}
	set := make(map[string]any, len(changes))
	remove := make([]string, 0, len(changes))
	for key, value := range changes {
		if !IsEditable(key) {
			return fmt.Errorf("config key %q: %w", key, ErrNotEditable)
		}
		if value == nil {
			remove = append(remove, key)
			continue
		}
		normalized, err := editableRules[key](value)
		if err != nil {
			return fmt.Errorf("config key %q: %w: %w", key, ErrInvalidValue, err)
		}
		set[key] = normalized
	}

	saveMu.Lock()
	defer saveMu.Unlock()

	current, err := ReadOverrides(path)
	if err != nil {
		return err
	}
	for key, value := range set {
		current[key] = value
	}
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

// Lookup returns the running value of a dotted config key from cfg, and
// whether the key names a config leaf. The value's Go type is the field's:
// int, bool, string, float64 or []string.
func Lookup(cfg *Config, key string) (any, bool) {
	v := leafValue(cfg, key)
	if !v.IsValid() {
		return nil, false
	}
	return v.Interface(), true
}

// leafValue walks cfg by the yaml tags and returns the field value a dotted
// key names, or the zero reflect.Value when there is none. It is the lookup
// twin of env.go's walkLeafKeys.
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

// applyOverrideLayer applies the overrides file between config.yaml and the
// OWNCORD_* environment. data_dir is resolved first (the environment's value
// wins, since the env layer itself would apply it) so the file is found even
// when the environment moves the data directory. Keys that are not editable
// are warned about and skipped: a hand-edited file must not reach a protected
// key, and one bad key must not drop the valid ones.
func applyOverrideLayer(cfg *Config) error {
	dataDir := cfg.Server.DataDir
	if v := os.Getenv("OWNCORD_SERVER_DATA_DIR"); v != "" {
		dataDir = v
	}
	overrides, err := ReadOverrides(OverridesPath(dataDir))
	if err != nil {
		return err
	}
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

// normalizeStored turns the shapes encoding/json decodes into the shapes the
// config fields expect: a whole float64 becomes an int, a []any becomes a
// []string.
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
