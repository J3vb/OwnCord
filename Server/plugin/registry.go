// Plugin registry, lifecycle, and host-API plumbing.
//
// The Registry is the long-lived handle the rest of the server holds onto. It
// owns the Wazero runtime (in the wazero-tagged build), the loaded plugin
// instances, and the dispatch tables for host-API capabilities (commands,
// events, storage, http, ui).
//
// In the default build the runtime is a stub: LoadAll persists each manifest
// into the PluginStore so admins can see what is "installed", but the .wasm
// files are not executed and Dispatch() returns ErrRuntimeUnavailable.

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

	// sink is the hub→plugin event fan-out: plugins subscribe to topics and the
	// WS hub calls sink.Dispatch on each broadcast.
	sink *EventSink

	// runtimePlatform is set by platformInit to a concrete *wazero.Runtime in
	// the wazero-tagged build; the default build leaves it nil (manifest-only).
	// platformClose tears it down; both are set by platformInit atomically.
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

	// invokeMu serializes guest calls for this instance: wazero's Function.Call
	// is not goroutine-safe, and concurrent invocations race the module's shared
	// linear-memory buffer. Held by the wazero-tagged invokeCommand around the
	// whole allocate/write/dispatch/read sequence.
	invokeMu sync.Mutex //nolint:unused // used only by the wazero-tagged build

	// module is the wazero compiled module in the wazero-tagged build, nil in
	// the default build.
	module any //nolint:unused // assigned by wazero-tagged build

	// compiled is the wazero CompiledModule behind module, retained so teardown
	// can close it and so a module closed by a CPU-budget overrun or a trap
	// re-instantiates from it instead of recompiling; it can be non-nil while
	// module is nil.
	compiled any //nolint:unused // assigned by wazero-tagged build
}

// UITabBinding is the public projection of a plugin's declared UI tab,
// served to the client bridge so it can render iframe tabs.
type UITabBinding struct {
	PluginID   int64
	PluginName string
	Tab        UITab
}

// NewRegistry constructs a registry; in the default build a thin holder, with
// the wazero-tagged build standing up a real Wazero runtime.
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
	// platformInit (sandbox_default.go no-op or sandbox_wazero.go) owns the
	// runtimePlatform + platformClose pair on the Registry.
	platform, closeFn, err := platformInit(cfg)
	if err != nil {
		return nil, fmt.Errorf("plugin: platform init: %w", err)
	}
	r.runtimePlatform = platform
	r.platformClose = closeFn
	return r, nil
}

// Close shuts the registry down, tearing down the runtime and freeing module
// memory in the wazero-tagged build.
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

// Sink returns the registry's EventSink, used by the WS hub to fan out
// broadcasts to subscribed plugins and by the wazero build to deliver plugin
// output back to WS clients.
func (r *Registry) Sink() *EventSink {
	return r.sink
}

// LoadAll scans cfg.Directory and persists every plugin manifest found
// (plugin.json, via loadManifestFromDir) into the PluginStore. The
// wazero-tagged build then compiles each entrypoint into a runnable module.
func (r *Registry) LoadAll(ctx context.Context) error {
	if r == nil {
		return nil
	}
	// Remove staging directories a crash left during InstallFromZip
	// (".install-XXXXXX"); a successful install always renames them away.
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
	// scanPluginDirectory reports an error when any plugin subdirectory failed
	// to parse but still returns every plugin that scanned cleanly. Log and
	// continue: one malformed directory must not take down the valid plugins.
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
	// Re-install: tear down the old instance and drop its command bindings.
	// They are keyed to the old *Instance, so leaving them blocked the fresh
	// instance from re-registering its commands and kept dispatch routing into
	// the orphaned module until restart.
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

// activateAll compiles and registers host-API hooks for every plugin row in
// the PluginStore marked enabled; a no-op in the default build.
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
		// Sync the in-memory enabled flag with the DB row so callers reading
		// inst.Enabled (admin listings, host-side capability checks) see it.
		r.mu.Lock()
		inst.Enabled = true
		r.mu.Unlock()
	}
	return nil
}

// activate compiles and starts a single plugin module. The default build
// returns ErrRuntimeUnavailable; the wazero-tagged build replaces it via
// activateWithRuntime.
//
// The runtimePlatform read is guarded by r.mu so a concurrent Close() that
// nils it cannot be observed mid-activation, and the captured snapshot is
// passed into activateWithRuntime rather than re-read, closing the race between
// the nil check and the wazero call.
func (r *Registry) activate(ctx context.Context, inst *Instance) error {
	r.mu.RLock()
	platform := r.runtimePlatform
	r.mu.RUnlock()
	if platform == nil {
		return ErrRuntimeUnavailable
	}
	return r.activateWithRuntime(ctx, platform, inst)
}

// enablePluginActivate is EnablePlugin's activation call, a package variable so
// tests can simulate a concurrent DisablePlugin/UninstallPlugin winning the race
// inside activate's unlocked compile window without a real wazero runtime.
// Production never reassigns it.
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
		// No in-memory instance: roll the DB flag back so it doesn't stay at
		// enabled=1 with nothing backing it.
		_ = r.cfg.Store.DisablePlugin(ctx, id)
		return ErrPluginNotFound
	}
	r.mu.Lock()
	inst.Enabled = true
	r.mu.Unlock()
	if err := enablePluginActivate(r, ctx, inst); err != nil {
		// Roll back the DB flag and the in-memory flag so the next start is
		// consistent. WithoutCancel: the failure may be the request's own
		// expired deadline, and the flag must still be cleared.
		_ = r.cfg.Store.DisablePlugin(context.WithoutCancel(ctx), id)
		r.mu.Lock()
		inst.Enabled = false
		// Drop bindings and free any compile activation retained.
		r.teardownLocked(ctx, inst)
		r.mu.Unlock()
		return err
	}
	// activate releases r.mu for its whole CPU-bound compile+instantiate
	// window, so a concurrent DisablePlugin or UninstallPlugin may have run to
	// completion inside it, finding inst.Enabled true but nothing to tear down.
	// activate then installs a live module and commands. Detect that lost race
	// here, where both paths funnel, and redo DisablePlugin's teardown so a
	// plugin the store says is disabled never keeps live command bindings.
	r.mu.Lock()
	if !inst.Enabled {
		r.teardownLocked(ctx, inst)
	}
	r.mu.Unlock()
	return nil
}

// teardownLocked drops inst's command bindings and frees its compiled module
// (wazero build; safe on a never-activated instance). Caller holds r.mu.
func (r *Registry) teardownLocked(ctx context.Context, inst *Instance) {
	for cmd, owner := range r.commands {
		if owner == inst {
			delete(r.commands, cmd)
		}
	}
	r.platformDeactivate(ctx, inst)
}

// DisablePlugin marks a plugin disabled and tears its module down, so
// re-enabling recompiles from disk.
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

// removeAll is os.RemoveAll indirected so tests can force a directory-removal
// failure: Windows silently succeeds at deleting read-only files, so this seam
// pins UninstallPlugin's error-return path.
var removeAll = os.RemoveAll

// UninstallPlugin removes a plugin entirely.
func (r *Registry) UninstallPlugin(ctx context.Context, id int64) error {
	if err := r.DisablePlugin(ctx, id); err != nil {
		slog.Warn("plugin: disable failed during uninstall", "id", id, "err", err)
	}

	// Capture the plugin's on-disk directory before removing the in-memory
	// record, to clean it up after the DB row is gone.
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

	// Remove on-disk files so scanPluginDirectory does not resurrect the
	// plugin. The DB row and record are already gone, so a removal failure is
	// reported: the directory must be cleaned by hand before the next restart.
	if pluginDir != "" {
		if err := removeAll(pluginDir); err != nil {
			slog.Warn("plugin: failed to remove plugin directory after uninstall", "dir", pluginDir, "err", err)
			return fmt.Errorf("remove plugin dir: %w", err)
		}
	}
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
