package config_test

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	goyaml "go.yaml.in/yaml/v3"
)

// This file characterizes config.Load's observable behaviour so the P13 swap
// (koanf -> go.yaml.in/yaml/v3) can be proved to change nothing, except the
// three deltas the swap is *for*: quoted scalars are now rejected, a
// list-valued OWNCORD_* override is comma-separated, and an empty section
// keeps its defaults. It is written to be green on BOTH trees, so every test
// that reads the key surface goes through configTag/tagSource instead of
// naming a tag namespace.

// configTag returns the struct tag that currently names a config key. The
// koanf->yaml swap renames every tag, so read `yaml` when it is present and
// fall back to `koanf`.
func configTag(f reflect.StructField) string {
	if tag, ok := f.Tag.Lookup("yaml"); ok {
		return tag
	}
	return f.Tag.Get("koanf")
}

// tagSource reports which tag namespace is in use: "yaml" after the swap,
// "koanf" before it.
func tagSource() string {
	if _, ok := reflect.TypeFor[config.Config]().Field(0).Tag.Lookup("yaml"); ok {
		return "yaml"
	}
	return "koanf"
}

// walkLeaves calls fn for every leaf field of cfg with its dotted key. The
// struct tags are the only enumeration of the key surface.
func walkLeaves(t *testing.T, cfg *config.Config, fn func(key string, v reflect.Value)) {
	t.Helper()
	var walk func(v reflect.Value, prefix string)
	walk = func(v reflect.Value, prefix string) {
		ty := v.Type()
		if ty.Kind() != reflect.Struct {
			return
		}
		for i := range ty.NumField() {
			tag := configTag(ty.Field(i))
			if tag == "" || tag == "-" {
				continue
			}
			key := tag
			if prefix != "" {
				key = prefix + "." + tag
			}
			fv := v.Field(i)
			if fv.Kind() == reflect.Struct {
				walk(fv, key)
				continue
			}
			fn(key, fv)
		}
	}
	walk(reflect.ValueOf(cfg).Elem(), "")
}

// perturb moves a leaf off its default by a value its own kind can hold, so a
// key that is silently dropped from the file shows up as an unchanged field.
func perturb(v reflect.Value) any {
	switch v.Kind() {
	case reflect.Int:
		return int(v.Int()) + 7
	case reflect.Bool:
		return !v.Bool()
	case reflect.Float64:
		return v.Float() + 0.5
	case reflect.String:
		return v.String() + "-x"
	case reflect.Slice:
		out := make([]string, 0, v.Len()+1)
		for i := range v.Len() {
			out = append(out, v.Index(i).String())
		}
		return append(out, "203.0.113.0/24")
	default:
		panic("unhandled config kind " + v.Kind().String())
	}
}

// loadBody writes body to a fresh config.yaml and loads it.
func loadBody(t *testing.T, body string) *config.Config {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return cfg
}

// TestParityDefaults pins the compiled defaults: a file that names no key must
// load exactly what the shipped template loads, once the two deliberate
// differences (the generated LiveKit credentials, and the template's
// voice.auto_download_livekit: true that defaults() leaves off) are blanked.
func TestParityDefaults(t *testing.T) {
	empty := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	compiled, err := config.Load(empty)
	if err != nil {
		t.Fatalf("Load(empty file): %v", err)
	}
	// A missing path makes Load write defaultYAML first.
	shipped, err := config.Load(filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("Load(missing file): %v", err)
	}

	blank := func(c *config.Config) {
		c.Voice.LiveKitAPIKey, c.Voice.LiveKitAPISecret = "", ""
		c.Voice.AutoDownloadLiveKit = false
	}
	blank(compiled)
	blank(shipped)
	if !reflect.DeepEqual(compiled, shipped) {
		t.Errorf("a file naming no keys must load what the template loads.\ncompiled: %+v\nshipped:  %+v", compiled, shipped)
	}
}

// TestParityEveryLeafRoundTrips perturbs every leaf of the config surface,
// writes the perturbation back as a YAML file, reloads it and requires every
// leaf to arrive unchanged. It is the swap's main safety net: a renamed tag, a
// dropped key or a section that fails to merge shows up as one failed field.
func TestParityEveryLeafRoundTrips(t *testing.T) {
	base := loadBody(t, "")
	tree := map[string]any{}
	want := map[string]any{}
	walkLeaves(t, base, func(key string, v reflect.Value) {
		section, leaf, ok := strings.Cut(key, ".")
		if !ok {
			t.Fatalf("config key %q is not section.key", key)
		}
		m, _ := tree[section].(map[string]any)
		if m == nil {
			m = map[string]any{}
			tree[section] = m
		}
		p := perturb(v)
		m[leaf] = p
		want[key] = p
	})
	// A walk that silently loses a key would make the rest of this test vacuous.
	if len(want) != 71 {
		t.Fatalf("walked %d config leaves, want the full 71-key surface", len(want))
	}

	body, err := goyaml.Marshal(tree)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := loadBody(t, string(body))
	walkLeaves(t, got, func(key string, v reflect.Value) {
		if !reflect.DeepEqual(v.Interface(), want[key]) {
			t.Errorf("%s = %#v, want %#v", key, v.Interface(), want[key])
		}
	})
}

// TestParityEmptyVoiceSection pins the voice defaults against every shape that
// could lose them. `voice:` (null) and `voice: {}` name no key, so the defaults
// survive Unmarshal untouched; a key the document DOES name with an explicit
// empty string is overwritten with "", so ensureVoiceCredentials must refill
// it. Without that refill `livekit_url: ""` reaches NewLiveKitClient as empty
// and disables voice.
func TestParityEmptyVoiceSection(t *testing.T) {
	for _, body := range []string{"voice:\n", "voice: {}\n", "voice:\n  livekit_url: \"\"\n  quality: \"\"\n"} {
		cfg := loadBody(t, body)
		if cfg.Voice.LiveKitURL != "ws://localhost:7880" || cfg.Voice.Quality != "medium" {
			t.Errorf("Load(%q): url=%q quality=%q, want both defaults", body, cfg.Voice.LiveKitURL, cfg.Voice.Quality)
		}
		if cfg.Voice.LiveKitAPIKey == "" || cfg.Voice.LiveKitAPISecret == "" {
			t.Errorf("Load(%q): credentials must still be generated", body)
		}
	}
}

// TestParityEnvScalars pins the environment layer's coercion for every kind it
// handles, in both directions (accepted and rejected).
func TestParityEnvScalars(t *testing.T) {
	port := func(c *config.Config) any { return c.Server.Port }
	waf := func(c *config.Config) any { return c.Server.WAFEnabled }
	name := func(c *config.Config) any { return c.Server.Name }
	retention := func(c *config.Config) any { return c.EventPersistence.RetentionHours }

	cases := []struct {
		name string
		env  string
		val  string
		got  func(*config.Config) any
		want any
		err  bool
	}{
		{"hex int", "OWNCORD_SERVER_PORT", "0x10", port, 16, false},
		{"one is true", "OWNCORD_SERVER_WAF_ENABLED", "1", waf, true, false},
		{"TRUE is true", "OWNCORD_SERVER_WAF_ENABLED", "TRUE", waf, true, false},
		{"zero is false", "OWNCORD_SERVER_WAF_ENABLED", "0", waf, false, false},
		{"a numeric string stays a string", "OWNCORD_SERVER_NAME", "8443", name, "8443", false},
		{"two-word section", "OWNCORD_EVENT_PERSISTENCE_RETENTION_HOURS", "48", retention, 48, false},
		{"unknown env key is ignored", "OWNCORD_SERVER_PROT", "9999", port, 8443, false},
		{"a non-integer int key fails the boot", "OWNCORD_SERVER_PORT", "abc", port, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(tc.env, tc.val)
			path := filepath.Join(t.TempDir(), "config.yaml")
			cfg, err := config.Load(path)
			if tc.err {
				if err == nil {
					t.Fatalf("Load() with %s=%s must fail", tc.env, tc.val)
				}
				// The fault is the environment's and must be reported as one:
				// an operator told the config file is bad would not find it
				// there. Pin both halves of that so the prefix cannot drift.
				if !strings.Contains(err.Error(), "loading env vars: "+tc.env) {
					t.Errorf("%s=%s: failure not attributed to the environment:\n%v", tc.env, tc.val, err)
				}
				if strings.Contains(err.Error(), path) {
					t.Errorf("%s=%s: failure blamed on the config file:\n%v", tc.env, tc.val, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if got := tc.got(cfg); got != tc.want {
				t.Errorf("%s=%s -> %v, want %v", tc.env, tc.val, got, tc.want)
			}
		})
	}
}

// TestParityEnvSingleValueList pins the case that must keep working across the
// swap: one CIDR in one env var arrives as a one-element list. koanf reaches
// that through mapstructure's WeaklyTypedInput; the env layer reaches it by
// splitting on a comma a string that has none.
func TestParityEnvSingleValueList(t *testing.T) {
	t.Setenv("OWNCORD_SERVER_TRUSTED_PROXIES", "10.0.0.2/32")
	cfg := loadBody(t, "")
	if !slices.Equal(cfg.Server.TrustedProxies, []string{"10.0.0.2/32"}) {
		t.Errorf("trusted_proxies = %#v, want one element", cfg.Server.TrustedProxies)
	}
}

// TestParityEnvListCommaSplit pins the one widening the swap adds: a
// comma-separated env value becomes that many elements. It is skipped while
// the koanf tags are in place — mapstructure's WeaklyTypedInput lifts the
// WHOLE string into a single element, so `a,b` is one CIDR today and two after
// the swap.
func TestParityEnvListCommaSplit(t *testing.T) {
	if tagSource() != "yaml" {
		t.Skip("pre-swap: WeaklyTypedInput lifts a comma-joined string into one element; the comma split arrives with the yaml swap")
	}
	t.Setenv("OWNCORD_SERVER_TRUSTED_PROXIES", "10.0.0.2/32, 10.0.0.3/32")
	cfg := loadBody(t, "")
	if !slices.Equal(cfg.Server.TrustedProxies, []string{"10.0.0.2/32", "10.0.0.3/32"}) {
		t.Errorf("trusted_proxies = %#v, want two elements with each side trimmed", cfg.Server.TrustedProxies)
	}
}

// TestParityWarnsUnknownKeys pins the typo warning: never a failure, one
// record per unrecognised leaf key, and silence for every real one.
func TestParityWarnsUnknownKeys(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	loadBody(t, `server:
  prot: 9999
  admin_alowed_cidrs:
    - "0.0.0.0/0"
  allowed_origins:
    - "https://example.com"
  max_ws_connections: 500
databsae:
  path: "oops.db"
backup:
  dir: "elsewhere"
telemetry:
  exportr: "none"
bogus:
  x: 1
voice:
  # livekit_url: "ws://localhost:7880"
  # quality: "medium"
`)
	out := buf.String()
	for _, key := range []string{"server.prot", "server.admin_alowed_cidrs", "databsae.path", "telemetry.exportr", "bogus.x"} {
		if !strings.Contains(out, "key="+key+" ") {
			t.Errorf("no warning for unknown key %q; got:\n%s", key, out)
		}
	}
	for _, key := range []string{"backup.dir", "voice", "server.allowed_origins", "server.max_ws_connections"} {
		if strings.Contains(out, "key="+key+" ") {
			t.Errorf("warned about known key %q; got:\n%s", key, out)
		}
	}
}

// TestParityEnvClamp pins applyBounds running after the environment layer: a
// negative headroom from the environment falls back to the compiled default,
// never to 0 (clamping to 0 would silently turn the floor off).
func TestParityEnvClamp(t *testing.T) {
	t.Setenv("OWNCORD_SERVER_MIN_FREE_DISK_MB", "-5")
	cfg := loadBody(t, "")
	if cfg.Server.MinFreeDiskMB != 256 {
		t.Errorf("min_free_disk_mb = %d after an env -5, want the default 256", cfg.Server.MinFreeDiskMB)
	}
}

// TestLoadEmptySectionKeepsDefaults pins the second delta of the swap: a
// section named with no keys under it leaves every default in that section
// alone. Under koanf's merge an empty document value replaced the whole
// section with Go zero values, which is why Load used to refill voice's URL
// and quality by hand.
func TestLoadEmptySectionKeepsDefaults(t *testing.T) {
	cfg := loadBody(t, "database:\nupload: {}\n")

	if cfg.Database.Path != "data/chatserver.db" {
		t.Errorf("Database.Path = %q, want the default after a bare `database:`", cfg.Database.Path)
	}
	if cfg.Database.Type != "sqlite" {
		t.Errorf("Database.Type = %q, want the default sqlite", cfg.Database.Type)
	}
	if cfg.Upload.MaxSizeMB != 100 || cfg.Upload.StorageDir != "data/uploads" {
		t.Errorf("Upload = %+v, want the defaults after `upload: {}`", cfg.Upload)
	}
}

// TestLoadQuotedScalarRejected pins the swap's one narrowing: YAML types are
// now literal, so a quoted number is a string and a string cannot fit an int
// field. The old parser coerced it silently; refusing it, with the line and
// the offending value, is the point of moving to yaml.v3.
func TestLoadQuotedScalarRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("server:\n  port: \"9000\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err == nil {
		t.Fatalf("Load() accepted a quoted int (port = %d); want a refusal", cfg.Server.Port)
	}
	// yaml.v3 names the line and the value, not the key: "line 2: cannot
	// unmarshal !!str `9000` into int", wrapped with the file path by Load.
	for _, want := range []string{path, "line 2", "9000", "int"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %q:\n%v", want, err)
		}
	}
}
