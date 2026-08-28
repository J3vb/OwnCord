// Pass 4 — security-sensitive manifest validation tests.
//
// Locks in the regex / path-traversal / NUL-byte rules added in Pass 2 so
// regressions in Manifest.Validate are caught at CI time instead of via
// manual review.
package plugin

import (
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

func TestPluginNameRegexp(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"hello", true},
		{"game-detection", true},
		{"a", true},
		{"a1_b-c", true},
		{"abcdefghijklmnopqrstuvwxyz0123456789_-abcdefghijklmnopqrstuvwxyz", true},   // 64 chars
		{"abcdefghijklmnopqrstuvwxyz0123456789_-abcdefghijklmnopqrstuvwxyz0", false}, // 65 chars
		{"", false},
		{"Hello", false},
		{"_leading", false},
		{"-leading", false},
		{"..", false},
		{"a/b", false},
		{"a.b", false},
		{"a b", false},
		{"a\x00b", false},
		{"hello!", false},
	}
	for _, c := range cases {
		got := pluginNameRegexp.MatchString(c.name)
		if got != c.ok {
			t.Errorf("pluginNameRegexp.MatchString(%q) = %v, want %v", c.name, got, c.ok)
		}
	}
}

func TestValidateRelativePath(t *testing.T) {
	cases := []struct {
		path string
		ok   bool
	}{
		{"a.wasm", true},
		{"assets/index.html", true},
		{"dir/sub/file.js", true},
		{"hello.wasm", true},
		// failures
		{"", false},
		{"/abs/path", false},
		{"../escape", false},
		{"./not-clean", false},
		{"dir//double", false},
		{"dir/", false},
		{"dir\\win", false},
		{"file\x00name", false},
		{"..", false},
		{".", false},
		{"a/../b", false},
		{"a/./b", false},
	}
	for _, c := range cases {
		err := validateRelativePath(c.path)
		got := err == nil
		if got != c.ok {
			t.Errorf("validateRelativePath(%q) ok=%v err=%v, want ok=%v", c.path, got, err, c.ok)
		}
	}
}

func TestManifestValidateRejectsBadName(t *testing.T) {
	m := &Manifest{
		Name:       "Bad Name",
		Version:    "0.1.0",
		Entrypoint: "hello.wasm",
	}
	if err := m.Validate(); err == nil {
		t.Fatal("expected validation failure for invalid name")
	}
}

func TestManifestValidateRejectsBadAsset(t *testing.T) {
	m := &Manifest{
		Name:       "hello",
		Version:    "0.1.0",
		Entrypoint: "hello.wasm",
		UI: UISpec{
			Tabs: []UITab{
				{ID: "main", Asset: "../../../etc/passwd"},
			},
		},
	}
	if err := m.Validate(); err == nil {
		t.Fatal("expected validation failure for traversal asset")
	}
}

func TestManifestValidateRejectsAbsoluteEntrypoint(t *testing.T) {
	m := &Manifest{
		Name:       "hello",
		Version:    "0.1.0",
		Entrypoint: "/etc/passwd.wasm",
	}
	if err := m.Validate(); err == nil {
		t.Fatal("expected validation failure for absolute entrypoint")
	}
}

func TestManifestValidateAcceptsMinimal(t *testing.T) {
	m := &Manifest{
		Name:       "hello",
		Version:    "0.1.0",
		Entrypoint: "hello.wasm",
	}
	if err := m.Validate(); err != nil {
		t.Fatalf("expected minimal manifest to validate, got: %v", err)
	}
}

func TestManifestValidateRejectsOversizedVersion(t *testing.T) {
	m := &Manifest{
		Name:       "hello",
		Version:    strings.Repeat("v", 65),
		Entrypoint: "hello.wasm",
	}
	if err := m.Validate(); err == nil {
		t.Fatal("expected validation failure for oversized version")
	}
}

func TestManifestValidateRejectsUnknownPermission(t *testing.T) {
	m := &Manifest{
		Name:        "hello",
		Version:     "0.1.0",
		Entrypoint:  "hello.wasm",
		Permissions: []string{"commands", "filesystem"},
	}
	if err := m.Validate(); err == nil {
		t.Fatal("expected validation failure for unknown permission")
	}
}

// TestManifestTOMLDecodesResourceFields pins OC-0338: BurntSushi/toml
// resolves a TOML key to a struct field via the `toml` tag, or — absent that
// tag — the Go field name matched with strings.EqualFold. Resources' fields
// only carried `json` tags, so snake_case keys like max_memory_mb never
// matched MaxMemoryMB (underscores break EqualFold) and silently decoded to
// zero. This test decodes directly with the toml package (no build tag, no
// -tags wazero needed) so it runs in the default `go test ./...` build that
// CI always exercises, even though tryLoadPluginTOML itself only compiles
// under -tags wazero.
func TestManifestTOMLDecodesResourceFields(t *testing.T) {
	const src = `
name = "foo"
version = "1.0.0"
entrypoint = "foo.wasm"

[resources]
cpu_budget_ms = 2000
max_memory_mb = 128
`
	var m Manifest
	if _, err := toml.Decode(src, &m); err != nil {
		t.Fatalf("toml.Decode: %v", err)
	}
	if m.Resources.CPUBudgetMs != 2000 {
		t.Errorf("Resources.CPUBudgetMs = %d, want 2000", m.Resources.CPUBudgetMs)
	}
	if m.Resources.MaxMemoryMB != 128 {
		t.Errorf("Resources.MaxMemoryMB = %d, want 128", m.Resources.MaxMemoryMB)
	}
}
