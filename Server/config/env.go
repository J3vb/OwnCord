package config

import (
	"fmt"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
)

// leafKeys maps every dotted config key to the reflect.Kind of its field, walked
// from the `yaml` tags the way yaml.v3 unmarshals them. It is the single
// enumeration of the configuration surface: the environment layer coerces by it,
// unknownKeys uses it as the allowlist and isKnownSection reads it. A key
// missing here is invisible to all three, so the walk is tested against a fixed
// count (parity_test.go).
var leafKeys = walkLeafKeys()

func walkLeafKeys() map[string]reflect.Kind {
	out := make(map[string]reflect.Kind)
	var walk func(t reflect.Type, prefix string)
	walk = func(t reflect.Type, prefix string) {
		for t.Kind() == reflect.Pointer {
			t = t.Elem()
		}
		if t.Kind() != reflect.Struct {
			return
		}
		for f := range t.Fields() {
			tag, ok := f.Tag.Lookup("yaml")
			if !ok || tag == "" || tag == "-" {
				continue
			}
			key := tag
			if prefix != "" {
				key = prefix + "." + tag
			}
			ft := f.Type
			for ft.Kind() == reflect.Pointer {
				ft = ft.Elem()
			}
			if ft.Kind() == reflect.Struct {
				walk(ft, key)
				continue
			}
			out[key] = ft.Kind()
		}
	}
	walk(reflect.TypeFor[Config](), "")
	return out
}

// envOverrides returns the OWNCORD_* environment as a nested map to overlay on
// the file layer. A name the struct does not define is dropped silently: the
// file layer owns typo warnings.
// The OWNCORD_ prefix must match exactly (Owncord_Server_Port is dropped); only
// the remainder is lower-cased, because config keys are.
func envOverrides() (map[string]any, error) {
	out := make(map[string]any)
	for _, entry := range os.Environ() {
		name, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		rest, ok := strings.CutPrefix(name, "OWNCORD_")
		if !ok {
			continue
		}
		key := envKeyToPath(strings.ToLower(rest))
		kind, known := leafKeys[key]
		if !known {
			continue
		}
		v, err := coerceEnv(value, kind)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		section, leaf, _ := strings.Cut(key, ".")
		m, _ := out[section].(map[string]any)
		if m == nil {
			m = make(map[string]any)
			out[section] = m
		}
		m[leaf] = v
	}
	return out, nil
}

// coerceEnv converts one environment value to the type of the config field it
// names. A value the type cannot hold is an error, not a warning: Load is
// warn-only about values that are merely out of range, but an unparseable port
// has no defensible nearest value, and silently keeping the default would boot
// a server the operator believes they reconfigured.
func coerceEnv(value string, kind reflect.Kind) (any, error) {
	switch kind {
	case reflect.Bool:
		b, err := strconv.ParseBool(value)
		if err != nil {
			return nil, fmt.Errorf("want a boolean, got %q", value)
		}
		return b, nil
	case reflect.Int:
		// Base 0 so 0x10 and 0o17 work (as mapstructure accepted). Parsed at the
		// platform's int width so an out-of-range value is rejected, not
		// truncated by the conversion below.
		n, err := strconv.ParseInt(value, 0, strconv.IntSize)
		if err != nil {
			return nil, fmt.Errorf("want an integer, got %q", value)
		}
		return int(n), nil
	case reflect.Float64:
		f, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return nil, fmt.Errorf("want a number, got %q", value)
		}
		return f, nil
	case reflect.String:
		return value, nil
	case reflect.Slice:
		parts := strings.Split(value, ",")
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			out = append(out, strings.TrimSpace(p))
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unsupported config kind %s", kind)
	}
}

// unknownKeys returns every dotted key in a parsed document that Config does not
// define, sorted. A section header whose children are all commented out parses
// to nil or an empty map and is a real section, not a typo, if the struct nests
// something under it.
func unknownKeys(tree map[string]any) []string {
	var unknown []string
	var walk func(m map[string]any, prefix string)
	walk = func(m map[string]any, prefix string) {
		for key, v := range m {
			full := key
			if prefix != "" {
				full = prefix + "." + key
			}
			if child, ok := v.(map[string]any); ok && len(child) > 0 {
				walk(child, full)
				continue
			}
			if _, known := leafKeys[full]; known {
				continue
			}
			if isKnownSection(full) {
				continue
			}
			unknown = append(unknown, full)
		}
	}
	walk(tree, "")
	slices.Sort(unknown)
	return unknown
}

func isKnownSection(prefix string) bool {
	want := prefix + "."
	for key := range leafKeys {
		if strings.HasPrefix(key, want) {
			return true
		}
	}
	return false
}

// envKeyToPath converts a lower-case env key (without the OWNCORD_ prefix) to a
// dotted path: the first segment (up to the first underscore) is the section,
// the rest the key, e.g. server_data_dir -> server.data_dir.
func envKeyToPath(s string) string {
	// event_persistence is the only multi-word section; cutting at the first
	// underscore would produce the dead path event.persistence_* and every
	// documented override under it would be dropped silently.
	if rest, ok := strings.CutPrefix(s, "event_persistence_"); ok {
		return "event_persistence." + rest
	}
	before, after, ok := strings.Cut(s, "_")
	if !ok {
		return s
	}
	return before + "." + after
}
