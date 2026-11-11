// Plugin registry and lifecycle. The default build's runtime is a stub: manifests
// are persisted for admins to see, but .wasm files are not executed.

package plugin

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Config is the runtime configuration sourced from PluginsConfig.
type Config struct {
	Directory     string
	MaxMemoryMB   int
	CPUBudgetMs   int
	HTTPAllowlist []string
	Store         PluginStore
}

// Registry is the central plugin coordinator.
type Registry struct {
	cfg Config

	mu       sync.RWMutex
	plugins  map[int64]*Instance  // by plugin row id
	byName   map[string]*Instance // by manifest name
	commands map[string]*Instance // command name → owning plugin
	uiTabs   []UITabBinding       // declared by `ui` capability plugins

	sink *EventSink

	// runtimePlatform is the wazero runtime (nil in the default build); set with platformClose.
	runtimePlatform any
	platformClose   func(context.Context) error
}

// Instance is a single loaded plugin.
type Instance struct {
	ID       int64
	Manifest *Manifest
	Dir      string // on-disk plugin directory, from foundPlugin.Dir; not derived from Manifest.Name
	WASMPath string
	Enabled  bool

	// invokeMu serializes guest calls: Function.Call is not goroutine-safe.
	invokeMu sync.Mutex //nolint:unused // used only by the wazero-tagged build

	// module is the wazero module (wazero build only).
	module any //nolint:unused // assigned by wazero-tagged build

	// compiled is the CompiledModule behind module, retained so a closed module
	// re-instantiates without recompiling; non-nil while module may be nil.
	compiled any //nolint:unused // assigned by wazero-tagged build
}

// UITabBinding is the public projection of a declared UI tab, served to the client bridge.
type UITabBinding struct {
	PluginID   int64
	PluginName string
	Tab        UITab
}

// NewRegistry constructs a registry; the wazero build also starts a runtime.
func NewRegistry(cfg Config) (*Registry, error) {
	if cfg.Store == nil {
		return nil, fmt.Errorf("plugin: NewRegistry requires a non-nil PluginStore")
	}
	r := &Registry{
		cfg:      cfg,
		plugins:  make(map[int64]*Instance),
		byName:   make(map[string]*Instance),
		commands: make(map[string]*Instance),
		sink:     NewEventSink(),
	}
	platform, closeFn, err := platformInit(cfg)
	if err != nil {
		return nil, fmt.Errorf("plugin: platform init: %w", err)
	}
	r.runtimePlatform = platform
	r.platformClose = closeFn
	return r, nil
}

// Close tears down the runtime and frees module memory.
func (r *Registry) Close(ctx context.Context) error {
	r.mu.Lock()
	for _, inst := range r.plugins {
		r.platformDeactivate(ctx, inst)
	}
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
	closeFn := r.platformClose
	r.platformClose = nil
	r.runtimePlatform = nil
	r.mu.Unlock()
	if closeFn != nil {
		return closeFn(ctx)
	}
	return nil
}

// Sink returns the registry's EventSink.
func (r *Registry) Sink() *EventSink {
	return r.sink
}

// LoadAll persists every manifest found under cfg.Directory into the
// PluginStore, then activates the enabled ones.
func (r *Registry) LoadAll(ctx context.Context) error {
	if r == nil {
		return nil
	}
	// Remove staging directories a crash left during InstallFromZip.
	if entries, rdErr := os.ReadDir(r.cfg.Directory); rdErr == nil {
		for _, e := range entries {
			if e.IsDir() && strings.HasPrefix(e.Name(), ".install-") {
				staleDir := filepath.Join(r.cfg.Directory, e.Name())
				if rmErr := os.RemoveAll(staleDir); rmErr != nil {
					slog.Warn("plugin: failed to remove stale staging dir", "dir", staleDir, "err", rmErr)
				}
			}
		}
	}
	// A malformed directory must not take down the valid plugins: log and continue.
	manifests, err := scanPluginDirectory(r.cfg.Directory)
	if err != nil {
		slog.Warn("plugin: some plugin directories failed to scan and were skipped", "dir", r.cfg.Directory, "err", err)
	}
	for _, found := range manifests {
		if err := r.installFromDisk(ctx, found); err != nil {
			slog.Warn("plugin: failed to install from disk", "name", found.Manifest.Name, "err", err)
			continue
		}
	}
	return r.activateAll(ctx)
}

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
	// Re-install: drop the old instance's command bindings. They are keyed to the
	// old *Instance and would block the fresh one from re-registering and keep
	// dispatch routing into the orphaned module.
	if old := r.byName[found.Manifest.Name]; old != nil {
		r.platformDeactivate(ctx, old)
		for cmd, owner := range r.commands {
			if owner == old {
				delete(r.commands, cmd)
			}
		}
		if old.ID != id {
			delete(r.plugins, old.ID)
		}
	}
	inst := &Instance{
		ID:       id,
		Manifest: found.Manifest,
		Dir:      found.Dir,
		WASMPath: found.WASMPath,
		Enabled:  false,
	}
	r.plugins[id] = inst
	r.byName[found.Manifest.Name] = inst
	return nil
}

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
			continue
		}
		r.mu.Lock()
		inst.Enabled = true
		r.mu.Unlock()
	}
	return nil
}

// activate compiles and starts one plugin module (ErrRuntimeUnavailable in the default build). The
// runtimePlatform snapshot is taken under r.mu so a concurrent Close cannot nil it mid-call.
func (r *Registry) activate(ctx context.Context, inst *Instance) error {
	r.mu.RLock()
	platform := r.runtimePlatform
	r.mu.RUnlock()
	if platform == nil {
		return ErrRuntimeUnavailable
	}
	return r.activateWithRuntime(ctx, platform, inst)
}

// enablePluginActivate is a variable so tests can simulate a concurrent
// disable/uninstall inside activate's unlocked compile window.
var enablePluginActivate = (*Registry).activate

// EnablePlugin marks a plugin enabled in the store, then attempts to load it.
func (r *Registry) EnablePlugin(ctx context.Context, id int64) error {
	if err := r.cfg.Store.EnablePlugin(ctx, id); err != nil {
		return err
	}
	r.mu.RLock()
	inst, ok := r.plugins[id]
	r.mu.RUnlock()
	if !ok {
		// No in-memory instance: roll the DB flag back.
		_ = r.cfg.Store.DisablePlugin(ctx, id)
		return ErrPluginNotFound
	}
	r.mu.Lock()
	inst.Enabled = true
	r.mu.Unlock()
	if err := enablePluginActivate(r, ctx, inst); err != nil {
		// Roll back both flags. WithoutCancel: the failure may be the request's own
		// expired deadline, and the flag must still be cleared.
		_ = r.cfg.Store.DisablePlugin(context.WithoutCancel(ctx), id)
		r.mu.Lock()
		inst.Enabled = false
		r.teardownLocked(ctx, inst)
		r.mu.Unlock()
		return err
	}
	// activate releases r.mu while compiling, so a concurrent Disable/Uninstall may
	// have finished inside it. Redo the teardown so a disabled plugin never keeps live commands.
	r.mu.Lock()
	if !inst.Enabled {
		r.teardownLocked(ctx, inst)
	}
	r.mu.Unlock()
	return nil
}

// teardownLocked drops inst's command bindings and frees its module; safe on a never-activated instance.
// Caller holds r.mu.
func (r *Registry) teardownLocked(ctx context.Context, inst *Instance) {
	for cmd, owner := range r.commands {
		if owner == inst {
			delete(r.commands, cmd)
		}
	}
	r.platformDeactivate(ctx, inst)
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
		r.teardownLocked(ctx, inst)
	}
	return nil
}

// removeAll lets tests force a removal failure (Windows deletes read-only files silently).
var removeAll = os.RemoveAll

// UninstallPlugin removes a plugin entirely.
func (r *Registry) UninstallPlugin(ctx context.Context, id int64) error {
	if err := r.DisablePlugin(ctx, id); err != nil {
		slog.Warn("plugin: disable failed during uninstall", "id", id, "err", err)
	}

	r.mu.RLock()
	inst, instOK := r.plugins[id]
	var pluginDir string
	if instOK {
		pluginDir = inst.Dir
	}
	r.mu.RUnlock()

	if err := r.cfg.Store.UninstallPlugin(ctx, id); err != nil {
		return err
	}

	r.mu.Lock()
	if inst, ok := r.plugins[id]; ok {
		delete(r.byName, inst.Manifest.Name)
	}
	delete(r.plugins, id)
	r.mu.Unlock()

	// Remove on-disk files so a restart does not resurrect the plugin; a failure is
	// reported because the directory then needs cleaning by hand.
	if pluginDir != "" {
		if err := removeAll(pluginDir); err != nil {
			slog.Warn("plugin: failed to remove plugin directory after uninstall", "dir", pluginDir, "err", err)
			return fmt.Errorf("remove plugin dir: %w", err)
		}
	}
	return nil
}

// List returns a snapshot of the registered plugins.
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
