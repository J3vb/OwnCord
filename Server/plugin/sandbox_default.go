//go:build !wazero

// Default plugin runtime: no Wazero. Plugin manifests are still discovered,
// persisted, and surfaced through the admin API, but `.wasm` modules are not
// executed. To enable real WASM execution build with `-tags wazero`.
package plugin

import (
	"context"
)

// activateWithRuntime is a no-op in the default build. It is only called from
// Registry.activate when runtimePlatform is non-nil, which never happens here.
func (r *Registry) activateWithRuntime(ctx context.Context, inst *Instance) error {
	return ErrRuntimeUnavailable
}

// invokeCommand returns an error result instructing the operator to enable
// the wazero build tag. Default build only.
func (r *Registry) invokeCommand(ctx context.Context, inst *Instance, userID, channelID int64, cmd string, args []string) (*CommandResult, bool) {
	return &CommandResult{
		Reply: "plugin runtime disabled — rebuild server with -tags wazero to execute plugin commands",
	}, true
}
