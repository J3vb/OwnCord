package config

import (
	"fmt"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
)

// leafKeys maps every dotted config key to the reflect.Kind of the field it
// names, walked from the `yaml` tags exactly the way yaml.v3 unmarshals them.
// It is the single enumeration of the configuration surface: the environment
// layer coerces a value by the kind it finds here, unknownKeys treats it as
// the allowlist, and isKnownSection reads it to recognise a bare section
// header. A key that exists in the struct but not here is invisible to all
// three, so the walk is tested against a fixed count (parity_test.go).
var leafKeys = walkLeafKeys()

func walkLeafKeys() map[string]reflect.Kind {
	out := make(map[string]reflect.Kind)
	var walk func(t reflect.Type, prefix string)
	walk = func(t reflect.Type, prefix string) {
		for t.Kind() == reflect.Ptr {
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
			for ft.Kind() == reflect.Ptr {
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

// envOverrides returns the OWNCORD_* environment as a nested map ready to be
// marshalled and unmarshalled over the file layer. A name the config struct
// does not define is dropped silently: the environment has no typo warning of
// its own, and the file layer already owns that job.
//
// Windows environment names are case-insensitive, so the prefix match and the
// section lookup are both done lower-cased.
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
		// Base 0 so 0x10 and 0o17 work, matching what mapstructure accepted.
		// Parsed at the platform's int width, so an out-of-range value is
		// rejected rather than silently truncated by the conversion below.
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
		// One env var holds a comma-separated list:
		// OWNCORD_SERVER_TRUSTED_PROXIES=10.0.0.2/32,10.0.0.3/32
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

// unknownKeys returns every dotted key in a parsed config document that the
// Config struct does not define, sorted. A section header whose children are
// all commented out (or omitted) parses to a nil value or an empty map, and is
// a real section rather than a typo as long as the struct nests something
// under it.
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

// isKnownSection reports whether prefix names a known config section, i.e.
// some leaf key is prefix followed by ".".
func isKnownSection(prefix string) bool {
	want := prefix + "."
	for key := range leafKeys {
		if strings.HasPrefix(key, want) {
			return true
		}
	}
	return false
}

// envKeyToPath converts a lower-case env key (without the OWNCORD_ prefix) to
// a dotted config path. The first segment (up to the first underscore) is the
// section; the remainder is the key (with underscores preserved).
//
// Examples:
//
//	server_port        -> server.port
//	server_name        -> server.name
//	server_data_dir    -> server.data_dir
//	database_path      -> database.path
//	tls_mode           -> tls.mode
//	tls_cert_file      -> tls.cert_file
//	upload_max_size_mb -> upload.max_size_mb
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
