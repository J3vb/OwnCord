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
	"archive/zip"
	"context"
	"fmt"
	"io"
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

	// sink is the hub→plugin event fan-out. Plugins subscribe to topics via
	// Subscribe; the WS hub calls sink.Dispatch on each broadcast.
	sink *EventSink

	// runtimePlatform is populated by platformInit in the wazero-tagged build
	// with a concrete *wazero.Runtime. The default build leaves it nil and
	// falls back to manifest-only behaviour. platformClose tears the runtime
	// down; both fields are set by platformInit atomically.
	runtimePlatform any
	platformClose   func(context.Context) error
}

// Instance is a single loaded plugin.
type Instance struct {
	ID       int64
	Manifest *Manifest
	WASMPath string
	Enabled  bool

	// invokeMu serializes guest calls for this instance. wazero's Function.Call
	// is not goroutine-safe, and concurrent invocations race the module's shared
	// linear-memory buffer (F2). Held by the wazero-tagged invokeCommand around
	// the whole allocate/write/dispatch/read sequence.
	invokeMu sync.Mutex //nolint:unused // used only by the wazero-tagged build

	// module is the wazero compiled module in the wazero-tagged build, or
	// nil in the default build.
	module any //nolint:unused // assigned by wazero-tagged build
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
	r := &Registry{
		cfg:      cfg,
		plugins:  make(map[int64]*Instance),
		byName:   make(map[string]*Instance),
		commands: make(map[string]*Instance),
		sink:     NewEventSink(),
	}
	// platformInit is supplied by sandbox_default.go (no-op) or
	// sandbox_wazero.go (real Wazero runtime). Either way it owns the
	// runtimePlatform + platformClose pair on the Registry.
	platform, closeFn, err := platformInit(cfg)
	if err != nil {
		return nil, fmt.Errorf("plugin: platform init: %w", err)
	}
	r.runtimePlatform = platform
	r.platformClose = closeFn
	return r, nil
}

// Close shuts the registry down. In the wazero-tagged build it tears the
// runtime down and frees module memory.
func (r *Registry) Close(ctx context.Context) error {
	r.mu.Lock()
	for _, inst := range r.plugins {
		r.platformDeactivate(inst)
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
// broadcast events to subscribed plugins and by the wazero build to deliver
// plugin output back to WS clients.
func (r *Registry) Sink() *EventSink {
	return r.sink
}

// LoadAll scans cfg.Directory and persists every plugin.json found into the
// PluginStore. In the wazero-tagged build it then compiles each entrypoint
// into a runnable module; the default build stops at the persistence step.
func (r *Registry) LoadAll(ctx context.Context) error {
	if r == nil {
		return nil
	}
	// Clean up any staging directories left over from a previous crash
	// during InstallFromZip.  These are named ".install-XXXXXX" and are
	// safe to remove because a successful install always renames them away.
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
	// Re-install: tear down the old instance and drop its command bindings.
	// Bindings are keyed to the old *Instance, so leaving them in place both
	// blocked the fresh instance from re-registering its own commands and
	// kept dispatch routing into the orphaned old module until restart.
	if old := r.byName[found.Manifest.Name]; old != nil {
		r.platformDeactivate(old)
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
		WASMPath: found.WASMPath,
		Enabled:  false,
	}
	r.plugins[id] = inst
	r.byName[found.Manifest.Name] = inst
	return nil
}

// InstallFromZip extracts a plugin .zip uploaded via the admin API into a
// temp directory, validates it (zip-slip safe, no symlinks, size-capped),
// then renames it into the plugin directory and registers it via
// installFromDisk. Returns the new plugin name on success.
//
// The zip must contain a top-level plugin.json. The plugin's directory name
// is taken from manifest.Name (validated by Manifest.Validate to a strict
// charset). Re-installing an existing plugin replaces it.
const (
	maxZipBytes        = 16 * 1024 * 1024 // 16 MiB compressed
	maxUncompressedSum = 64 * 1024 * 1024 // 64 MiB total uncompressed
)

func (r *Registry) InstallFromZip(ctx context.Context, zipBytes []byte) (string, error) {
	if r == nil || r.cfg.Directory == "" {
		return "", fmt.Errorf("plugin runtime not configured")
	}
	if int64(len(zipBytes)) > maxZipBytes {
		return "", fmt.Errorf("plugin zip exceeds %d bytes", maxZipBytes)
	}
	zr, err := zip.NewReader(bytesReaderAt(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return "", fmt.Errorf("invalid zip: %w", err)
	}

	// Stage 1: extract into a temp dir under the plugin directory.
	if err := os.MkdirAll(r.cfg.Directory, 0o750); err != nil {
		return "", fmt.Errorf("create plugin dir: %w", err)
	}
	stage, err := os.MkdirTemp(r.cfg.Directory, ".install-")
	if err != nil {
		return "", fmt.Errorf("create staging dir: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(stage) }

	stageAbs, absErr := filepath.Abs(stage)
	if absErr != nil {
		cleanup()
		return "", fmt.Errorf("abs staging dir: %w", absErr)
	}

	var totalUncompressed int64
	for _, f := range zr.File {
		// Reject symlinks, devices, and any non-regular file mode.
		if !f.Mode().IsRegular() && !f.Mode().IsDir() {
			cleanup()
			return "", fmt.Errorf("plugin zip: refusing non-regular entry %q (mode=%v)", f.Name, f.Mode())
		}
		if f.Mode()&os.ModeSymlink != 0 {
			cleanup()
			return "", fmt.Errorf("plugin zip: refusing symlink %q", f.Name)
		}
		// Reject zip-slip: cleaned absolute path must stay rooted at the
		// staging directory.
		clean := filepath.Clean(f.Name)
		if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) || strings.Contains(clean, "..\\") {
			cleanup()
			return "", fmt.Errorf("plugin zip: refusing path-traversal entry %q", f.Name)
		}
		dest := filepath.Join(stageAbs, clean)
		destAbs, dErr := filepath.Abs(dest)
		if dErr != nil {
			cleanup()
			return "", dErr
		}
		rel, relErr := filepath.Rel(stageAbs, destAbs)
		if relErr != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			cleanup()
			return "", fmt.Errorf("plugin zip: refusing escape %q", f.Name)
		}

		if f.Mode().IsDir() {
			if err := os.MkdirAll(destAbs, 0o750); err != nil {
				cleanup()
				return "", err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destAbs), 0o750); err != nil {
			cleanup()
			return "", err
		}
		rc, oErr := f.Open()
		if oErr != nil {
			cleanup()
			return "", oErr
		}
		out, cErr := os.OpenFile(destAbs, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if cErr != nil {
			_ = rc.Close()
			cleanup()
			return "", cErr
		}
		// Cap each file at the remaining uncompressed budget so a zip bomb
		// can't OOM the host.
		remaining := maxUncompressedSum - totalUncompressed
		if remaining <= 0 {
			_ = rc.Close()
			_ = out.Close()
			cleanup()
			return "", fmt.Errorf("plugin zip: uncompressed total exceeds %d bytes", maxUncompressedSum)
		}
		n, copyErr := io.CopyN(out, rc, remaining+1)
		_ = rc.Close()
		_ = out.Close()
		if copyErr != nil && copyErr != io.EOF {
			cleanup()
			return "", copyErr
		}
		if n > remaining {
			cleanup()
			return "", fmt.Errorf("plugin zip: uncompressed total exceeds %d bytes", maxUncompressedSum)
		}
		totalUncompressed += n
	}

	// Stage 2: parse the manifest now that the staging dir is fully populated.
	manifestPath := filepath.Join(stageAbs, "plugin.json")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		cleanup()
		return "", fmt.Errorf("plugin zip: missing plugin.json at root: %w", err)
	}
	manifest, err := ParseManifest(raw)
	if err != nil {
		cleanup()
		return "", err
	}
	// Validate the staged contents the same way scanPluginDirectory does.
	if err := rejectSymlinksUnder(stageAbs); err != nil {
		cleanup()
		return "", err
	}
	wasmPath := filepath.Join(stageAbs, manifest.Entrypoint)
	if info, statErr := os.Lstat(wasmPath); statErr != nil {
		cleanup()
		return "", fmt.Errorf("entrypoint %s missing: %w", manifest.Entrypoint, statErr)
	} else if info.Mode()&os.ModeSymlink != 0 {
		cleanup()
		return "", fmt.Errorf("entrypoint %s is a symlink", manifest.Entrypoint)
	}

	// Stage 3: atomically rename into the canonical plugin name directory.
	finalDir := filepath.Join(r.cfg.Directory, manifest.Name)
	// If a previous version exists, remove it. The store row is replaced by
	// installFromDisk via the existing UPSERT path.
	if _, err := os.Stat(finalDir); err == nil {
		if err := os.RemoveAll(finalDir); err != nil {
			cleanup()
			return "", fmt.Errorf("remove existing plugin dir: %w", err)
		}
	}
	if err := os.Rename(stageAbs, finalDir); err != nil {
		cleanup()
		return "", fmt.Errorf("install rename: %w", err)
	}

	// Stage 4: register via the existing on-disk install path.
	if err := r.installFromDisk(ctx, foundPlugin{
		Manifest: manifest,
		Dir:      finalDir,
		WASMPath: filepath.Join(finalDir, manifest.Entrypoint),
	}); err != nil {
		return manifest.Name, fmt.Errorf("installFromDisk: %w", err)
	}
	return manifest.Name, nil
}

// bytesReaderAt is a tiny wrapper that satisfies io.ReaderAt for a byte
// slice. archive/zip needs ReaderAt; bytes.Reader provides it but importing
// "bytes" alongside the existing "io" surface keeps the import block tight.
type bytesReaderAt []byte

func (b bytesReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 || off >= int64(len(b)) {
		return 0, io.EOF
	}
	n := copy(p, b[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
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
			continue
		}
		// Sync the in-memory enabled flag with the DB row so callers that
		// read inst.Enabled (e.g. /api/v1/admin/plugins listings, future
		// host-side capability checks) see the activated state.
		r.mu.Lock()
		inst.Enabled = true
		r.mu.Unlock()
	}
	return nil
}

// activate compiles and starts a single plugin module. Default build returns
// ErrRuntimeUnavailable; the wazero-tagged build replaces this with the real
// implementation via activateWithRuntime.
//
// The runtimePlatform read is guarded by r.mu so a concurrent Close() that
// nil-s the field cannot be observed mid-activation. The captured platform
// value is then passed into activateWithRuntime as a parameter so the actual
// compile uses the snapshot rather than re-reading r.runtimePlatform — this
// closes the race window between the nil check and the wazero call.
func (r *Registry) activate(ctx context.Context, inst *Instance) error {
	r.mu.RLock()
	platform := r.runtimePlatform
	r.mu.RUnlock()
	if platform == nil {
		return ErrRuntimeUnavailable
	}
	return r.activateWithRuntime(ctx, platform, inst)
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
	r.mu.Lock()
	inst.Enabled = true
	r.mu.Unlock()
	if err := r.activate(ctx, inst); err != nil {
		// Roll back the DB flag and the in-memory flag so the next start
		// attempt is consistent.
		_ = r.cfg.Store.DisablePlugin(ctx, id)
		r.mu.Lock()
		inst.Enabled = false
		r.mu.Unlock()
		return err
	}
	return nil
}

// DisablePlugin marks a plugin disabled and tears its module down. The
// wazero-tagged build frees the compiled module via platformDeactivate so
// re-enabling recompiles from disk; the default build is a no-op.
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
		// Free the wazero module so memory is returned to the runtime
		// immediately rather than waiting for registry Close. Safe to call
		// on an instance that was never activated.
		r.platformDeactivate(inst)
	}
	return nil
}

// UninstallPlugin removes a plugin entirely.
func (r *Registry) UninstallPlugin(ctx context.Context, id int64) error {
	if err := r.DisablePlugin(ctx, id); err != nil {
		slog.Warn("plugin: disable failed during uninstall", "id", id, "err", err)
	}

	// Capture the plugin's on-disk directory before removing the in-memory
	// record so we can clean it up after the DB row is gone.
	r.mu.RLock()
	inst, instOK := r.plugins[id]
	var pluginDir string
	if instOK {
		pluginDir = filepath.Join(r.cfg.Directory, inst.Manifest.Name)
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

	// Remove on-disk files so the plugin isn't resurrected on the next
	// startup by scanPluginDirectory.
	if pluginDir != "" {
		if err := os.RemoveAll(pluginDir); err != nil {
			slog.Warn("plugin: failed to remove plugin directory after uninstall", "dir", pluginDir, "err", err)
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
