//go:build !wazero

// Default plugin runtime: no Wazero. Plugin manifests are still discovered,
// persisted, and surfaced through the admin API, but `.wasm` modules are not
// executed. To enable real WASM execution build with `-tags wazero`.

package plugin

import (
	"context"
)

// platformInit is a no-op in the default build — there is no Wazero runtime
// to stand up, and NewRegistry leaves runtimePlatform nil so the lifecycle
// methods fall through to ErrRuntimeUnavailable.
func platformInit(_ Config) (any, func(context.Context) error, error) {
	return nil, nil, nil
}

// activateWithRuntime is a no-op in the default build. It is only called from
// Registry.activate when runtimePlatform is non-nil, which never happens here.
func (r *Registry) activateWithRuntime(_ context.Context, _ any, _ *Instance) error {
	return ErrRuntimeUnavailable
}

// platformDeactivate is called from Close on each plugin; a no-op here.
func (r *Registry) platformDeactivate(_ context.Context, _ *Instance) {}

// invokeCommand returns an error result instructing the operator to enable
// the wazero build tag. Default build only.
func (r *Registry) invokeCommand(_ context.Context, _ *Instance, _, _ int64, _ string, _ []string) (*CommandResult, bool) {
	return &CommandResult{
		Reply: "plugin runtime disabled — rebuild server with -tags wazero to execute plugin commands",
	}, true
}
