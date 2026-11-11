// `commands` host capability: slash commands registered at activation; the WS
// dispatcher calls Registry.DispatchCommand after its built-in table.

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

// RegisterCommand binds cmd to inst if its manifest declares it.
func (r *Registry) RegisterCommand(cmd string, inst *Instance) error {
	cmd = strings.ToLower(strings.TrimPrefix(cmd, "/"))
	if cmd == "" {
		return fmt.Errorf("plugin: cannot register empty command")
	}
	if !inst.Manifest.HasCapability(CapCommands) {
		return ErrCapabilityNotGranted
	}
	// The manifest is the authority on which commands a plugin may claim.
	if !inst.Manifest.DeclaresCommand(cmd) {
		return fmt.Errorf("%w: %s/%s", ErrCommandNotDeclared, inst.Manifest.Name, cmd)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// Ownership is by plugin name, not *Instance, so an upgrade can re-bind; a
	// different plugin claiming an owned command is refused.
	if existing, ok := r.commands[cmd]; ok && existing.Manifest.Name != inst.Manifest.Name {
		return fmt.Errorf("plugin: command %q already registered by %q", cmd, existing.Manifest.Name)
	}
	r.commands[cmd] = inst
	return nil
}

// DispatchCommand routes a slash command to its plugin. (nil, false) means no
// owner (not-found); (nil, true) means the runtime is unavailable.
func (r *Registry) DispatchCommand(ctx context.Context, userID int64, channelID int64, cmd string, args []string) (*CommandResult, bool) {
	if r == nil {
		return nil, false
	}
	cmd = strings.ToLower(strings.TrimPrefix(cmd, "/"))
	r.mu.RLock()
	inst, ok := r.commands[cmd]
	platform := r.runtimePlatform
	r.mu.RUnlock()
	if !ok {
		return nil, false
	}
	if platform == nil {
		return &CommandResult{
			Reply: fmt.Sprintf("plugin %q owns /%s but the wazero runtime is not built (run with -tags wazero)", inst.Manifest.Name, cmd),
		}, true
	}
	return r.invokeCommand(ctx, inst, userID, channelID, cmd, args)
}
