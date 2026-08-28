//go:build !wazero

// OC-0243: EnablePlugin sets inst.Enabled = true and releases r.mu *before*
// calling activate, which is CPU-bound (CompileModule/InstantiateModule under
// -tags wazero) and runs with r.mu unlocked for its whole duration. A
// concurrent DisablePlugin (or UninstallPlugin, which calls DisablePlugin
// first) can run to completion entirely inside that window: it finds
// inst.Enabled already true but nothing yet to tear down (module still nil,
// no command bindings registered yet), so its teardown is a no-op. When
// activate then finishes, it installs a live module and registers commands
// for a plugin the store and inst.Enabled both already say is disabled —
// DispatchCommand (host_commands.go) routes off r.commands alone and never
// consults inst.Enabled, so the "disabled" plugin keeps executing.
//
// This test reproduces the race deterministically — without a real wazero
// runtime or any timing dependency — via the enablePluginActivate seam: the
// fake activation function runs the concurrent DisablePlugin itself,
// synchronously, before "finishing" activation by registering the command,
// exactly reproducing the interleaving from the finding's repro.
package plugin

import (
	"context"
	"testing"
)

func TestRegistry_EnablePlugin_ConcurrentDisableDuringActivationWindow(t *testing.T) {
	r, _, dir := newRegistryWithDir(t)
	ctx := context.Background()

	manifestJSON := `{"name":"alpha","version":"1.0.0","entrypoint":"alpha.wasm","permissions":["commands"],"commands":[{"name":"greet"}]}`
	writePluginDir(t, dir, "alpha", manifestJSON)
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	inst := r.List()[0]

	orig := enablePluginActivate
	t.Cleanup(func() { enablePluginActivate = orig })
	// Fake "activate": mirrors what the real wazero-tagged activateWithRuntime
	// does (install a module stand-in, then register the plugin's declared
	// commands) but interleaves a full, synchronous DisablePlugin call in
	// between — exactly the interleaving the finding describes, made
	// deterministic instead of depending on real compile timing.
	enablePluginActivate = func(reg *Registry, actCtx context.Context, activatingInst *Instance) error {
		if err := reg.DisablePlugin(actCtx, activatingInst.ID); err != nil {
			t.Fatalf("simulated concurrent DisablePlugin: %v", err)
		}
		if err := reg.RegisterCommand("greet", activatingInst); err != nil {
			t.Fatalf("RegisterCommand: %v", err)
		}
		return nil
	}

	if err := r.EnablePlugin(ctx, inst.ID); err != nil {
		t.Fatalf("EnablePlugin: %v", err)
	}

	r.mu.RLock()
	_, bound := r.commands["greet"]
	enabled := inst.Enabled
	r.mu.RUnlock()

	if enabled {
		t.Error("inst.Enabled ended up true even though a concurrent DisablePlugin won the race during activation")
	}
	if bound {
		t.Error("command binding for \"greet\" survived a concurrent DisablePlugin that raced EnablePlugin's " +
			"activation window — DispatchCommand would still route into a plugin the admin just disabled")
	}
}
