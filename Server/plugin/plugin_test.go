// Phase C Step 9 — manifest + loader tests.
//
// These tests cover the default-build code path (no wazero). They confirm:
//   - the JSON manifest parses and validates,
//   - the loader walks a directory and surfaces well-formed plugins,
//   - the registry persists discovered plugins into a PluginStore,
//   - per-capability gating refuses calls when the manifest didn't grant them.
//
// Wazero-specific tests live in sandbox_wazero_test.go and only run with the
// `wazero` build tag.
package plugin

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/owncord/server/store"
)

func TestParseManifestRoundTrip(t *testing.T) {
	raw := []byte(`{
		"name": "hello",
		"version": "0.1.0",
		"entrypoint": "hello.wasm",
		"permissions": ["commands", "storage"],
		"resources": {"max_memory_mb": 16, "cpu_budget_ms": 50}
	}`)
	m, err := ParseManifest(raw)
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if m.Name != "hello" || m.Version != "0.1.0" {
		t.Fatalf("unexpected manifest fields: %+v", m)
	}
	if !m.HasCapability(CapCommands) {
		t.Fatal("expected commands capability")
	}
	if m.HasCapability(CapHTTP) {
		t.Fatal("did not expect http capability")
	}
}

func TestParseManifestRejectsBadEntrypoint(t *testing.T) {
	cases := map[string]string{
		"missing entrypoint":  `{"name":"x","version":"1","entrypoint":""}`,
		"non-wasm entrypoint": `{"name":"x","version":"1","entrypoint":"x.so"}`,
		"unknown capability":  `{"name":"x","version":"1","entrypoint":"x.wasm","permissions":["badperm"]}`,
		"missing version":     `{"name":"x","entrypoint":"x.wasm"}`,
		"missing name":        `{"version":"1","entrypoint":"x.wasm"}`,
	}
	for label, body := range cases {
		t.Run(label, func(t *testing.T) {
			if _, err := ParseManifest([]byte(body)); err == nil {
				t.Fatalf("expected error for %s", label)
			}
		})
	}
}

func TestScanPluginDirectoryHandlesMissing(t *testing.T) {
	got, err := scanPluginDirectory(filepath.Join(t.TempDir(), "does-not-exist"))
	if err != nil {
		t.Fatalf("scanPluginDirectory: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty result, got %d", len(got))
	}
}

func TestScanPluginDirectoryParsesValidPlugin(t *testing.T) {
	dir := t.TempDir()
	pluginDir := filepath.Join(dir, "hello")
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"hello","version":"0.1.0","entrypoint":"hello.wasm","permissions":["storage"]}`
	if err := os.WriteFile(filepath.Join(pluginDir, "plugin.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "hello.wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := scanPluginDirectory(dir)
	if err != nil {
		t.Fatalf("scanPluginDirectory: %v", err)
	}
	if len(got) != 1 || got[0].Manifest.Name != "hello" {
		t.Fatalf("unexpected scan result: %+v", got)
	}
}

func TestRegistryInstallFromDisk(t *testing.T) {
	dir := t.TempDir()
	pluginDir := filepath.Join(dir, "hello")
	_ = os.MkdirAll(pluginDir, 0o755)
	_ = os.WriteFile(filepath.Join(pluginDir, "plugin.json"),
		[]byte(`{"name":"hello","version":"0.1.0","entrypoint":"hello.wasm","permissions":["storage"]}`),
		0o644)
	_ = os.WriteFile(filepath.Join(pluginDir, "hello.wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0o644)

	mem := store.NewMemStore()
	reg, err := NewRegistry(Config{Directory: dir, Store: mem})
	if err != nil {
		t.Fatal(err)
	}
	if err := reg.LoadAll(context.Background()); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	rows, err := mem.ListPlugins(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Name != "hello" {
		t.Fatalf("expected hello plugin row, got %+v", rows)
	}
}

func TestStorageGatedByCapability(t *testing.T) {
	mem := store.NewMemStore()
	reg, err := NewRegistry(Config{Store: mem})
	if err != nil {
		t.Fatal(err)
	}
	inst := &Instance{
		ID:       1,
		Manifest: &Manifest{Name: "x", Permissions: []string{}},
	}
	if err := reg.StoragePut(context.Background(), inst, "k", []byte("v")); err == nil {
		t.Fatal("expected ErrCapabilityNotGranted")
	}
	inst.Manifest.Permissions = []string{string(CapStorage)}
	// Pre-create the plugin row so the KV foreign-key-equivalent succeeds.
	if _, err := mem.InstallPlugin(context.Background(), "x", "0.1", "{}"); err != nil {
		t.Fatal(err)
	}
	if err := reg.StoragePut(context.Background(), inst, "k", []byte("v")); err != nil {
		t.Fatalf("StoragePut: %v", err)
	}
	got, err := reg.StorageGet(context.Background(), inst, "k")
	if err != nil {
		t.Fatalf("StorageGet: %v", err)
	}
	if string(got) != "v" {
		t.Fatalf("expected v, got %q", got)
	}
}
