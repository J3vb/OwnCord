//go:build wazero

// Real Wazero-backed plugin runtime. Compiled only with `-tags wazero`.
// Provides concrete implementations of activateWithRuntime and invokeCommand
// that compile, instantiate, and dispatch to WASM modules via wazero v1.
package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// wazeroPageBytes is the size of a single WASM linear-memory page (64 KiB).
const wazeroPageBytes = 65536

// ensureRuntimeLocked initialises the shared wazero.Runtime on first call.
// The caller MUST hold r.mu.Lock().
func (r *Registry) ensureRuntimeLocked(ctx context.Context) (wazero.Runtime, error) {
	if r.runtimePlatform != nil {
		rt, ok := r.runtimePlatform.(wazero.Runtime)
		if !ok {
			return nil, fmt.Errorf("plugin: runtimePlatform is not a wazero.Runtime")
		}
		return rt, nil
	}

	// Convert the configured MB limit to WASM pages (64 KiB each).
	memMB := r.cfg.MaxMemoryMB
	if memMB <= 0 {
		memMB = 64 // default 64 MiB
	}
	memPages := uint32(memMB) * 1024 * 1024 / wazeroPageBytes

	rtCfg := wazero.NewRuntimeConfig().WithMemoryLimitPages(memPages)
	rt := wazero.NewRuntimeWithConfig(ctx, rtCfg)

	// Instantiate the WASI host module so plugins compiled with the WASI
	// target (TinyGo, wasm32-wasi, etc.) have their syscall shims available.
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("plugin: wasi instantiation: %w", err)
	}

	r.runtimePlatform = rt
	return rt, nil
}

// activateWithRuntime compiles inst.WASMPath into a wazero module, instantiates
// it, and wires up the command dispatch table for any commands the module exports.
func (r *Registry) activateWithRuntime(ctx context.Context, inst *Instance) error {
	wasmBytes, err := os.ReadFile(inst.WASMPath)
	if err != nil {
		return fmt.Errorf("plugin %q: read wasm: %w", inst.Manifest.Name, err)
	}

	// Ensure the shared runtime is ready (lazy init, holds lock only briefly).
	r.mu.Lock()
	rt, err := r.ensureRuntimeLocked(ctx)
	r.mu.Unlock()
	if err != nil {
		return err
	}

	// CompileModule is CPU-intensive but requires no lock.
	compiled, err := rt.CompileModule(ctx, wasmBytes)
	if err != nil {
		return fmt.Errorf("plugin %q: compile: %w", inst.Manifest.Name, err)
	}

	modCfg := wazero.NewModuleConfig().
		WithName(inst.Manifest.Name).
		WithStdin(strings.NewReader("")). // prevent plugins from reading server stdin
		WithStdout(io.Discard).
		WithStderr(io.Discard).
		WithStartFunctions() // suppress _start; exports are called on demand

	module, err := rt.InstantiateModule(ctx, compiled, modCfg)
	if err != nil {
		_ = compiled.Close(ctx)
		return fmt.Errorf("plugin %q: instantiate: %w", inst.Manifest.Name, err)
	}

	// Register the module and bind any commands it exports.
	r.mu.Lock()
	inst.module = module
	for _, perm := range inst.Manifest.Permissions {
		if Capability(perm) == CapCommands {
			for _, cmd := range listExportedCommands(ctx, module) {
				r.commands[cmd] = inst
			}
			break
		}
	}
	r.mu.Unlock()
	return nil
}

// invokeCommand calls the plugin's exported "command_dispatch" function using
// a simple linear-memory ABI:
//
//	allocate(size u32) → ptr u32
//	command_dispatch(ptr u32, len u32) → (result_ptr u32, result_len u32)
//	deallocate(ptr u32, len u32)
//
// Both the input and output are JSON payloads.
func (r *Registry) invokeCommand(ctx context.Context, inst *Instance, userID, channelID int64, cmd string, args []string) (*CommandResult, bool) {
	if inst.module == nil {
		return nil, false
	}
	mod, ok := inst.module.(api.Module)
	if !ok {
		return nil, false
	}

	dispatchFn := mod.ExportedFunction("command_dispatch")
	if dispatchFn == nil {
		return nil, false
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

// listExportedCommands calls the plugin's optional "list_commands" export which
// returns (ptr u32, len u32) pointing to a JSON array of command name strings.
// If the export is absent or returns invalid JSON, an empty slice is returned.
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
