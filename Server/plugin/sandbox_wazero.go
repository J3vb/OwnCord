//go:build wazero

// Phase C Step 9 — Real Wazero-backed plugin runtime. Compiled only with
// `-tags wazero`; matches the postgres / otel build-tag pattern used
// elsewhere in the repo so the default sqlite-only build does not pull
// wazero into go.mod at runtime.
//
// Architecture
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
	"os"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// wazeroPageBytes is the size of a single WASM linear-memory page (64 KiB).
const wazeroPageBytes = 65536

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
	memPages := uint32(memMB) * 1024 * 1024 / wazeroPageBytes

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
		WithStdout(io.Discard).
		WithStderr(io.Discard).
		WithStartFunctions()

	module, err := rt.InstantiateModule(ctx, compiled, modCfg)
	if err != nil {
		_ = compiled.Close(ctx)
		return fmt.Errorf("plugin %q: instantiate: %w", inst.Manifest.Name, err)
	}

	// Register the module and auto-bind any commands the plugin exports
	// via list_commands. The plugin must also have declared the `commands`
	// capability in its manifest, otherwise no binding happens.
	r.mu.Lock()
	inst.module = module
	if inst.Manifest.HasCapability(CapCommands) {
		for _, cmd := range listExportedCommands(ctx, module) {
			r.commands[cmd] = inst
		}
	}
	r.mu.Unlock()
	return nil
}

// platformDeactivate closes the wazero module held by inst without touching
// the shared runtime. Safe to call on an instance that was never activated.
// Called from DisablePlugin and Close.
func (r *Registry) platformDeactivate(inst *Instance) {
	if inst == nil || inst.module == nil {
		return
	}
	if mod, ok := inst.module.(api.Module); ok {
		_ = mod.Close(context.Background())
	}
	inst.module = nil
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
	if inst == nil || inst.module == nil {
		return nil, false
	}
	mod, ok := inst.module.(api.Module)
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

	// Allocate guest memory for the input payload.
	size := uint64(len(payload))
	ptrs, callErr := allocFn.Call(ctx, size)
	if callErr != nil || len(ptrs) == 0 {
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: allocate(%d): %v", inst.Manifest.Name, size, callErr)}, true
	}
	ptr := ptrs[0]

	mem := mod.Memory()
	if !mem.Write(uint32(ptr), payload) {
		return &CommandResult{Reply: fmt.Sprintf("plugin %s: memory write at %d failed", inst.Manifest.Name, ptr)}, true
	}

	results, callErr := dispatchFn.Call(ctx, ptr, size)

	// Free the input buffer regardless of dispatch outcome.
	if deallocFn != nil {
		_, _ = deallocFn.Call(ctx, ptr, size)
	}

	if callErr != nil {
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

// listExportedCommands calls the plugin's optional `list_commands` export
// which returns (ptr u32, len u32) pointing to a JSON array of command name
// strings. If the export is absent or returns invalid JSON, an empty slice
// is returned and no command bindings are created.
func listExportedCommands(ctx context.Context, mod api.Module) []string {
	fn := mod.ExportedFunction("list_commands")
	if fn == nil {
		return nil
	}
	results, err := fn.Call(ctx)
	if err != nil || len(results) < 2 {
		return nil
	}
	ptr, length := uint32(results[0]), uint32(results[1])
	raw, ok := mod.Memory().Read(ptr, length)
	if !ok {
		return nil
	}
	var cmds []string
	if err := json.Unmarshal(raw, &cmds); err != nil {
		return nil
	}
	return cmds
}
