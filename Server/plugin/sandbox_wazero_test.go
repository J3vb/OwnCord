//go:build wazero

// Phase C Step 9 — Wazero runtime integration tests. Only compiled with
// `-tags wazero`, alongside sandbox_wazero.go. These tests exercise the
// behaviours the default build cannot:
//
//   - NewRegistry stands up a real wazero.Runtime
//   - activateWithRuntime compiles a real .wasm module and tracks the
//     resulting instance on the Instance struct
//   - EnablePlugin takes a manifest from a PluginStore row through
//     activation end-to-end
//   - invokeCommand gracefully returns a user-facing error when the plugin
//     does not export command_dispatch
//   - Close tears the runtime down without panicking
//
// Test fixture: the 41-byte `add.wasm` module from the wazero examples, a
// trivial module that exports `add(i32,i32) -> i32`. It does NOT export
// `command_dispatch`, which is intentional — the command path must handle
// that case.
package plugin

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/owncord/server/store"
)

// addWASM is the bytes of a minimal (module (func (export "add") ... )).
// Verified against the wazero examples fixture; 41 bytes. Using a literal
// here avoids dragging a binary asset into the repo.
var addWASM = []byte{
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
	0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
	0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01,
	0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09,
	0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a,
	0x0b,
}

func writeTestPlugin(t *testing.T, root, name string, manifest string, wasmBytes []byte) {
	t.Helper()
	pluginDir := filepath.Join(root, name)
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "plugin.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "hello.wasm"), wasmBytes, 0o644); err != nil {
		t.Fatal(err)
	}
}

func newWazeroTestRegistry(t *testing.T, dir string) (*Registry, store.PluginStore) {
	t.Helper()
	mem := store.NewMemStore()
	reg, err := NewRegistry(Config{
		Directory:   dir,
		MaxMemoryMB: 16,
		CPUBudgetMs: 100,
		Store:       mem,
	})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	t.Cleanup(func() { _ = reg.Close(context.Background()) })
	return reg, mem
}

func TestWazeroRegistryCreatesRuntime(t *testing.T) {
	reg, _ := newWazeroTestRegistry(t, t.TempDir())
	if reg.runtimePlatform == nil {
		t.Fatal("expected wazero runtime to be wired in tagged build")
	}
	if reg.platformClose == nil {
		t.Fatal("expected platformClose to be set")
	}
}

func TestWazeroActivateCompilesModule(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"hello","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"]}`
	writeTestPlugin(t, dir, "hello", manifest, addWASM)

	reg, mem := newWazeroTestRegistry(t, dir)
	ctx := context.Background()
	if err := reg.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}

	rows, err := mem.ListPlugins(ctx)
	if err != nil || len(rows) != 1 {
		t.Fatalf("ListPlugins: rows=%+v err=%v", rows, err)
	}

	// The plugin starts disabled; enable it and confirm the module compiles.
	if err := reg.EnablePlugin(ctx, rows[0].ID); err != nil {
		t.Fatalf("EnablePlugin: %v", err)
	}

	reg.mu.RLock()
	inst := reg.plugins[rows[0].ID]
	reg.mu.RUnlock()
	if inst == nil {
		t.Fatal("instance not registered after enable")
	}
	if !inst.Enabled {
		t.Fatal("instance should be enabled after EnablePlugin")
	}
	if inst.module == nil {
		t.Fatal("expected inst.module to be populated after activation")
	}
}

func TestWazeroDispatchCommandMissingExport(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"hello","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"]}`
	writeTestPlugin(t, dir, "hello", manifest, addWASM)

	reg, mem := newWazeroTestRegistry(t, dir)
	ctx := context.Background()
	if err := reg.LoadAll(ctx); err != nil {
		t.Fatal(err)
	}
	rows, _ := mem.ListPlugins(ctx)
	if err := reg.EnablePlugin(ctx, rows[0].ID); err != nil {
		t.Fatalf("EnablePlugin: %v", err)
	}

	reg.mu.RLock()
	inst := reg.plugins[rows[0].ID]
	reg.mu.RUnlock()
	if err := reg.RegisterCommand("hello", inst); err != nil {
		t.Fatalf("RegisterCommand: %v", err)
	}

	result, ok := reg.DispatchCommand(ctx, 1, 2, "hello", nil)
	if !ok {
		t.Fatal("expected DispatchCommand to return a result")
	}
	if result == nil || result.Reply == "" {
		t.Fatal("expected a non-empty reply when export is missing")
	}
}

func TestWazeroCloseTearsDownRuntime(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"hello","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"]}`
	writeTestPlugin(t, dir, "hello", manifest, addWASM)

	reg, mem := newWazeroTestRegistry(t, dir)
	ctx := context.Background()
	if err := reg.LoadAll(ctx); err != nil {
		t.Fatal(err)
	}
	rows, _ := mem.ListPlugins(ctx)
	if err := reg.EnablePlugin(ctx, rows[0].ID); err != nil {
		t.Fatalf("EnablePlugin: %v", err)
	}

	if err := reg.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if reg.runtimePlatform != nil || reg.platformClose != nil {
		t.Fatal("Close should clear platform fields")
	}
	// Calling Close twice must not panic.
	if err := reg.Close(ctx); err != nil {
		t.Fatalf("Close (second): %v", err)
	}
}

func TestWazeroDisablePluginFreesModule(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"hello","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"]}`
	writeTestPlugin(t, dir, "hello", manifest, addWASM)

	reg, mem := newWazeroTestRegistry(t, dir)
	ctx := context.Background()
	if err := reg.LoadAll(ctx); err != nil {
		t.Fatal(err)
	}
	rows, _ := mem.ListPlugins(ctx)
	if err := reg.EnablePlugin(ctx, rows[0].ID); err != nil {
		t.Fatalf("EnablePlugin: %v", err)
	}
	reg.mu.RLock()
	inst := reg.plugins[rows[0].ID]
	reg.mu.RUnlock()
	if inst.module == nil {
		t.Fatal("pre-condition: module should be populated after EnablePlugin")
	}
	if err := reg.DisablePlugin(ctx, rows[0].ID); err != nil {
		t.Fatalf("DisablePlugin: %v", err)
	}
	if inst.module != nil {
		t.Fatal("DisablePlugin must release the wazero module (inst.module != nil)")
	}
	if inst.Enabled {
		t.Fatal("DisablePlugin must clear inst.Enabled")
	}
	// Re-enabling must rebuild a new module.
	if err := reg.EnablePlugin(ctx, rows[0].ID); err != nil {
		t.Fatalf("re-EnablePlugin: %v", err)
	}
	if inst.module == nil {
		t.Fatal("re-Enable should repopulate inst.module")
	}
}

func TestWazeroInvalidWASMFailsActivation(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"brokey","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"]}`
	writeTestPlugin(t, dir, "brokey", manifest, []byte("not a wasm"))

	reg, mem := newWazeroTestRegistry(t, dir)
	ctx := context.Background()
	if err := reg.LoadAll(ctx); err != nil {
		t.Fatal(err)
	}
	rows, _ := mem.ListPlugins(ctx)
	if err := reg.EnablePlugin(ctx, rows[0].ID); err == nil {
		t.Fatal("expected EnablePlugin to fail on invalid WASM")
	}
}
