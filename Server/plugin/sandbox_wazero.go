//go:build wazero

// Real Wazero-backed plugin runtime, compiled only with `-tags wazero` so the
// default sqlite-only build does not pull wazero in at runtime.
//
// The wazero-tagged build provides:
//
//	platformInit        — creates the shared wazero.Runtime (with the
//	                      configured memory cap and WASI preview-1 imports)
//	                      and returns a teardown closure for Registry.Close.
//	activateWithRuntime — compiles the plugin's .wasm entrypoint, instantiates
//	                      it against the shared runtime, stores the api.Module
//	                      on the Instance, and auto-registers any commands the
//	                      module exports via list_commands.
//	platformDeactivate  — closes the per-plugin module without tearing down
//	                      the shared runtime, so a disabled plugin frees memory.
//	invokeCommand       — calls the plugin's `command_dispatch` export using
//	                      the JSON-ABI:
//	                          allocate(size u32) → ptr u32
//	                          command_dispatch(ptr u32, len u32) → (ptr u32, len u32)
//	                          deallocate(ptr u32, len u32)
//	                      Both input and output payloads are JSON.
//
// Plugins that export neither command_dispatch nor allocate still load;
// DispatchCommand reports a user-facing diagnostic instead of crashing.
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
// declared none. api.Module.Memory() is not safe to dereference blindly: wazero
// returns its *wasm.MemoryInstance field as-is, populated only for a module with
// a memory section, so a memoryless guest yields a non-nil api.Memory wrapping a
// nil pointer whose methods panic. A plain `mem == nil` misses that, hence the
// pointer-level check. Every host access to guest memory goes through this.
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

// platformInit stands up the shared wazero runtime for this Registry, the
// handle that owns compiled modules, host modules and per-instance linear
// memory. MaxMemoryMB is translated to wazero's 64 KiB page limit, and WASI
// preview-1 is pre-instantiated so TinyGo / Rust wasm32-wasi plugins resolve
// their syscall imports.
func platformInit(cfg Config) (any, func(context.Context) error, error) {
	ctx := context.Background()

	memMB := cfg.MaxMemoryMB
	if memMB <= 0 {
		memMB = 64 // default 64 MiB per plugin runtime
	}
	// Compute the byte count in 64-bit before dividing to pages: a uint32
	// multiplication wraps at 4 GiB, silently truncating a max_memory_mb of 4096
	// or more. wazero's ceiling is 65536 pages (wasm32's maximum;
	// WithMemoryLimitPages panics above it), so clamp after the 64-bit compute.
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
// instantiates it under the shared runtime, stashing the api.Module on
// inst.module so Close and DisablePlugin can free it without walking the
// registry. Registry.activate passes the runtime as a captured snapshot so this
// never re-reads r.runtimePlatform, which Close can nil concurrently (a closed
// wazero runtime returns an error gracefully).
func (r *Registry) activateWithRuntime(ctx context.Context, platform any, inst *Instance) error {
	rt, ok := platform.(wazero.Runtime)
	if !ok || rt == nil {
		return fmt.Errorf("plugin %q: wazero runtime unavailable", inst.Manifest.Name)
	}
	// A module closed out from under us (CPU-budget deadline, guest trap) leaves
	// its CompiledModule valid and releaseClosedModule retains it, so
	// re-activation re-instantiates without the disk or compiler. A guest can
	// force a re-activation per dispatch; it must not also buy a compile each.
	r.mu.RLock()
	compiled, _ := inst.compiled.(wazero.CompiledModule)
	r.mu.RUnlock()
	if compiled == nil {
		wasmBytes, err := os.ReadFile(inst.WASMPath)
		if err != nil {
			return fmt.Errorf("plugin %q: read wasm: %w", inst.Manifest.Name, err)
		}
		// CompileModule is CPU-bound; do it without holding the registry lock.
		compiled, err = rt.CompileModule(ctx, wasmBytes)
		if err != nil {
			return fmt.Errorf("plugin %q: compile: %w", inst.Manifest.Name, err)
		}
	}

	// Each plugin gets its own module name so instances do not collide in the
	// runtime's namespace. Output is swallowed so a misbehaving plugin cannot
	// flood server logs, and _start is suppressed so exports run on demand.
	modCfg := wazero.NewModuleConfig().
		WithName(inst.Manifest.Name).
		WithStdin(strings.NewReader("")). // prevent plugins from reading server stdin
		WithStdout(io.Discard).
		WithStderr(io.Discard).
		WithStartFunctions()

	module, err := rt.InstantiateModule(ctx, compiled, modCfg)
	if err != nil {
		r.mu.Lock()
		if inst.compiled == compiled {
			inst.compiled = nil // a retained compile that no longer instantiates is dropped, not retried
		}
		r.mu.Unlock()
		_ = compiled.Close(ctx)
		return fmt.Errorf("plugin %q: instantiate: %w", inst.Manifest.Name, err)
	}

	// Store the module under the lock, then auto-bind any commands it exports
	// via list_commands. Binding goes through RegisterCommand so each name gets
	// the same normalization (trim "/" + lowercase) and conflict check as direct
	// registration: a command owned by a different plugin is refused, closing the
	// cross-plugin command-hijack hole. RegisterCommand takes r.mu itself, so it
	// runs outside the lock. The plugin must declare the `commands` capability
	// and RegisterCommand refuses names its manifest's `commands` block did not
	// declare, so a guest cannot widen its command surface via list_commands.
	r.mu.Lock()
	if inst.module != nil {
		// Lost a concurrent activation race (two dispatches both saw a closed
		// module): keep the winner's module and discard ours; the winner bound
		// the commands. Our compile is closed only if the winner is not running
		// on the same retained one.
		shared := inst.compiled == compiled
		r.mu.Unlock()
		_ = module.Close(ctx)
		if !shared {
			_ = compiled.Close(ctx)
		}
		return nil
	}
	inst.module = module
	inst.compiled = compiled
	r.mu.Unlock()
	if inst.Manifest.HasCapability(CapCommands) {
		// list_commands is guest code: it runs under the same CPU budget as
		// command_dispatch, not the caller's long-lived context. This path is
		// reached at enable, startup and every lazy re-activation (with
		// inst.invokeMu held), so an unbounded call would be an unbounded hold.
		listCtx, cancel := context.WithTimeout(ctx, r.guestBudget(inst))
		cmds, err := listExportedCommands(listCtx, module)
		cancel()
		if err != nil || module.IsClosed() {
			// A trap leaves the module open; close it so releaseClosedModule drops it.
			_ = module.Close(ctx)
			r.releaseClosedModule(inst, module)
			return listCommandsError(inst.Manifest.Name, err)
		}
		for _, cmd := range cmds {
			if err := r.RegisterCommand(cmd, inst); err != nil {
				slog.Warn("plugin: skipping command binding",
					"plugin", inst.Manifest.Name, "command", cmd, "err", err)
			}
		}
	}
	return nil
}

// listCommandsError reports a failed list_commands call. err is nil when the
// call itself returned cleanly but the module was found closed afterwards.
func listCommandsError(plugin string, err error) error {
	if err == nil {
		return fmt.Errorf("plugin %q: list_commands left the module closed", plugin)
	}
	return fmt.Errorf("plugin %q: list_commands exceeded its CPU budget or trapped: %w", plugin, err)
}

// platformDeactivate closes the wazero module held by inst without touching the
// shared runtime; safe on a never-activated instance. Called from
// DisablePlugin and Close. Module teardown must run to completion once started,
// so the caller's cancellation is detached.
func (r *Registry) platformDeactivate(ctx context.Context, inst *Instance) {
	// No early return on a nil module: releaseClosedModule can leave a retained
	// CompiledModule behind a nil module, which still has to be freed.
	if inst == nil {
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

// invokeCommand calls the plugin's exported `command_dispatch` function using
// the JSON ABI:
//
//	allocate(size u32) → ptr u32
//	command_dispatch(ptr u32, len u32) → (result_ptr u32, result_len u32)
//	deallocate(ptr u32, len u32)
//
// Input and output payloads are JSON. A plugin without command_dispatch returns
// (nil, false) so the WS dispatcher falls back to the not-found response; one
// that exports it but lacks allocate returns a user-facing diagnostic.
func (r *Registry) invokeCommand(ctx context.Context, inst *Instance, userID, channelID int64, cmd string, args []string) (*CommandResult, bool) {
	if inst == nil {
		return nil, false
	}
	// Serialize all guest interaction for this instance: wazero's Function.Call
	// is not goroutine-safe, and concurrent allocate/mem.Write/command_dispatch/
	// mem.Read tear the module's linear-memory slice header. A per-Instance lock
	// (not r.mu, which would serialize every plugin and be held across a full CPU
	// budget) confines contention to the same plugin and makes the lazy
	// re-activation below atomic, so two overruns cannot double-instantiate.
	inst.invokeMu.Lock()
	defer inst.invokeMu.Unlock()

	r.mu.RLock()
	moduleAny := inst.module
	enabled := inst.Enabled
	r.mu.RUnlock()
	if moduleAny == nil {
		// A CPU-budget overrun or guest trap closed the module
		// (releaseClosedModule cleared it). Re-instantiate lazily so one bad
		// command doesn't brick the plugin until a disable/enable or restart; this
		// resets the guest's in-memory state. Disabled plugins stay dark.
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
	// A guest that declares no linear memory has no usable JSON ABI; check with
	// the other ABI preconditions before any guest call.
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

	// Enforce the plugin's CPU budget (see guestBudget). Every guest call runs
	// under this deadline instead of the long-lived WebSocket context. The
	// runtime was created WithCloseOnContextDone(true), so an expired deadline
	// closes the module and interrupts a runaway guest (`for {}`): Call returns
	// an error, and releaseClosedModule marks the instance for lazy
	// re-instantiation on the next dispatch.
	//
	// The budget is wall-clock over guest execution. No host imports are wired
	// into the runtime yet; when host functions (host_http, host_storage, ...)
	// land, their time must be excluded, or the floor would kill any command
	// making a host HTTP call (httpTimeout is 10s against a 100ms floor).
	budget := r.guestBudget(inst)
	callCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

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

	if deallocFn != nil {
		_, _ = deallocFn.Call(callCtx, ptr, size)
	}

	if callErr != nil {
		// A failed guest call may have closed the module (deadline, trap,
		// parent-context cancellation); release it so the next dispatch
		// re-instantiates instead of dispatching into a dead module forever.
		r.releaseClosedModule(inst, mod)
		// Surface a CPU-budget overrun as a clean error, not the raw "module
		// closed with context deadline exceeded".
		if callCtx.Err() == context.DeadlineExceeded {
			return &CommandResult{Reply: fmt.Sprintf("plugin %s: command exceeded CPU budget of %dms", inst.Manifest.Name, budget.Milliseconds())}, true
		}
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: dispatch: %v", inst.Manifest.Name, callErr)}, true
	}
	if len(results) < 2 {
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: command_dispatch returned %d values, want 2", inst.Manifest.Name, len(results))}, true
	}

	resPtr, resLen := uint32(results[0]), uint32(results[1])
	// The guest picks resLen, up to its whole linear memory. Refuse before
	// reading: past here the bytes are copied out, marshalled into a frame and
	// queued on the invoker's socket, none with a size policy.
	if resLen > maxGuestResultBytes {
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: reply of %d bytes exceeds the %d-byte limit", inst.Manifest.Name, resLen, maxGuestResultBytes)}, true
	}
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

// maxGuestResultBytes caps a result region a guest hands back by (ptr, len): a
// command reply or the list_commands name list.
const maxGuestResultBytes = 64 << 10

// guestBudget is the wall-clock deadline for one guest call. The operator's
// plugins.cpu_budget_ms is the ceiling (100ms when unset, so zero or negative
// never means "no limit"); a manifest may ask for less, never more, since the
// manifest is the untrusted side's input.
func (r *Registry) guestBudget(inst *Instance) time.Duration {
	budgetMs := r.cfg.CPUBudgetMs
	if budgetMs <= 0 {
		budgetMs = 100
	}
	if m := inst.Manifest.Resources.CPUBudgetMs; m > 0 && m < budgetMs {
		budgetMs = m
	}
	return time.Duration(budgetMs) * time.Millisecond
}

// releaseClosedModule drops inst.module when the wazero runtime closed it out
// from under us (CPU-budget deadline, guest trap, parent-context cancellation),
// so the next dispatch re-instantiates instead of erroring forever. The pointer
// guard keeps a concurrent re-activation's fresh module intact. inst.compiled
// is kept: closing an instance does not invalidate its CompiledModule, and
// platformDeactivate frees it on disable, upgrade and Close.
func (r *Registry) releaseClosedModule(inst *Instance, mod api.Module) {
	if !mod.IsClosed() {
		return
	}
	r.mu.Lock()
	if inst.module == mod {
		inst.module = nil
	}
	r.mu.Unlock()
}

// listExportedCommands calls the plugin's optional `list_commands` export,
// which returns (ptr u32, len u32) pointing to a JSON array of command names.
// If the export is absent, the module declares no memory, or the result is
// invalid JSON, it returns an empty slice and no bindings are created. A failed
// call (trap, budget overrun) is an error.
func listExportedCommands(ctx context.Context, mod api.Module) ([]string, error) {
	fn := mod.ExportedFunction("list_commands")
	if fn == nil {
		return nil, nil
	}
	results, err := fn.Call(ctx)
	if err != nil {
		return nil, err
	}
	if len(results) < 2 {
		return nil, nil
	}
	// A guest with no memory section has nothing to read the names from, and its
	// api.Memory must not be touched (see guestMemory).
	mem := guestMemory(mod)
	if mem == nil {
		return nil, nil
	}
	ptr, length := uint32(results[0]), uint32(results[1])
	if length > maxGuestResultBytes {
		return nil, nil
	}
	raw, ok := mem.Read(ptr, length)
	if !ok {
		return nil, nil
	}
	var cmds []string
	if err := json.Unmarshal(raw, &cmds); err != nil {
		return nil, nil
	}
	return cmds, nil
}
