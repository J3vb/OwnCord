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
	"strings"
	"sync"
	"testing"
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

func newWazeroTestRegistry(t *testing.T, dir string) (*Registry, PluginStore) {
	t.Helper()
	mem := openPluginTestDB(t)
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
	manifest := `{"name":"hello","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"hello"}]}`
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
	manifest := `{"name":"hello","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"hello"}]}`
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
	manifest := `{"name":"hello","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"hello"}]}`
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
	manifest := `{"name":"hello","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"hello"}]}`
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

// spinWASM implements the command-dispatch ABI with input-dependent runtime:
//
//	(module
//	  (memory (export "memory") 1)
//	  (func (export "allocate") (param i32) (result i32) i32.const 8)
//	  (func (export "deallocate") (param i32 i32))
//	  (func (export "command_dispatch") (param i32 i32) (result i32 i32)
//	    local.get 1          ;; payload length
//	    i32.const 100
//	    i32.gt_u
//	    if (loop br 0 end) end  ;; payloads over 100 bytes spin forever
//	    i32.const 0 i32.const 0))
//
// A dispatch with no args stays under 100 payload bytes and returns
// immediately; long args push the JSON payload over 100 bytes and trigger an
// infinite loop, which the CPU budget must interrupt.
var spinWASM = []byte{
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // \0asm v1
	// type section: (i32)->i32, (i32,i32)->(), (i32,i32)->(i32,i32)
	0x01, 0x12, 0x03,
	0x60, 0x01, 0x7f, 0x01, 0x7f,
	0x60, 0x02, 0x7f, 0x7f, 0x00,
	0x60, 0x02, 0x7f, 0x7f, 0x02, 0x7f, 0x7f,
	// function section: 3 funcs using types 0,1,2
	0x03, 0x04, 0x03, 0x00, 0x01, 0x02,
	// memory section: 1 page, no max
	0x05, 0x03, 0x01, 0x00, 0x01,
	// export section: memory, allocate, deallocate, command_dispatch
	0x07, 0x35, 0x04,
	0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
	0x08, 0x61, 0x6c, 0x6c, 0x6f, 0x63, 0x61, 0x74, 0x65, 0x00, 0x00,
	0x0a, 0x64, 0x65, 0x61, 0x6c, 0x6c, 0x6f, 0x63, 0x61, 0x74, 0x65, 0x00, 0x01,
	0x10, 0x63, 0x6f, 0x6d, 0x6d, 0x61, 0x6e, 0x64, 0x5f, 0x64, 0x69, 0x73, 0x70, 0x61, 0x74, 0x63, 0x68, 0x00, 0x02,
	// code section
	0x0a, 0x1e, 0x03,
	// allocate: return 8
	0x04, 0x00, 0x41, 0x08, 0x0b,
	// deallocate: nop
	0x02, 0x00, 0x0b,
	// command_dispatch: spin if len>100 else return (0,0)
	0x14, 0x00,
	0x20, 0x01, // local.get 1
	0x41, 0xe4, 0x00, // i32.const 100
	0x4b,       // i32.gt_u
	0x04, 0x40, // if
	0x03, 0x40, // loop
	0x0c, 0x00, // br 0
	0x0b,       // end loop
	0x0b,       // end if
	0x41, 0x00, // i32.const 0
	0x41, 0x00, // i32.const 0
	0x0b, // end
}

// TestWazeroCPUBudgetOverrunDoesNotBrickPlugin locks in the W1-1 fix: an
// over-budget command must return the budget error, and the SAME plugin must
// serve the next command via lazy re-instantiation — not stay dead until an
// admin disable/enable cycle or server restart.
func TestWazeroCPUBudgetOverrunDoesNotBrickPlugin(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"spinner","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"spin"}]}`
	writeTestPlugin(t, dir, "spinner", manifest, spinWASM)

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
	if err := reg.RegisterCommand("spin", inst); err != nil {
		t.Fatalf("RegisterCommand: %v", err)
	}

	// Baseline: a small payload dispatches fine.
	result, ok := reg.DispatchCommand(ctx, 1, 2, "spin", nil)
	if !ok || result == nil {
		t.Fatalf("baseline dispatch failed: ok=%v result=%+v", ok, result)
	}
	if strings.Contains(result.Reply, "CPU budget") {
		t.Fatalf("baseline dispatch should not hit the budget: %q", result.Reply)
	}

	// Overrun: a long arg pushes the payload over the spin threshold; the
	// 100ms budget must interrupt it and surface the budget error.
	result, ok = reg.DispatchCommand(ctx, 1, 2, "spin", []string{strings.Repeat("x", 200)})
	if !ok || result == nil {
		t.Fatalf("overrun dispatch returned no result: ok=%v", ok)
	}
	if !strings.Contains(result.Reply, "CPU budget") {
		t.Fatalf("expected CPU budget error, got %q", result.Reply)
	}

	// The plugin must still work: the next small dispatch re-instantiates the
	// module lazily instead of dispatching into the closed one forever.
	result, ok = reg.DispatchCommand(ctx, 1, 2, "spin", nil)
	if !ok || result == nil {
		t.Fatalf("post-overrun dispatch failed: ok=%v result=%+v", ok, result)
	}
	if strings.Contains(result.Reply, "CPU budget") || strings.Contains(result.Reply, "module closed") {
		t.Fatalf("plugin still bricked after overrun: %q", result.Reply)
	}
	if !inst.Enabled {
		t.Fatal("overrun must not disable the plugin")
	}
}

// TestWazeroConcurrentDispatchRace locks F2: concurrent invocations of the same
// plugin command must be serialized per Instance. Without a per-Instance lock,
// two goroutines drive one shared wazero module (allocate / mem.Write /
// command_dispatch / mem.Read) with no synchronization, racing on its linear
// memory. Run under -race: without the fix the detector reports a data race;
// with it the run is clean.
func TestWazeroConcurrentDispatchRace(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"spinner","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"spin"}]}`
	writeTestPlugin(t, dir, "spinner", manifest, spinWASM)

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
	if err := reg.RegisterCommand("spin", inst); err != nil {
		t.Fatalf("RegisterCommand: %v", err)
	}

	const goroutines = 8
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for j := 0; j < 20; j++ {
				reg.DispatchCommand(ctx, 1, 2, "spin", nil)
			}
		}()
	}
	close(start)
	wg.Wait()
}

// noMemWASM exports the command ABI but declares NO memory section, so
// api.Module.Memory() returns nil for it:
//
//	(module
//	  (func (export "list_commands") (result i32 i32) i32.const 0 i32.const 0)
//	  (func (export "allocate") (param i32) (result i32) i32.const 0)
//	  (func (export "command_dispatch") (param i32 i32) (result i32 i32)
//	    i32.const 0 i32.const 0))
var noMemWASM = []byte{
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // \0asm v1
	// type section: ()->(i32,i32), (i32)->i32, (i32,i32)->(i32,i32)
	0x01, 0x12, 0x03,
	0x60, 0x00, 0x02, 0x7f, 0x7f,
	0x60, 0x01, 0x7f, 0x01, 0x7f,
	0x60, 0x02, 0x7f, 0x7f, 0x02, 0x7f, 0x7f,
	// function section: 3 funcs using types 0,1,2
	0x03, 0x04, 0x03, 0x00, 0x01, 0x02,
	// (no memory section — this is the point of the fixture)
	// export section: list_commands, allocate, command_dispatch
	0x07, 0x2f, 0x03,
	0x0d, 0x6c, 0x69, 0x73, 0x74, 0x5f, 0x63, 0x6f, 0x6d, 0x6d, 0x61, 0x6e, 0x64, 0x73, 0x00, 0x00,
	0x08, 0x61, 0x6c, 0x6c, 0x6f, 0x63, 0x61, 0x74, 0x65, 0x00, 0x01,
	0x10, 0x63, 0x6f, 0x6d, 0x6d, 0x61, 0x6e, 0x64, 0x5f, 0x64, 0x69, 0x73, 0x70, 0x61, 0x74, 0x63, 0x68, 0x00, 0x02,
	// code section
	0x0a, 0x14, 0x03,
	0x06, 0x00, 0x41, 0x00, 0x41, 0x00, 0x0b, // list_commands: (0,0)
	0x04, 0x00, 0x41, 0x00, 0x0b, // allocate: 0
	0x06, 0x00, 0x41, 0x00, 0x41, 0x00, 0x0b, // command_dispatch: (0,0)
}

// TestWazeroMemorylessModuleDoesNotPanic locks the nil-memory guard: a guest
// that exports the command ABI but declares no memory section must be handled
// as a bad plugin, not dereferenced. Both host paths that touch guest memory
// are covered — activation (list_commands) and dispatch (command_dispatch) —
// because a panic on the activation path aborts server startup for every
// subsequent restart while the plugin row stays enabled.
func TestWazeroMemorylessModuleDoesNotPanic(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"nomem","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"noop"}]}`
	writeTestPlugin(t, dir, "nomem", manifest, noMemWASM)

	reg, mem := newWazeroTestRegistry(t, dir)
	ctx := context.Background()
	if err := reg.LoadAll(ctx); err != nil {
		t.Fatal(err)
	}
	rows, _ := mem.ListPlugins(ctx)
	// Activation calls list_commands, which used to nil-deref the guest memory.
	if err := reg.EnablePlugin(ctx, rows[0].ID); err != nil {
		t.Fatalf("EnablePlugin: %v", err)
	}
	reg.mu.RLock()
	inst := reg.plugins[rows[0].ID]
	reg.mu.RUnlock()
	if inst == nil || inst.module == nil {
		t.Fatal("expected the module to activate")
	}
	// No command may bind: the name list is unreadable without memory.
	reg.mu.RLock()
	_, bound := reg.commands["noop"]
	reg.mu.RUnlock()
	if bound {
		t.Fatal("memoryless module must not auto-bind commands")
	}

	// The dispatch path must report a diagnostic instead of writing into nil.
	if err := reg.RegisterCommand("noop", inst); err != nil {
		t.Fatalf("RegisterCommand: %v", err)
	}
	result, ok := reg.DispatchCommand(ctx, 1, 2, "noop", nil)
	if !ok || result == nil {
		t.Fatalf("expected a dispatch result: ok=%v result=%+v", ok, result)
	}
	if !strings.Contains(result.Reply, "no exported memory") {
		t.Fatalf("expected a missing-memory diagnostic, got %q", result.Reply)
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
