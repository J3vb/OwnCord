//go:build wazero

// Bounds the host keeps on guest-chosen values: how long a guest call may run,
// how large a result region it may hand back, and how much work an overrun can
// make the host repeat. Fixtures shared with sandbox_wazero_test.go.
package plugin

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// enableTestPlugin loads and enables the single plugin under the registry's
// directory and binds cmd to it, returning the live Instance.
func enableTestPlugin(t *testing.T, reg *Registry, mem PluginStore, cmd string) *Instance {
	t.Helper()
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
	if err := reg.RegisterCommand(cmd, inst); err != nil {
		t.Fatalf("RegisterCommand: %v", err)
	}
	return inst
}

// TestWazeroManifestBudgetCannotExceedConfig: plugins.cpu_budget_ms is the
// operator's ceiling. A manifest may ask for less, never for more — otherwise
// the untrusted side picks its own deadline and holds invokeMu for all of it.
func TestWazeroManifestBudgetCannotExceedConfig(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"spinner","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"spin"}],"resources":{"cpu_budget_ms":3000}}`
	writeTestPlugin(t, dir, "spinner", manifest, spinWASM)
	reg, mem := newWazeroTestRegistry(t, dir) // config budget: 100ms
	enableTestPlugin(t, reg, mem, "spin")

	start := time.Now()
	result, ok := reg.DispatchCommand(context.Background(), 1, 2, "spin", []string{strings.Repeat("x", 200)})
	elapsed := time.Since(start)
	if !ok || result == nil {
		t.Fatalf("overrun dispatch returned no result: ok=%v", ok)
	}
	if !strings.Contains(result.Reply, "CPU budget of 100ms") {
		t.Fatalf("manifest budget 3000ms must be clamped to the configured 100ms, got %q", result.Reply)
	}
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("guest ran %v; the configured 100ms ceiling did not apply", elapsed)
	}
}

// TestWazeroOverrunReusesCompiledModule: a deadline closes the module
// instance, not the CompiledModule. Re-activation after an overrun must
// re-instantiate from the retained compile rather than re-read and re-compile
// the .wasm, or a guest that overruns on purpose buys a compile per dispatch.
// Removing the file from disk makes a re-read fail loudly.
func TestWazeroOverrunReusesCompiledModule(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"spinner","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"spin"}]}`
	writeTestPlugin(t, dir, "spinner", manifest, spinWASM)
	reg, mem := newWazeroTestRegistry(t, dir)
	enableTestPlugin(t, reg, mem, "spin")
	if err := os.Remove(filepath.Join(dir, "spinner", "hello.wasm")); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	result, _ := reg.DispatchCommand(ctx, 1, 2, "spin", []string{strings.Repeat("x", 200)})
	if result == nil || !strings.Contains(result.Reply, "CPU budget") {
		t.Fatalf("expected CPU budget error, got %+v", result)
	}
	result, ok := reg.DispatchCommand(ctx, 1, 2, "spin", nil)
	if !ok || result == nil {
		t.Fatalf("post-overrun dispatch failed: ok=%v result=%+v", ok, result)
	}
	if result.Reply != "" {
		t.Fatalf("post-overrun dispatch must re-instantiate from the retained compile, got %q", result.Reply)
	}
}

// bigReplyWASM is spinWASM's ABI with two memory pages and a command_dispatch
// that returns (0, 131072): a 128 KiB result region of NUL bytes.
var bigReplyWASM = []byte{
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
	0x01, 0x12, 0x03,
	0x60, 0x01, 0x7f, 0x01, 0x7f,
	0x60, 0x02, 0x7f, 0x7f, 0x00,
	0x60, 0x02, 0x7f, 0x7f, 0x02, 0x7f, 0x7f,
	0x03, 0x04, 0x03, 0x00, 0x01, 0x02,
	// memory section: 2 pages, no max
	0x05, 0x03, 0x01, 0x00, 0x02,
	0x07, 0x35, 0x04,
	0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
	0x08, 0x61, 0x6c, 0x6c, 0x6f, 0x63, 0x61, 0x74, 0x65, 0x00, 0x00,
	0x0a, 0x64, 0x65, 0x61, 0x6c, 0x6c, 0x6f, 0x63, 0x61, 0x74, 0x65, 0x00, 0x01,
	0x10, 0x63, 0x6f, 0x6d, 0x6d, 0x61, 0x6e, 0x64, 0x5f, 0x64, 0x69, 0x73, 0x70, 0x61, 0x74, 0x63, 0x68, 0x00, 0x02,
	// code section
	0x0a, 0x12, 0x03,
	0x04, 0x00, 0x41, 0x08, 0x0b, // allocate: return 8
	0x02, 0x00, 0x0b, // deallocate: nop
	0x08, 0x00, // command_dispatch
	0x41, 0x00, // i32.const 0
	0x41, 0x80, 0x80, 0x08, // i32.const 131072
	0x0b,
}

// TestWazeroOversizedReplyRejected: the guest picks the result length, so the
// host must refuse a region over maxGuestResultBytes instead of copying it out
// and queueing it on the invoker's socket.
func TestWazeroOversizedReplyRejected(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"bigreply","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"big"}]}`
	writeTestPlugin(t, dir, "bigreply", manifest, bigReplyWASM)
	reg, mem := newWazeroTestRegistry(t, dir)
	enableTestPlugin(t, reg, mem, "big")

	result, ok := reg.DispatchCommand(context.Background(), 1, 2, "big", nil)
	if !ok || result == nil {
		t.Fatalf("dispatch returned no result: ok=%v", ok)
	}
	if len(result.Reply) > 1024 || !strings.Contains(result.Reply, "exceeds") {
		t.Fatalf("128 KiB guest result must be refused with a short diagnostic, got %d bytes", len(result.Reply))
	}
}

// listSpinWASM exports memory and a list_commands that never returns:
//
//	(module
//	  (memory (export "memory") 1)
//	  (func (export "list_commands") (result i32 i32)
//	    (loop br 0) i32.const 0 i32.const 0))
var listSpinWASM = []byte{
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
	0x01, 0x06, 0x01, 0x60, 0x00, 0x02, 0x7f, 0x7f, // type: () -> (i32,i32)
	0x03, 0x02, 0x01, 0x00,
	0x05, 0x03, 0x01, 0x00, 0x01,
	0x07, 0x1a, 0x02,
	0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
	0x0d, 0x6c, 0x69, 0x73, 0x74, 0x5f, 0x63, 0x6f, 0x6d, 0x6d, 0x61, 0x6e, 0x64, 0x73, 0x00, 0x00,
	0x0a, 0x0d, 0x01,
	0x0b, 0x00,
	0x03, 0x40, 0x0c, 0x00, 0x0b, // loop br 0 end
	0x41, 0x00, 0x41, 0x00,
	0x0b,
}

// TestWazeroListCommandsRunsUnderBudget: list_commands is guest code too. It
// runs at enable, at startup and on every lazy re-activation (under invokeMu),
// so it gets the same CPU budget as command_dispatch, and an activation whose
// list_commands overran fails instead of leaving a closed module installed.
func TestWazeroListCommandsRunsUnderBudget(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"listspin","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"x"}]}`
	writeTestPlugin(t, dir, "listspin", manifest, listSpinWASM)
	reg, mem := newWazeroTestRegistry(t, dir)

	// Backstop only: without the budget the guest spins until this expires.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := reg.LoadAll(ctx); err != nil {
		t.Fatal(err)
	}
	rows, _ := mem.ListPlugins(ctx)
	start := time.Now()
	err := reg.EnablePlugin(ctx, rows[0].ID)
	elapsed := time.Since(start)
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("list_commands ran %v; the 100ms budget did not apply", elapsed)
	}
	if err == nil {
		t.Fatal("EnablePlugin must fail when list_commands overruns its budget")
	}
	reg.mu.RLock()
	inst := reg.plugins[rows[0].ID]
	reg.mu.RUnlock()
	if inst.module != nil {
		t.Fatal("a module closed by the budget must not stay installed")
	}
}
