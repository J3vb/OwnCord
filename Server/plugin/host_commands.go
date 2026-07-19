// Phase C Step 9 — `commands` host capability.
//
// Plugins that declare the "commands" capability register one or more slash
// commands at activation time. The WS command dispatcher (Server/ws/command.go)
// calls Registry.DispatchCommand after exhausting its built-in command table.

package plugin

import (
	"context"
	"fmt"
	"strings"
)

// CommandResult is what a plugin returns from a command invocation.
type CommandResult struct {
	// Reply is sent back to the invoking user as an ephemeral message.
	Reply string
	// Broadcast, when set, is also broadcast to the channel.
	Broadcast string
}

// RegisterCommand binds cmd to inst. Called from the activation path in the
// wazero-tagged build once the module exports its `register_commands` table.
// Default build can call it directly from tests.
func (r *Registry) RegisterCommand(cmd string, inst *Instance) error {
	cmd = strings.ToLower(strings.TrimPrefix(cmd, "/"))
	if cmd == "" {
		return fmt.Errorf("plugin: cannot register empty command")
	}
	if !inst.Manifest.HasCapability(CapCommands) {
		return ErrCapabilityNotGranted
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// Ownership is compared by plugin identity (manifest name — unique per
	// registry), not instance pointer: an in-place upgrade replaces the
	// *Instance, and the same plugin must be able to re-bind its own
	// commands. A *different* plugin claiming an owned command is still
	// refused (cross-plugin command-hijack protection).
	if existing, ok := r.commands[cmd]; ok && existing.Manifest.Name != inst.Manifest.Name {
		return fmt.Errorf("plugin: command %q already registered by %q", cmd, existing.Manifest.Name)
	}
	r.commands[cmd] = inst
	return nil
}

// DispatchCommand routes a slash command to the owning plugin. Returns
// (nil, false) when no plugin owns the command, letting the WS dispatcher
// fall back to the not-found response. Returns (nil, true) when the runtime
// is unavailable so the dispatcher can show a helpful error message.
func (r *Registry) DispatchCommand(ctx context.Context, userID int64, channelID int64, cmd string, args []string) (*CommandResult, bool) {
	if r == nil {
		return nil, false
	}
	cmd = strings.ToLower(strings.TrimPrefix(cmd, "/"))
	r.mu.RLock()
	inst, ok := r.commands[cmd]
	r.mu.RUnlock()
	if !ok {
		return nil, false
	}
	if r.runtimePlatform == nil {
		return &CommandResult{
			Reply: fmt.Sprintf("plugin %q owns /%s but the wazero runtime is not built (run with -tags wazero)", inst.Manifest.Name, cmd),
		}, true
	}
	return r.invokeCommand(ctx, inst, userID, channelID, cmd, args)
}
