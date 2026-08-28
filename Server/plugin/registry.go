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
	"errors"
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
	Dir      string // on-disk plugin directory, from foundPlugin.Dir — NOT derived from Manifest.Name
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

	// compiled is the wazero CompiledModule behind module. Retained so
	// teardown can close it — the shared runtime otherwise keeps every
	// compile from every re-activation cycle until process exit.
	compiled any //nolint:unused // assigned by wazero-tagged build
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
	// scanPluginDirectory reports a non-nil error whenever at least one
	// plugin subdirectory failed to parse, but it still returns every
	// plugin that scanned cleanly in `manifests`. Log-and-continue here
	// rather than aborting: one malformed plugin directory must not take
	// every other, otherwise-valid plugin down with it (OC-0165).
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
	// Bindings are keyed to the old *Instance, so leaving them in place both
	// blocked the fresh instance from re-registering its own commands and
	// kept dispatch routing into the orphaned old module until restart.
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

	if err := installZipExtract(zr, stageAbs); err != nil {
		cleanup()
		return "", err
	}

	// Stage 2: parse the manifest now that the staging dir is fully populated.
	manifest, err := installZipStagedManifest(stageAbs)
	if err != nil {
		cleanup()
		return "", err
	}

	// Stage 3: atomically rename into the canonical plugin name directory.
	// A previous version, if any, is renamed aside rather than deleted so it
	// can be restored below if registration fails.
	finalDir := filepath.Join(r.cfg.Directory, manifest.Name)
	backupDir, err := installZipPromote(stageAbs, finalDir)
	if err != nil {
		cleanup()
		return "", err
	}

	// Stage 4: register via the existing on-disk install path.
	if err := r.installFromDisk(ctx, foundPlugin{
		Manifest: manifest,
		Dir:      finalDir,
		WASMPath: filepath.Join(finalDir, manifest.Entrypoint),
	}); err != nil {
		// The DB upsert (or the manifest serialize before it) failed after
		// the new version was already promoted into finalDir. Undo the
		// promote so a failed upgrade never destroys the previously-working
		// version: drop the half-registered new tree and put the backup
		// back, if we have one.
		if rmErr := os.RemoveAll(finalDir); rmErr != nil {
			slog.Warn("plugin: failed to remove half-installed upgrade after installFromDisk error",
				"name", manifest.Name, "dir", finalDir, "err", rmErr)
		}
		if backupDir != "" {
			if restoreErr := os.Rename(backupDir, finalDir); restoreErr != nil {
				slog.Warn("plugin: failed to restore previous plugin version after a failed upgrade",
					"name", manifest.Name, "dir", finalDir, "backup", backupDir, "err", restoreErr)
			}
		}
		return manifest.Name, fmt.Errorf("installFromDisk: %w", err)
	}
	if backupDir != "" {
		if err := os.RemoveAll(backupDir); err != nil {
			slog.Warn("plugin: failed to remove backed-up previous version after a successful upgrade",
				"name", manifest.Name, "backup", backupDir, "err", err)
		}
	}

	r.installZipReactivate(ctx, manifest.Name)
	return manifest.Name, nil
}

// installZipExtract writes every entry of zr into the already-created staging
// directory stageAbs, enforcing the zip-slip, symlink and uncompressed-size
// caps entry by entry before each write. The caller owns stageAbs and removes
// it on any error returned here.
func installZipExtract(zr *zip.Reader, stageAbs string) error {
	var totalUncompressed int64
	for _, f := range zr.File {
		destAbs, entryErr := installZipEntryDest(f, stageAbs)
		if entryErr != nil {
			return entryErr
		}

		if f.Mode().IsDir() {
			if err := os.MkdirAll(destAbs, 0o750); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destAbs), 0o750); err != nil {
			return err
		}
		// Cap each file at the remaining uncompressed budget so a zip bomb
		// can't OOM the host.
		remaining := maxUncompressedSum - totalUncompressed
		n, writeErr := installZipWriteEntry(f, destAbs, remaining)
		if writeErr != nil {
			return writeErr
		}
		totalUncompressed += n
	}
	return nil
}

// installZipEntryDest validates one zip entry's mode and name and returns the
// absolute path it may be written to under stageAbs. Every rejection here is a
// hard stop: non-regular modes, symlinks, and any name that escapes stageAbs.
func installZipEntryDest(f *zip.File, stageAbs string) (string, error) {
	// Reject symlinks, devices, and any non-regular file mode.
	if !f.Mode().IsRegular() && !f.Mode().IsDir() {
		return "", fmt.Errorf("plugin zip: refusing non-regular entry %q (mode=%v)", f.Name, f.Mode())
	}
	if f.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("plugin zip: refusing symlink %q", f.Name)
	}
	// Reject zip-slip: cleaned absolute path must stay rooted at the
	// staging directory.
	clean := filepath.Clean(f.Name)
	if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) || strings.Contains(clean, "..\\") {
		return "", fmt.Errorf("plugin zip: refusing path-traversal entry %q", f.Name)
	}
	dest := filepath.Join(stageAbs, clean)
	destAbs, dErr := filepath.Abs(dest)
	if dErr != nil {
		return "", dErr
	}
	rel, relErr := filepath.Rel(stageAbs, destAbs)
	if relErr != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", fmt.Errorf("plugin zip: refusing escape %q", f.Name)
	}
	return destAbs, nil
}

// installZipWriteEntry copies one regular entry to destAbs, refusing to write
// more than remaining bytes — this entry's share of the maxUncompressedSum
// budget — and returns how many bytes it wrote.
func installZipWriteEntry(f *zip.File, destAbs string, remaining int64) (int64, error) {
	rc, oErr := f.Open()
	if oErr != nil {
		return 0, oErr
	}
	out, cErr := os.OpenFile(destAbs, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if cErr != nil {
		_ = rc.Close()
		return 0, cErr
	}
	if remaining <= 0 {
		_ = rc.Close()
		_ = out.Close()
		return 0, fmt.Errorf("plugin zip: uncompressed total exceeds %d bytes", maxUncompressedSum)
	}
	n, copyErr := io.CopyN(out, rc, remaining+1)
	_ = rc.Close()
	_ = out.Close()
	if copyErr != nil && copyErr != io.EOF {
		return 0, copyErr
	}
	if n > remaining {
		return 0, fmt.Errorf("plugin zip: uncompressed total exceeds %d bytes", maxUncompressedSum)
	}
	return n, nil
}

// installZipStagedManifest parses the staged plugin.json and holds the staged
// tree to the same rules scanPluginDirectory applies to an on-disk plugin (no
// symlinks anywhere, entrypoint present and not a symlink).
func installZipStagedManifest(stageAbs string) (*Manifest, error) {
	manifestPath := filepath.Join(stageAbs, "plugin.json")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("plugin zip: missing plugin.json at root: %w", err)
	}
	manifest, err := ParseManifest(raw)
	if err != nil {
		return nil, err
	}
	// Validate the staged contents the same way scanPluginDirectory does.
	if err := rejectSymlinksUnder(stageAbs); err != nil {
		return nil, err
	}
	wasmPath := filepath.Join(stageAbs, manifest.Entrypoint)
	if info, statErr := os.Lstat(wasmPath); statErr != nil {
		return nil, fmt.Errorf("entrypoint %s missing: %w", manifest.Entrypoint, statErr)
	} else if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("entrypoint %s is a symlink", manifest.Entrypoint)
	}
	return manifest, nil
}

// installZipPromote moves the fully validated staging directory into its
// canonical plugin-name directory. If a previous version already lives at
// finalDir, it is renamed aside rather than deleted, and its temporary path
// is returned as backupDir so the caller can restore it if a later install
// step fails, or remove it once the install is confirmed. backupDir is empty
// when there was nothing to preserve (a fresh install) or when the rename-
// aside itself failed and installZipPromote fell back to a hard delete (e.g.
// stageAbs and finalDir's parent are on different filesystems) — the
// previous, always-destructive behaviour is preserved only in that fallback
// case, which os.Rename within the same plugin directory should never hit in
// practice.
//
// The backup directory name carries the same ".install-" prefix LoadAll's
// stale-staging sweep already reaps on startup, so a backup orphaned by a
// mid-install crash does not linger forever or get mistaken for a plugin by
// scanPluginDirectory.
func installZipPromote(stageAbs, finalDir string) (backupDir string, err error) {
	if _, statErr := os.Stat(finalDir); statErr == nil {
		tmp, mkErr := os.MkdirTemp(filepath.Dir(finalDir), ".install-old-")
		if mkErr != nil {
			return "", fmt.Errorf("stage backup dir: %w", mkErr)
		}
		// os.Rename requires the destination to not exist; free the name
		// MkdirTemp just reserved immediately before renaming the previous
		// version into it. Nothing else in this codepath creates that exact
		// name, so the gap is not meaningfully racier than MkdirTemp's own
		// creation was.
		if rmErr := os.Remove(tmp); rmErr != nil {
			return "", fmt.Errorf("free backup dir slot: %w", rmErr)
		}
		if renameErr := os.Rename(finalDir, tmp); renameErr != nil {
			// Cross-device or other rename failure: fall back to the old
			// (destructive) behaviour so the install can still proceed —
			// there is nothing to roll back to in this fallback case.
			if rmAllErr := os.RemoveAll(finalDir); rmAllErr != nil {
				return "", fmt.Errorf("remove existing plugin dir: %w", rmAllErr)
			}
		} else {
			backupDir = tmp
		}
	}
	if err := os.Rename(stageAbs, finalDir); err != nil {
		if backupDir != "" {
			// Best-effort: put the previous version back so this failure
			// doesn't also take out the plugin that was already installed.
			_ = os.Rename(backupDir, finalDir)
		}
		return "", fmt.Errorf("install rename: %w", err)
	}
	return backupDir, nil
}

// installZipReactivate restores the enabled state of a plugin that was already
// enabled before this upgrade.
//
// installFromDisk always registers the fresh instance as disabled and
// InstallPlugin's upsert never touches the `enabled` column, so a plugin
// that was enabled before this upgrade would otherwise come out the
// other side with the store row still saying enabled while the runtime
// instance sits inactive. LoadAll's startup path avoids this because it
// always runs activateAll afterward; this is the one caller of
// installFromDisk that doesn't, so it has to reactivate for itself.
// EnablePlugin already rolls the DB flag back if activation fails, so
// the two can no longer disagree.
func (r *Registry) installZipReactivate(ctx context.Context, name string) {
	row, rowErr := r.cfg.Store.GetPluginByName(ctx, name)
	if rowErr != nil || row == nil || !row.Enabled {
		return
	}
	err := r.EnablePlugin(ctx, row.ID)
	if err == nil {
		return
	}
	if !errors.Is(err, ErrRuntimeUnavailable) {
		slog.Warn("plugin: reactivate after upgrade failed", "name", name, "err", err)
		return
	}
	// Default (non-wazero) build: nothing can activate here, and
	// leaving EnablePlugin's rollback in place would persistently
	// disable a plugin the admin left enabled — after a rebuild
	// with -tags wazero it would silently stay off. Preserve the
	// enabled intent instead; the next wazero-tagged start's
	// activateAll does the real activation.
	if reErr := r.cfg.Store.EnablePlugin(ctx, row.ID); reErr != nil {
		slog.Warn("plugin: could not preserve enabled flag across runtime-less upgrade",
			"name", name, "err", reErr)
		return
	}
	r.mu.Lock()
	if inst, ok := r.byName[name]; ok {
		inst.Enabled = true
	}
	r.mu.Unlock()
	slog.Info("plugin: runtime unavailable, enabled flag preserved across upgrade",
		"name", name)
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

// enablePluginActivate is EnablePlugin's activation call, indirected through
// a package variable so tests can deterministically simulate a concurrent
// DisablePlugin/UninstallPlugin winning the race inside activate's unlocked
// compile/instantiate window (OC-0243) without needing a real wazero runtime
// and its own timing. Production never reassigns it.
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
		// No in-memory instance to activate — roll the DB flag back so it
		// doesn't stay stuck at enabled=1 with nothing backing it, the same
		// way the activation-failure path below rolls back.
		_ = r.cfg.Store.DisablePlugin(ctx, id)
		return ErrPluginNotFound
	}
	r.mu.Lock()
	inst.Enabled = true
	r.mu.Unlock()
	if err := enablePluginActivate(r, ctx, inst); err != nil {
		// Roll back the DB flag and the in-memory flag so the next start
		// attempt is consistent.
		_ = r.cfg.Store.DisablePlugin(ctx, id)
		r.mu.Lock()
		inst.Enabled = false
		r.mu.Unlock()
		return err
	}
	// activate releases r.mu for its whole compile+instantiate window (it is
	// CPU-bound — see activateWithRuntime), so a concurrent DisablePlugin or
	// UninstallPlugin (which calls DisablePlugin first) may have run to
	// completion entirely inside that window. Such a call finds inst.Enabled
	// still true but nothing yet to tear down — module still nil, no command
	// bindings registered — so its teardown is a no-op, and activate then
	// installs a live module and registers commands afterwards. Detect that
	// lost race here, the one place both EnablePlugin and DisablePlugin
	// funnel through, and redo the exact teardown DisablePlugin performs so a
	// plugin the store and inst.Enabled both say is disabled never ends up
	// with live command bindings routing DispatchCommand into it.
	r.mu.Lock()
	if !inst.Enabled {
		for cmd, owner := range r.commands {
			if owner == inst {
				delete(r.commands, cmd)
			}
		}
		r.platformDeactivate(ctx, inst)
	}
	r.mu.Unlock()
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
		r.platformDeactivate(ctx, inst)
	}
	return nil
}

// removeAll is os.RemoveAll indirected so tests can force a directory-removal
// failure deterministically. Windows silently succeeds at deleting read-only
// files (there's no portable, privilege-free way to make a real RemoveAll
// fail from a test), so this is the seam that lets the error-return path in
// UninstallPlugin be pinned.
var removeAll = os.RemoveAll

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

	// Remove on-disk files so the plugin isn't resurrected on the next
	// startup by scanPluginDirectory. The DB row and in-memory record are
	// already gone at this point, so a removal failure is reported rather
	// than swallowed — the caller needs to know the directory still has to
	// be cleaned up by hand before the next restart, or scanPluginDirectory
	// will bring the "uninstalled" plugin right back.
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
