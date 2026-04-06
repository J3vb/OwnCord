//go:build wazero

// Real Wazero-backed plugin runtime. Compiled only with `-tags wazero`,
// matching the postgres / otel build-tag pattern used elsewhere in the repo.
//
// IMPORTANT: This file is a structural skeleton — it will fail to compile
// until github.com/tetratelabs/wazero is added to go.mod. To finish wiring it
// on a machine with network access:
//
//	cd Server
//	go get github.com/tetratelabs/wazero@latest
//	go mod tidy
//	go build -tags wazero ./...
//
// The skeleton documents the intended call graph so the implementation work
// is mechanical: each TODO marker maps to a wazero API call.
package plugin

import (
	"context"
	"fmt"
	"os"
)

// activateWithRuntime compiles inst.WASMPath into a wazero module, applies
// the per-plugin resource caps, and registers exported functions for each
// declared capability.
func (r *Registry) activateWithRuntime(ctx context.Context, inst *Instance) error {
	wasmBytes, err := os.ReadFile(inst.WASMPath)
	if err != nil {
		return fmt.Errorf("plugin %q: read wasm: %w", inst.Manifest.Name, err)
	}
	_ = wasmBytes
	_ = ctx

	// TODO(wazero): replace with the real wiring once go.mod has wazero:
	//
	//   runtime := r.runtimePlatform.(wazero.Runtime)
	//   compiled, err := runtime.CompileModule(ctx, wasmBytes)
	//   if err != nil { return fmt.Errorf("compile: %w", err) }
	//
	//   modCfg := wazero.NewModuleConfig().
	//       WithName(inst.Manifest.Name).
	//       WithStdout(io.Discard).
	//       WithStderr(io.Discard)
	//
	//   memBytes := uint32(inst.Manifest.Resources.MaxMemoryMB)
	//   if memBytes == 0 { memBytes = uint32(r.cfg.MaxMemoryMB) }
	//   // wazero pages are 64 KiB; the runtime config caps via WithMemoryLimitPages.
	//
	//   module, err := runtime.InstantiateModule(ctx, compiled, modCfg)
	//   if err != nil { return fmt.Errorf("instantiate: %w", err) }
	//
	//   inst.module = module
	//
	//   // Walk inst.Manifest.Permissions and call host_*.Register* for each
	//   // capability so the runtime knows what exports to look for.

	return fmt.Errorf("plugin %q: wazero runtime skeleton incomplete (see sandbox_wazero.go)", inst.Manifest.Name)
}

// invokeCommand calls the plugin's `command_dispatch` exported function with
// the marshalled command + args, and decodes the response into a CommandResult.
func (r *Registry) invokeCommand(ctx context.Context, inst *Instance, userID, channelID int64, cmd string, args []string) (*CommandResult, bool) {
	_ = ctx
	_ = inst
	_ = userID
	_ = channelID
	_ = cmd
	_ = args
	// TODO(wazero): real call:
	//   fn := module.ExportedFunction("command_dispatch")
	//   payload := encodeCommand(userID, channelID, cmd, args)
	//   result, err := fn.Call(ctx, ...)
	//   ...
	return &CommandResult{
		Reply: "plugin runtime: command dispatch not yet implemented in skeleton",
	}, true
}
