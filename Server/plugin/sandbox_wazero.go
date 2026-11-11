//go:build wazero

// Wazero-backed plugin runtime (`-tags wazero`). Guests speak a JSON ABI:
// allocate(size) → ptr, command_dispatch(ptr, len) → (ptr, len), deallocate(ptr, len).
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

const wazeroPageBytes = 65536

// guestMemory returns the module's linear memory, or nil if none was declared.
// A memoryless guest yields a non-nil api.Memory around a nil pointer that panics on use.
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

// platformInit stands up the shared wazero runtime with MaxMemoryMB as the page
// limit and WASI preview-1 pre-instantiated for TinyGo / Rust wasm32-wasi guests.
func platformInit(cfg Config) (any, func(context.Context) error, error) {
	ctx := context.Background()

	memMB := cfg.MaxMemoryMB
	if memMB <= 0 {
		memMB = 64 // default 64 MiB per plugin runtime
	}
	// Byte math in 64-bit (uint32 wraps at 4 GiB); clamp to wasm32's 65536 pages.
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

// activateWithRuntime compiles and instantiates inst under the shared runtime.
// It takes a runtime snapshot because Close can nil r.runtimePlatform concurrently.
func (r *Registry) activateWithRuntime(ctx context.Context, platform any, inst *Instance) error {
	rt, ok := platform.(wazero.Runtime)
	if !ok || rt == nil {
		return fmt.Errorf("plugin %q: wazero runtime unavailable", inst.Manifest.Name)
	}
	// Reuse the retained compile: a guest can force a re-activation per dispatch.
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

	// Guest output is discarded; _start is suppressed so exports run on demand.
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

	// Bind exports through RegisterCommand (outside r.mu, which it takes) for the
	// shared normalization and cross-plugin conflict check; it refuses names the
	// manifest did not declare, so a guest cannot widen its command surface.
	r.mu.Lock()
	if inst.module != nil {
		// Lost a concurrent activation race: keep the winner's module.
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
		// list_commands is guest code: run it under the CPU budget (inst.invokeMu is held here).
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

// listCommandsError reports a failed list_commands call; err is nil when the call returned but left the
// module closed.
func listCommandsError(plugin string, err error) error {
	if err == nil {
		return fmt.Errorf("plugin %q: list_commands left the module closed", plugin)
	}
	return fmt.Errorf("plugin %q: list_commands exceeded its CPU budget or trapped: %w", plugin, err)
}

// platformDeactivate closes inst's module, not the shared runtime; safe on a
// never-activated instance. Cancellation is detached so teardown completes.
func (r *Registry) platformDeactivate(ctx context.Context, inst *Instance) {
	// No early return on a nil module: a retained CompiledModule still needs freeing.
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

// invokeCommand calls the guest's `command_dispatch`. No export returns (nil, false)
// (dispatcher falls back to not-found); a missing allocate returns a diagnostic.
func (r *Registry) invokeCommand(ctx context.Context, inst *Instance, userID, channelID int64, cmd string, args []string) (*CommandResult, bool) {
	if inst == nil {
		return nil, false
	}
	// Function.Call is not goroutine-safe: concurrent calls tear the linear-memory
	// slice header. Lock per Instance, not r.mu, which would serialize all plugins.
	inst.invokeMu.Lock()
	defer inst.invokeMu.Unlock()

	r.mu.RLock()
	moduleAny := inst.module
	enabled := inst.Enabled
	r.mu.RUnlock()
	if moduleAny == nil {
		// An overrun or trap closed the module: re-instantiate lazily (resets guest state); disabled plugins stay
		// dark.
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

	// Every guest call runs under the plugin's CPU budget; the runtime's
	// WithCloseOnContextDone(true) makes an expired deadline interrupt a runaway
	// guest. When host functions land their time must be excluded from the budget.
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
		// A failed call may have closed the module; release it so the next dispatch re-instantiates.
		r.releaseClosedModule(inst, mod)
		// Report an overrun cleanly, not as "module closed with context deadline exceeded".
		if callCtx.Err() == context.DeadlineExceeded {
			return &CommandResult{Reply: fmt.Sprintf("plugin %s: command exceeded CPU budget of %dms", inst.Manifest.Name, budget.Milliseconds())}, true
		}
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: dispatch: %v", inst.Manifest.Name, callErr)}, true
	}
	if len(results) < 2 {
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: command_dispatch returned %d values, want 2", inst.Manifest.Name, len(results))}, true
	}

	resPtr, resLen := uint32(results[0]), uint32(results[1])
	// The guest picks resLen, up to its whole memory; refuse before the copy, frame and queue, which have no
	// size policy.
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
		return &CommandResult{Reply: string(resBytes)}, true
	}
	return &CommandResult{Reply: dr.Reply}, true
}

// maxGuestResultBytes caps a result region a guest hands back (a reply or the list_commands names).
const maxGuestResultBytes = 64 << 10

// guestBudget is the wall-clock deadline for one guest call: plugins.cpu_budget_ms
// (100ms when unset) as ceiling, which an untrusted manifest may lower, never raise.
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

// releaseClosedModule drops inst.module when the runtime closed it so the next
// dispatch re-instantiates. The pointer guard keeps a concurrent re-activation's
// module; inst.compiled is kept for platformDeactivate.
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

// listExportedCommands calls the optional `list_commands` export; missing
// export, no memory or bad JSON yields no bindings, a trap or overrun an error.
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
	// No memory section means nothing to read (see guestMemory).
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
