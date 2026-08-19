//go:build wazero

// Phase C Step 9 — Real Wazero-backed plugin runtime. Compiled only with
// `-tags wazero`; matches the otel build-tag pattern used
// elsewhere in the repo so the default sqlite-only build does not pull
// wazero into go.mod at runtime.
//
// # Architecture
//
// The wazero-tagged build provides:
//
//	platformInit        — creates the shared wazero.Runtime (with the
//	                      configured memory cap and WASI preview-1 imports)
//	                      and returns a teardown closure consumed by
//	                      Registry.Close.
//	activateWithRuntime — compiles the plugin's .wasm entrypoint, instantiates
//	                      it against the shared runtime, stores the resulting
//	                      api.Module on the Instance, and auto-registers any
//	                      commands the module exports via list_commands.
//	platformDeactivate  — closes the per-plugin module without tearing down
//	                      the shared runtime; called by DisablePlugin so a
//	                      disabled plugin frees memory immediately.
//	invokeCommand       — calls the plugin's `command_dispatch` export using
//	                      the JSON-ABI:
//	                          allocate(size u32) → ptr u32
//	                          command_dispatch(ptr u32, len u32) → (ptr u32, len u32)
//	                          deallocate(ptr u32, len u32)
//	                      Both input and output payloads are JSON.
//
// Plugins that do not export command_dispatch / allocate are still loadable
// — DispatchCommand reports a user-facing diagnostic instead of crashing.
package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"reflect"
	"strings"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// wazeroPageBytes is the size of a single WASM linear-memory page (64 KiB).
const wazeroPageBytes = 65536

// guestMemory returns the module's linear memory, or nil when the guest
// declared none. It exists because api.Module.Memory() is NOT safe to
// dereference blindly: wazero returns its *wasm.MemoryInstance field as-is, and
// that field is only populated for a module with a memory section — so a
// memoryless guest yields a non-nil api.Memory interface wrapping a nil
// pointer, and every method on it (Read, Write, Size) panics. A plain
// `mem == nil` check does not catch that, hence the pointer-level check here.
// Every host access to guest memory must go through this helper.
func guestMemory(mod api.Module) api.Memory {
	mem := mod.Memory()
	if mem == nil {
		return nil
	}
	if v := reflect.ValueOf(mem); v.Kind() == reflect.Ptr && v.IsNil() {
		return nil
	}
	return mem
}

// platformInit stands up the shared wazero runtime for this Registry. The
// runtime is the top-level handle that owns compiled modules, host modules,
// and per-instance linear memory; every plugin in this registry shares it.
//
// The configured MaxMemoryMB cap is translated to wazero's per-page memory
// limit (64 KiB pages) and applied at runtime construction. WASI preview-1
// is pre-instantiated so plugins compiled with the standard TinyGo / Rust
// wasm32-wasi targets can resolve their syscall imports.
func platformInit(cfg Config) (any, func(context.Context) error, error) {
	ctx := context.Background()

	memMB := cfg.MaxMemoryMB
	if memMB <= 0 {
		memMB = 64 // default 64 MiB per plugin runtime
	}
	// Compute the byte count in 64-bit before dividing down to pages: doing
	// the multiplication in uint32 wraps at 4 GiB, so a configured
	// max_memory_mb at or above 4096 would silently truncate (or zero out)
	// the limit actually installed. wazero's own ceiling is 65536 pages
	// (4 GiB, wasm32's addressable maximum; WithMemoryLimitPages panics
	// above it), so clamp to that after computing in 64-bit.
	const wazeroMaxPages = 65536
	pages := uint64(memMB) * 1024 * 1024 / wazeroPageBytes
	if pages > wazeroMaxPages {
		pages = wazeroMaxPages
	}
	memPages := uint32(pages)

	rt := wazero.NewRuntimeWithConfig(ctx,
		wazero.NewRuntimeConfig().
			WithMemoryLimitPages(memPages).
			WithCloseOnContextDone(true),
	)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		_ = rt.Close(ctx)
		return nil, nil, fmt.Errorf("wazero: wasi snapshot_preview1: %w", err)
	}
	closeFn := func(shutCtx context.Context) error {
		return rt.Close(shutCtx)
	}
	return rt, closeFn, nil
}

// activateWithRuntime compiles inst.WASMPath into a wazero module and
// instantiates it under the shared runtime. The resulting api.Module is
// stashed on inst.module so lifecycle teardown (Close, DisablePlugin) can
// free it without walking the registry again.
//
// The runtime is passed in by Registry.activate as a captured snapshot so
// this function never re-reads r.runtimePlatform — that field can be nil-ed
// concurrently by Close, but the snapshot remains valid (the wazero runtime
// itself returns an error gracefully if it has been closed underneath us).
func (r *Registry) activateWithRuntime(ctx context.Context, platform any, inst *Instance) error {
	rt, ok := platform.(wazero.Runtime)
	if !ok || rt == nil {
		return fmt.Errorf("plugin %q: wazero runtime unavailable", inst.Manifest.Name)
	}
	wasmBytes, err := os.ReadFile(inst.WASMPath)
	if err != nil {
		return fmt.Errorf("plugin %q: read wasm: %w", inst.Manifest.Name, err)
	}

	// CompileModule is CPU-bound; do it without holding the registry lock.
	compiled, err := rt.CompileModule(ctx, wasmBytes)
	if err != nil {
		return fmt.Errorf("plugin %q: compile: %w", inst.Manifest.Name, err)
	}

	// Each plugin gets its own module name so multiple instances can coexist
	// without colliding in the runtime's global module namespace. Output is
	// swallowed so a misbehaving plugin can't flood server logs. _start is
	// suppressed so exports are only invoked on demand.
	modCfg := wazero.NewModuleConfig().
		WithName(inst.Manifest.Name).
		WithStdin(strings.NewReader("")). // prevent plugins from reading server stdin
		WithStdout(io.Discard).
		WithStderr(io.Discard).
		WithStartFunctions()

	module, err := rt.InstantiateModule(ctx, compiled, modCfg)
	if err != nil {
		_ = compiled.Close(ctx)
		return fmt.Errorf("plugin %q: instantiate: %w", inst.Manifest.Name, err)
	}

	// Store the module under the lock, then auto-bind any commands the plugin
	// exports via list_commands. Binding is routed through RegisterCommand so
	// each name goes through the same normalization (trim "/" + lowercase) and
	// conflict check the direct registration path uses: a command already owned
	// by a DIFFERENT plugin is refused rather than silently clobbered, closing
	// the cross-plugin command-hijack hole. RegisterCommand acquires r.mu
	// itself, so it is called outside the lock below to avoid re-entrant
	// locking. The plugin must also have declared the `commands` capability in
	// its manifest, otherwise no binding happens — and RegisterCommand refuses
	// any name the manifest's `commands` block did not declare, so a guest
	// module cannot widen its own command surface by returning extra names
	// from list_commands.
	r.mu.Lock()
	if inst.module != nil {
		// Lost a concurrent activation race (e.g. two dispatches both saw a
		// closed module); keep the winner's module and discard ours. The
		// winner already handled command binding.
		r.mu.Unlock()
		_ = module.Close(ctx)
		_ = compiled.Close(ctx)
		return nil
	}
	inst.module = module
	inst.compiled = compiled
	r.mu.Unlock()
	if inst.Manifest.HasCapability(CapCommands) {
		for _, cmd := range listExportedCommands(ctx, module) {
			if err := r.RegisterCommand(cmd, inst); err != nil {
				slog.Warn("plugin: skipping command binding",
					"plugin", inst.Manifest.Name, "command", cmd, "err", err)
			}
		}
	}
	return nil
}

// platformDeactivate closes the wazero module held by inst without touching
// the shared runtime. Safe to call on an instance that was never activated.
// Called from DisablePlugin and Close. Module teardown must run to completion
// once started, so the caller's cancellation is detached (WithoutCancel).
func (r *Registry) platformDeactivate(ctx context.Context, inst *Instance) {
	if inst == nil || inst.module == nil {
		return
	}
	if mod, ok := inst.module.(api.Module); ok {
		_ = mod.Close(context.WithoutCancel(ctx))
	}
	inst.module = nil
	if compiled, ok := inst.compiled.(wazero.CompiledModule); ok {
		_ = compiled.Close(context.WithoutCancel(ctx))
	}
	inst.compiled = nil
}

// invokeCommand calls the plugin's exported `command_dispatch` function
// using a small JSON ABI:
//
//	allocate(size u32) → ptr u32
//	command_dispatch(ptr u32, len u32) → (result_ptr u32, result_len u32)
//	deallocate(ptr u32, len u32)
//
// Both the input and output payloads are JSON. A plugin that does not
// export command_dispatch returns (nil, false) so the WS dispatcher can
// fall back to the not-found response. A plugin that exports
// command_dispatch but lacks allocate returns a user-facing diagnostic.
func (r *Registry) invokeCommand(ctx context.Context, inst *Instance, userID, channelID int64, cmd string, args []string) (*CommandResult, bool) {
	if inst == nil {
		return nil, false
	}
	// F2: serialize all guest interaction for this instance. wazero's
	// Function.Call is not goroutine-safe, and concurrent allocate/mem.Write/
	// command_dispatch/mem.Read on the shared module tear its linear-memory
	// slice header. A per-Instance lock (not r.mu — that would serialize every
	// plugin in the registry and be held across a full CPU budget) confines
	// contention to concurrent invocations of the SAME plugin, and also makes the
	// lazy re-activation below atomic so two overruns can't double-instantiate.
	inst.invokeMu.Lock()
	defer inst.invokeMu.Unlock()

	r.mu.RLock()
	moduleAny := inst.module
	enabled := inst.Enabled
	r.mu.RUnlock()
	if moduleAny == nil {
		// A previous CPU-budget overrun or guest trap closed the module
		// (releaseClosedModule cleared it). Re-instantiate lazily so one bad
		// command doesn't brick the plugin until an admin disable/enable
		// cycle or a server restart. Re-instantiation resets the guest's
		// in-memory state. Disabled plugins stay dark.
		if !enabled {
			return nil, false
		}
		if err := r.activate(ctx, inst); err != nil {
			return &CommandResult{Reply: fmt.Sprintf("plugin %s: reactivate: %v", inst.Manifest.Name, err)}, true
		}
		r.mu.RLock()
		moduleAny = inst.module
		r.mu.RUnlock()
		if moduleAny == nil {
			return nil, false
		}
	}
	mod, ok := moduleAny.(api.Module)
	if !ok {
		return nil, false
	}

	dispatchFn := mod.ExportedFunction("command_dispatch")
	if dispatchFn == nil {
		return &CommandResult{
			Reply: fmt.Sprintf("plugin %q does not export command_dispatch (rebuild the plugin to handle /%s)", inst.Manifest.Name, cmd),
		}, true
	}
	allocFn := mod.ExportedFunction("allocate")
	deallocFn := mod.ExportedFunction("deallocate")
	if allocFn == nil {
		return &CommandResult{
			Reply: fmt.Sprintf("plugin %s: missing allocate export (required for command dispatch)", inst.Manifest.Name),
		}, true
	}
	// A guest that declares no linear memory has no usable JSON ABI. Checked
	// here, with the other ABI preconditions and before any guest call, rather
	// than dereferenced blindly further down.
	mem := guestMemory(mod)
	if mem == nil {
		return &CommandResult{
			Reply: fmt.Sprintf("plugin %s: no exported memory (required for command dispatch)", inst.Manifest.Name),
		}, true
	}

	type dispatchPayload struct {
		UserID    int64    `json:"user_id"`
		ChannelID int64    `json:"channel_id"`
		Command   string   `json:"command"`
		Args      []string `json:"args"`
	}
	payload, err := json.Marshal(dispatchPayload{
		UserID: userID, ChannelID: channelID, Command: cmd, Args: args,
	})
	if err != nil {
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: marshal payload: %v", inst.Manifest.Name, err)}, true
	}

	// Enforce the plugin's CPU budget. The effective budget is the manifest's
	// Resources.CPUBudgetMs, falling back to the configured default, then a
	// hard 100ms floor so a zero/negative value can never mean "no limit".
	// Every guest call (allocate / command_dispatch / deallocate) runs under
	// this deadline instead of the long-lived WebSocket context. The runtime
	// was created WithCloseOnContextDone(true), so an expired deadline closes
	// the module and interrupts a runaway guest (e.g. `for {}`) — the Call
	// returns an error rather than panicking, which the paths below surface,
	// and releaseClosedModule then marks the instance for lazy
	// re-instantiation on the next dispatch.
	//
	// The budget is wall-clock over guest execution. No host imports are
	// wired into the runtime yet, so host-call time cannot be attributed to
	// the guest today; when host functions (host_http, host_storage, …) land,
	// their execution time must be excluded from this budget — otherwise the
	// floor would kill any command performing a host HTTP call (httpTimeout
	// is 10s against a 100ms floor).
	budgetMs := inst.Manifest.Resources.CPUBudgetMs
	if budgetMs <= 0 {
		budgetMs = r.cfg.CPUBudgetMs
	}
	if budgetMs <= 0 {
		budgetMs = 100
	}
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(budgetMs)*time.Millisecond)
	defer cancel()

	// Allocate guest memory for the input payload.
	size := uint64(len(payload))
	ptrs, callErr := allocFn.Call(callCtx, size)
	if callErr != nil || len(ptrs) == 0 {
		r.releaseClosedModule(inst, mod)
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: allocate(%d): %v", inst.Manifest.Name, size, callErr)}, true
	}
	ptr := ptrs[0]

	if !mem.Write(uint32(ptr), payload) {
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: memory write at %d failed", inst.Manifest.Name, ptr)}, true
	}

	results, callErr := dispatchFn.Call(callCtx, ptr, size)

	// Free the input buffer regardless of dispatch outcome.
	if deallocFn != nil {
		_, _ = deallocFn.Call(callCtx, ptr, size)
	}

	if callErr != nil {
		// A failed guest call may have closed the module (deadline, trap,
		// parent-context cancellation); release it so the next dispatch
		// re-instantiates instead of dispatching into a dead module forever.
		r.releaseClosedModule(inst, mod)
		// Surface a CPU-budget overrun as a clean, specific error rather than
		// leaking the raw "module closed with context deadline exceeded".
		if callCtx.Err() == context.DeadlineExceeded {
			return &CommandResult{Reply: fmt.Sprintf("plugin %s: command exceeded CPU budget of %dms", inst.Manifest.Name, budgetMs)}, true
		}
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: dispatch: %v", inst.Manifest.Name, callErr)}, true
	}
	if len(results) < 2 {
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: command_dispatch returned %d values, want 2", inst.Manifest.Name, len(results))}, true
	}

	resPtr, resLen := uint32(results[0]), uint32(results[1])
	resBytes, ok2 := mem.Read(resPtr, resLen)
	if !ok2 {
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: cannot read result at %d+%d", inst.Manifest.Name, resPtr, resLen)}, true
	}

	type dispatchResult struct {
		Reply string `json:"reply"`
	}
	var dr dispatchResult
	if err := json.Unmarshal(resBytes, &dr); err != nil {
		// Fall back to raw bytes if the JSON is malformed.
		return &CommandResult{Reply: string(resBytes)}, true
	}
	return &CommandResult{Reply: dr.Reply}, true
}

// releaseClosedModule drops inst.module when the wazero runtime closed it out
// from under us (CPU-budget deadline via WithCloseOnContextDone, a guest
// trap, or parent-context cancellation), so the next dispatch lazily
// re-instantiates the plugin instead of erroring on a dead module forever.
// The pointer guard keeps a concurrent re-activation's fresh module intact.
func (r *Registry) releaseClosedModule(inst *Instance, mod api.Module) {
	if !mod.IsClosed() {
		return
	}
	r.mu.Lock()
	var staleCompiled any
	if inst.module == mod {
		inst.module = nil
		// The next dispatch re-activates with a fresh compile; close the
		// stale CompiledModule or the runtime retains every one until exit.
		staleCompiled = inst.compiled
		inst.compiled = nil
	}
	r.mu.Unlock()
	if compiled, ok := staleCompiled.(wazero.CompiledModule); ok {
		_ = compiled.Close(context.Background())
	}
}

// listExportedCommands calls the plugin's optional `list_commands` export
// which returns (ptr u32, len u32) pointing to a JSON array of command name
// strings. If the export is absent, the module declares no linear memory, or
// the result is invalid JSON, an empty slice is returned and no command
// bindings are created.
func listExportedCommands(ctx context.Context, mod api.Module) []string {
	fn := mod.ExportedFunction("list_commands")
	if fn == nil {
		return nil
	}
	results, err := fn.Call(ctx)
	if err != nil || len(results) < 2 {
		return nil
	}
	// A guest with no memory section has no memory to read the name list from
	// (and its api.Memory must not be touched — see guestMemory).
	mem := guestMemory(mod)
	if mem == nil {
		return nil
	}
	ptr, length := uint32(results[0]), uint32(results[1])
	raw, ok := mem.Read(ptr, length)
	if !ok {
		return nil
	}
	var cmds []string
	if err := json.Unmarshal(raw, &cmds); err != nil {
		return nil
	}
	return cmds
}
