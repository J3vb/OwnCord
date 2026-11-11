//go:build !wazero

// Default plugin runtime: no Wazero. Manifests are discovered and persisted,
// but `.wasm` modules do not execute.

package plugin

import (
	"context"
)

// platformInit is a no-op: runtimePlatform stays nil, so lifecycle methods
// fall through to ErrRuntimeUnavailable.
func platformInit(_ Config) (any, func(context.Context) error, error) {
	return nil, nil, nil
}

// activateWithRuntime is a no-op; activate calls it only with a non-nil runtimePlatform.
func (r *Registry) activateWithRuntime(_ context.Context, _ any, _ *Instance) error {
	return ErrRuntimeUnavailable
}

// platformDeactivate is called from Close on each plugin; a no-op here.
func (r *Registry) platformDeactivate(_ context.Context, _ *Instance) {}

// invokeCommand tells the operator to enable the wazero build tag.
func (r *Registry) invokeCommand(_ context.Context, _ *Instance, _, _ int64, _ string, _ []string) (*CommandResult, bool) {
	return &CommandResult{
		Reply: "plugin runtime disabled — rebuild server with -tags wazero to execute plugin commands",
	}, true
}
