// Phase C Step 9 — Plugin registry, lifecycle, and host-API plumbing.
//
// The Registry is the long-lived handle the rest of the server holds onto. It
// owns the Wazero runtime (in the wazero-tagged build), the loaded plugin
// instances, and the dispatch tables for host-API capabilities (commands,
// events, storage, http, ui).
//
// In the default build the runtime is a stub: LoadAll walks the plugins
// directory and persists each manifest into the PluginStore so admins can see
// what is "installed", but the .wasm files are NOT executed. Calling
// Dispatch() in the default build returns ErrRuntimeUnavailable.
package plugin

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"github.com/owncord/server/store"
)

// Config is the runtime configuration sourced from PluginsConfig.
type Config struct {
	Directory     string
	MaxMemoryMB   int
	CPUBudgetMs   int
	HTTPAllowlist []string
	Store         store.PluginStore
}

// Registry is the central plugin coordinator.
type Registry struct {
	cfg Config

	mu       sync.RWMutex
	plugins  map[int64]*Instance     // by plugin row id
	byName   map[string]*Instance    // by manifest name
	commands map[string]*Instance    // command name → owning plugin
	uiTabs   []UITabBinding          // declared by `ui` capability plugins

	// runtimePlatform is set by the wazero-tagged build's NewRegistry to a
	// concrete *wazero.Runtime. The default build leaves it nil and falls
	// back to manifest-only behaviour.
	runtimePlatform any
}

// Instance is a single loaded plugin.
type Instance struct {
	ID       int64
	Manifest *Manifest
	WASMPath string
	Enabled  bool

	// module is the wazero compiled module in the wazero-tagged build, or
	// nil in the default build.
	module any
}

// UITabBinding is the public projection of a plugin's declared UI tab,
// served to the client bridge so it can render iframe tabs.
type UITabBinding struct {
	PluginID   int64
	PluginName string
	Tab        UITab
}

// NewRegistry constructs a registry. In the default build it is a thin
// holder; the wazero-tagged build replaces this constructor with one that
// stands up a real Wazero runtime.
func NewRegistry(cfg Config) (*Registry, error) {
	if cfg.Store == nil {
		return nil, fmt.Errorf("plugin: NewRegistry requires a non-nil PluginStore")
	}
	return &Registry{
		cfg:      cfg,
		plugins:  make(map[int64]*Instance),
		byName:   make(map[string]*Instance),
		commands: make(map[string]*Instance),
	}, nil
}

// Close shuts the registry down. In the wazero-tagged build it tears the
// runtime down and frees module memory.
func (r *Registry) Close(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id := range r.plugins {
		delete(r.plugins, id)
	}
	for n := range r.byName {
		delete(r.byName, n)
	}
	for c := range r.commands {
		delete(r.commands, c)
	}
	r.uiTabs = nil
	return nil
}

// LoadAll scans cfg.Directory and persists every plugin.json found into the
// PluginStore. In the wazero-tagged build it then compiles each entrypoint
// into a runnable module; the default build stops at the persistence step.
func (r *Registry) LoadAll(ctx context.Context) error {
	if r == nil {
		return nil
	}
	manifests, err := scanPluginDirectory(r.cfg.Directory)
	if err != nil {
		return fmt.Errorf("plugin: scan %q: %w", r.cfg.Directory, err)
	}
	for _, found := range manifests {
		if err := r.installFromDisk(ctx, found); err != nil {
			slog.Warn("plugin: failed to install from disk", "name", found.Manifest.Name, "err", err)
			continue
		}
	}
	return r.activateAll(ctx)
}

// installFromDisk persists a manifest discovered on disk into the PluginStore
// and registers it in the in-memory registry.
func (r *Registry) installFromDisk(ctx context.Context, found foundPlugin) error {
	manifestJSON, err := found.Manifest.serialize()
	if err != nil {
		return err
	}
	id, err := r.cfg.Store.InstallPlugin(ctx, found.Manifest.Name, found.Manifest.Version, manifestJSON)
	if err != nil {
		return fmt.Errorf("InstallPlugin: %w", err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	inst := &Instance{
		ID:       id,
		Manifest: found.Manifest,
		WASMPath: found.WASMPath,
		Enabled:  false,
	}
	r.plugins[id] = inst
	r.byName[found.Manifest.Name] = inst
	return nil
}

// activateAll attempts to compile + register host-API hooks for every plugin
// row in the PluginStore that is marked enabled. The default build is a
// no-op (no Wazero modules to compile).
func (r *Registry) activateAll(ctx context.Context) error {
	rows, err := r.cfg.Store.ListPlugins(ctx)
	if err != nil {
		return fmt.Errorf("ListPlugins: %w", err)
	}
	for _, row := range rows {
		if !row.Enabled {
			continue
		}
		r.mu.Lock()
		inst, ok := r.byName[row.Name]
		r.mu.Unlock()
		if !ok {
			slog.Warn("plugin: enabled row has no on-disk manifest, skipping", "name", row.Name)
			continue
		}
		if err := r.activate(ctx, inst); err != nil {
			slog.Warn("plugin: activation failed", "name", row.Name, "err", err)
		}
	}
	return nil
}

// activate compiles and starts a single plugin module. Default build returns
// ErrRuntimeUnavailable; the wazero-tagged build replaces this with the real
// implementation via the runtimePlatform field.
func (r *Registry) activate(ctx context.Context, inst *Instance) error {
	if r.runtimePlatform == nil {
		return ErrRuntimeUnavailable
	}
	return r.activateWithRuntime(ctx, inst)
}

// EnablePlugin marks a plugin enabled in the store, then attempts to load it.
func (r *Registry) EnablePlugin(ctx context.Context, id int64) error {
	if err := r.cfg.Store.EnablePlugin(ctx, id); err != nil {
		return err
	}
	r.mu.RLock()
	inst, ok := r.plugins[id]
	r.mu.RUnlock()
	if !ok {
		return ErrPluginNotFound
	}
	inst.Enabled = true
	if err := r.activate(ctx, inst); err != nil {
		// Roll back the DB flag so the next start attempt is consistent.
		_ = r.cfg.Store.DisablePlugin(ctx, id)
		inst.Enabled = false
		return err
	}
	return nil
}

// DisablePlugin marks a plugin disabled and tears its module down.
func (r *Registry) DisablePlugin(ctx context.Context, id int64) error {
	if err := r.cfg.Store.DisablePlugin(ctx, id); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if inst, ok := r.plugins[id]; ok {
		inst.Enabled = false
		// Drop command bindings owned by this plugin.
		for cmd, owner := range r.commands {
			if owner == inst {
				delete(r.commands, cmd)
			}
		}
	}
	return nil
}

// UninstallPlugin removes a plugin entirely.
func (r *Registry) UninstallPlugin(ctx context.Context, id int64) error {
	_ = r.DisablePlugin(ctx, id)
	if err := r.cfg.Store.UninstallPlugin(ctx, id); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if inst, ok := r.plugins[id]; ok {
		delete(r.byName, inst.Manifest.Name)
	}
	delete(r.plugins, id)
	return nil
}

// List returns the currently registered plugins. Read-only snapshot.
func (r *Registry) List() []*Instance {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Instance, 0, len(r.plugins))
	for _, p := range r.plugins {
		out = append(out, p)
	}
	return out
}

// UITabBindings returns the declared UI tabs across enabled plugins.
func (r *Registry) UITabBindings() []UITabBinding {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]UITabBinding, len(r.uiTabs))
	copy(out, r.uiTabs)
	return out
}
