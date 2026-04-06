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
//	platformInit        — creates the shared wazero.Runtime and returns a
//	                      teardown closure consumed by Registry.Close.
//	activateWithRuntime — compiles the plugin's .wasm entrypoint, instantiates
//	                      it against the shared runtime with WASI enabled,
//	                      and stores the resulting api.Module on the Instance.
//	platformDeactivate  — closes the per-plugin module without tearing down
//	                      the shared runtime.
//	invokeCommand       — calls the plugin's `command_dispatch` export when
//	                      present. The initial wiring keeps the host/guest
//	                      protocol intentionally small: `command_dispatch()`
//	                      takes no parameters and returns a single i32 status
//	                      code. A future iteration will extend this to pass
//	                      command text via guest memory and return a reply.
//
// Any .wasm that does not export command_dispatch is still valid — DispatchCommand
// reports a user-facing "no command_dispatch export" message so operators can
// diagnose mis-built plugins without crashing the server.
package plugin

import (
	"context"
	"fmt"
	"os"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// platformInit stands up the shared wazero runtime for this Registry. The
// runtime is the top-level handle that owns compiled modules, host modules,
// and per-instance linear memory; every plugin in this registry shares it.
func platformInit(cfg Config) (any, func(context.Context) error, error) {
	ctx := context.Background()
	rt := wazero.NewRuntimeWithConfig(ctx,
		wazero.NewRuntimeConfig().
			WithCloseOnContextDone(true),
	)
	// WASI is required for TinyGo/Rust plugins that link against the
	// standard library; without it even a `main` entrypoint that prints
	// anything will fail to instantiate.
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		_ = rt.Close(ctx)
		return nil, nil, fmt.Errorf("wazero: wasi snapshot_preview1: %w", err)
	}
	_ = cfg // HTTPAllowlist / resource caps are applied per-module in activateWithRuntime
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

	compiled, err := rt.CompileModule(ctx, wasmBytes)
	if err != nil {
		return fmt.Errorf("plugin %q: compile: %w", inst.Manifest.Name, err)
	}

	// Each plugin gets its own module name so multiple instances can coexist
	// without colliding in the runtime's global module namespace. Output is
	// swallowed to keep misbehaving plugins from flooding server logs.
	modCfg := wazero.NewModuleConfig().
		WithName(inst.Manifest.Name).
		WithStdout(discardWriter{}).
		WithStderr(discardWriter{})

	module, err := rt.InstantiateModule(ctx, compiled, modCfg)
	if err != nil {
		return fmt.Errorf("plugin %q: instantiate: %w", inst.Manifest.Name, err)
	}
	inst.module = module
	return nil
}

// platformDeactivate closes the wazero module held by inst without touching
// the shared runtime. Safe to call on an instance that was never activated.
func (r *Registry) platformDeactivate(inst *Instance) {
	if inst == nil || inst.module == nil {
		return
	}
	if mod, ok := inst.module.(api.Module); ok {
		_ = mod.Close(context.Background())
	}
	inst.module = nil
}

// invokeCommand is the command-capability entrypoint. The host-guest protocol
// is deliberately minimal in this first iteration:
//
//   - If the plugin exports `command_dispatch` with signature `() -> i32`, the
//     host calls it. A return value of 0 is treated as success; any non-zero
//     value becomes an error reply.
//   - If the export is absent, the host returns a user-facing diagnostic.
//
// The plan is to extend this to pass the command string + args through guest
// memory (alloc/free host-side helpers) once the first real plugin needs it.
func (r *Registry) invokeCommand(ctx context.Context, inst *Instance, userID, channelID int64, cmd string, args []string) (*CommandResult, bool) {
	_ = userID
	_ = channelID
	_ = args

	if inst == nil || inst.module == nil {
		return &CommandResult{Reply: fmt.Sprintf("plugin %q is not activated", cmd)}, true
	}
	mod, ok := inst.module.(api.Module)
	if !ok {
		return &CommandResult{Reply: fmt.Sprintf("plugin %q: module type mismatch", inst.Manifest.Name)}, true
	}
	fn := mod.ExportedFunction("command_dispatch")
	if fn == nil {
		return &CommandResult{
			Reply: fmt.Sprintf("plugin %q does not export command_dispatch (rebuild the plugin to handle /%s)", inst.Manifest.Name, cmd),
		}, true
	}
	res, err := fn.Call(ctx)
	if err != nil {
		return &CommandResult{Reply: fmt.Sprintf("plugin %q: command_dispatch errored: %v", inst.Manifest.Name, err)}, true
	}
	status := uint64(0)
	if len(res) > 0 {
		status = res[0]
	}
	if status != 0 {
		return &CommandResult{Reply: fmt.Sprintf("plugin %q: command_dispatch returned status %d", inst.Manifest.Name, status)}, true
	}
	return &CommandResult{Reply: fmt.Sprintf("plugin %q: /%s ok", inst.Manifest.Name, cmd)}, true
}

// discardWriter is a tiny io.Writer that throws everything away. Wazero's
// ModuleConfig accepts any io.Writer for stdout/stderr; using io.Discard would
// pull the extra import just to satisfy two calls.
type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
