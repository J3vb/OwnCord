//go:build !wazero

// Registry lifecycle tests for the default (non-wazero) build.
//
// The build constraint above is load-bearing, not decorative: these tests
// assert activation fails with ErrRuntimeUnavailable, which is only true
// when no runtime is linked in. Under -tags wazero a real runtime exists
// and two of them failed. The file always intended to be default-only (see
// the paragraph below); it just never carried the tag.
//
// registry.go is the largest source file in the plugin package and its
// lifecycle half — Sink, activate, EnablePlugin, DisablePlugin,
// UninstallPlugin, List, UITabBindings — had no coverage. The wazero-tagged
// build has its own activation tests in sandbox_wazero_test.go; what is pinned
// here is the behaviour that holds *without* a runtime: enabling must roll the
// store flag back when activation fails, disabling must drop command bindings,
// and uninstalling must remove the on-disk directory so the plugin is not
// resurrected by the next LoadAll.
package plugin

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// newRegistryWithDir builds a registry backed by a real in-memory database and
// a temp plugin directory, and returns both.
func newRegistryWithDir(t *testing.T) (*Registry, PluginStore, string) {
	t.Helper()
	dir := t.TempDir()
	store := openPluginTestDB(t)
	r, err := NewRegistry(Config{Directory: dir, Store: store})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	t.Cleanup(func() { _ = r.Close(context.Background()) })
	return r, store, dir
}

// writePluginDir lays a minimal valid plugin out on disk and returns its path.
func writePluginDir(t *testing.T, root, name, manifestJSON string) string {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(manifestJSON), 0o600); err != nil {
		t.Fatalf("write plugin.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0o600); err != nil {
		t.Fatalf("write wasm: %v", err)
	}
	return dir
}

func simpleManifest(name string) string {
	return `{"name":"` + name + `","version":"1.0.0","entrypoint":"` + name + `.wasm","permissions":["storage"]}`
}

// ─── NewRegistry / Sink ─────────────────────────────────────────────────────

func TestNewRegistry_RequiresStore(t *testing.T) {
	if _, err := NewRegistry(Config{Directory: t.TempDir()}); err == nil {
		t.Error("NewRegistry with a nil Store succeeded; want an error")
	}
}

func TestRegistry_Sink(t *testing.T) {
	r, _, _ := newRegistryWithDir(t)

	sink := r.Sink()
	if sink == nil {
		t.Fatal("Sink() = nil; the hub dereferences this on every broadcast")
	}
	if r.Sink() != sink {
		t.Error("Sink() returned a different EventSink on the second call; it must be stable")
	}
}

// ─── LoadAll / List ─────────────────────────────────────────────────────────

func TestRegistry_LoadAll_RegistersDiscoveredPlugins(t *testing.T) {
	r, store, dir := newRegistryWithDir(t)
	ctx := context.Background()
	writePluginDir(t, dir, "alpha", simpleManifest("alpha"))
	writePluginDir(t, dir, "beta", simpleManifest("beta"))

	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}

	list := r.List()
	if len(list) != 2 {
		t.Fatalf("List() has %d entries after LoadAll, want 2", len(list))
	}
	for _, inst := range list {
		if inst.Enabled {
			t.Errorf("plugin %q is enabled straight after LoadAll; installs must default to disabled", inst.Manifest.Name)
		}
	}

	rows, err := store.ListPlugins(ctx)
	if err != nil {
		t.Fatalf("ListPlugins: %v", err)
	}
	if len(rows) != 2 {
		t.Errorf("store has %d rows, want 2 — LoadAll must persist discovered manifests", len(rows))
	}
}

// OC-0165: one malformed plugin directory must not blank the whole registry.
// LoadAll must still install and activate every good plugin alongside a
// broken one, matching installFromDisk's own per-plugin-failure policy a few
// lines below (a bad plugin there just gets `slog.Warn` + `continue`).
func TestRegistry_LoadAll_InstallsGoodPluginsDespiteOneBadDirectory(t *testing.T) {
	r, store, dir := newRegistryWithDir(t)
	ctx := context.Background()
	writePluginDir(t, dir, "alpha", simpleManifest("alpha"))

	// "broken" has a plugin.json that fails to parse — malformed JSON.
	brokenDir := filepath.Join(dir, "broken")
	if err := os.MkdirAll(brokenDir, 0o750); err != nil {
		t.Fatalf("mkdir %s: %v", brokenDir, err)
	}
	if err := os.WriteFile(filepath.Join(brokenDir, "plugin.json"), []byte(`{"name":"broken",}`), 0o600); err != nil {
		t.Fatalf("write plugin.json: %v", err)
	}

	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v — a malformed plugin directory must not fail the whole load", err)
	}

	list := r.List()
	if len(list) != 1 {
		t.Fatalf("List() has %d entries after LoadAll, want 1 (alpha installed despite broken's failure); got %+v", len(list), list)
	}
	if list[0].Manifest.Name != "alpha" {
		t.Errorf("List()[0].Manifest.Name = %q, want \"alpha\"", list[0].Manifest.Name)
	}

	rows, err := store.ListPlugins(ctx)
	if err != nil {
		t.Fatalf("ListPlugins: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("store has %d rows, want 1 — the good plugin must still be persisted", len(rows))
	}
}

func TestRegistry_LoadAll_RemovesStaleStagingDirs(t *testing.T) {
	r, _, dir := newRegistryWithDir(t)

	// A crash mid-InstallFromZip leaves a ".install-XXXX" directory behind.
	stale := filepath.Join(dir, ".install-abc123")
	if err := os.MkdirAll(stale, 0o750); err != nil {
		t.Fatalf("mkdir stale: %v", err)
	}

	if err := r.LoadAll(context.Background()); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("stale staging dir survived LoadAll (stat err = %v)", err)
	}
}

func TestRegistry_List_IsASnapshot(t *testing.T) {
	r, _, dir := newRegistryWithDir(t)
	ctx := context.Background()
	writePluginDir(t, dir, "alpha", simpleManifest("alpha"))
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}

	first := r.List()
	if len(first) != 1 {
		t.Fatalf("List() = %d entries, want 1", len(first))
	}

	// Mutating the returned slice must not affect the registry.
	first[0] = nil
	second := r.List()
	if len(second) != 1 || second[0] == nil {
		t.Error("mutating the slice returned by List() corrupted the registry's own state")
	}
}

// ─── activate (default build) ───────────────────────────────────────────────

func TestRegistry_Activate_WithoutRuntime(t *testing.T) {
	r, _, dir := newRegistryWithDir(t)
	ctx := context.Background()
	writePluginDir(t, dir, "alpha", simpleManifest("alpha"))
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}

	inst := r.List()[0]
	err := r.activate(ctx, inst)
	if !errors.Is(err, ErrRuntimeUnavailable) {
		t.Errorf("activate without a runtime = %v, want ErrRuntimeUnavailable", err)
	}
}

func TestRegistry_Activate_AfterClose(t *testing.T) {
	r, _, dir := newRegistryWithDir(t)
	ctx := context.Background()
	writePluginDir(t, dir, "alpha", simpleManifest("alpha"))
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	inst := r.List()[0]

	if err := r.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Close nils runtimePlatform under the lock; activate must observe that
	// and refuse rather than call into a torn-down runtime.
	if err := r.activate(ctx, inst); !errors.Is(err, ErrRuntimeUnavailable) {
		t.Errorf("activate after Close = %v, want ErrRuntimeUnavailable", err)
	}
	if got := r.List(); len(got) != 0 {
		t.Errorf("List() = %d entries after Close, want 0", len(got))
	}
}

// ─── EnablePlugin ───────────────────────────────────────────────────────────

func TestRegistry_EnablePlugin_RollsBackWhenActivationFails(t *testing.T) {
	r, store, dir := newRegistryWithDir(t)
	ctx := context.Background()
	writePluginDir(t, dir, "alpha", simpleManifest("alpha"))
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	inst := r.List()[0]

	// The default build has no runtime, so activation always fails. What
	// matters is that the failure leaves no half-enabled state behind.
	err := r.EnablePlugin(ctx, inst.ID)
	if !errors.Is(err, ErrRuntimeUnavailable) {
		t.Fatalf("EnablePlugin = %v, want ErrRuntimeUnavailable", err)
	}

	if inst.Enabled {
		t.Error("in-memory Enabled flag stayed true after a failed activation")
	}
	row, err := store.GetPlugin(ctx, inst.ID)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if row.Enabled {
		t.Error("store row stayed enabled after a failed activation; the rollback did not run")
	}
}

func TestRegistry_EnablePlugin_UnknownID(t *testing.T) {
	r, _, _ := newRegistryWithDir(t)

	if err := r.EnablePlugin(context.Background(), 999); !errors.Is(err, ErrPluginNotFound) {
		t.Errorf("EnablePlugin on an unknown id = %v, want ErrPluginNotFound", err)
	}
}

// OC-0126: EnablePlugin sets the DB flag before it looks the in-memory
// instance up. When the store row survives but the instance does not (the
// on-disk manifest vanished without going through UninstallPlugin), the
// early `!ok` return must roll the DB flag back the same way the
// activation-failure path below it already does — otherwise the row is
// permanently stuck at enabled=1 with no runtime instance to match it.
func TestRegistry_EnablePlugin_RollsBackWhenInstanceMissing(t *testing.T) {
	r, store, dir := newRegistryWithDir(t)
	ctx := context.Background()
	writePluginDir(t, dir, "alpha", simpleManifest("alpha"))
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	inst := r.List()[0]
	id := inst.ID

	// Simulate the plugin's on-disk manifest disappearing independently of
	// UninstallPlugin (e.g. a manual directory delete): the store row
	// survives but the in-memory registration does not.
	r.mu.Lock()
	delete(r.plugins, id)
	delete(r.byName, inst.Manifest.Name)
	r.mu.Unlock()

	err := r.EnablePlugin(ctx, id)
	if !errors.Is(err, ErrPluginNotFound) {
		t.Fatalf("EnablePlugin on a store-only row = %v, want ErrPluginNotFound", err)
	}

	row, getErr := store.GetPlugin(ctx, id)
	if getErr != nil {
		t.Fatalf("GetPlugin: %v", getErr)
	}
	if row.Enabled {
		t.Error("store row stayed enabled after EnablePlugin found no in-memory instance; the rollback did not run")
	}
}

// ─── DisablePlugin ──────────────────────────────────────────────────────────

func TestRegistry_DisablePlugin_ClearsFlagAndCommands(t *testing.T) {
	r, store, dir := newRegistryWithDir(t)
	ctx := context.Background()
	writePluginDir(t, dir, "alpha", simpleManifest("alpha"))
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	inst := r.List()[0]

	// Simulate an activated plugin that owns a command binding.
	r.mu.Lock()
	inst.Enabled = true
	r.commands["greet"] = inst
	r.mu.Unlock()

	if err := r.DisablePlugin(ctx, inst.ID); err != nil {
		t.Fatalf("DisablePlugin: %v", err)
	}

	if inst.Enabled {
		t.Error("Enabled flag survived DisablePlugin")
	}
	r.mu.RLock()
	_, stillBound := r.commands["greet"]
	r.mu.RUnlock()
	if stillBound {
		t.Error("command binding survived DisablePlugin; dispatch would still route into a torn-down plugin")
	}

	row, err := store.GetPlugin(ctx, inst.ID)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if row.Enabled {
		t.Error("store row stayed enabled after DisablePlugin")
	}
}

func TestRegistry_DisablePlugin_UnknownIDIsNoOp(t *testing.T) {
	r, _, _ := newRegistryWithDir(t)

	// The store UPDATE matches no rows and the in-memory lookup misses; this
	// must not error, so an admin can disable an already-removed plugin.
	if err := r.DisablePlugin(context.Background(), 999); err != nil {
		t.Errorf("DisablePlugin on an unknown id = %v, want nil", err)
	}
}

// ─── UninstallPlugin ────────────────────────────────────────────────────────

func TestRegistry_UninstallPlugin_RemovesRowAndDirectory(t *testing.T) {
	r, store, dir := newRegistryWithDir(t)
	ctx := context.Background()
	pluginDir := writePluginDir(t, dir, "alpha", simpleManifest("alpha"))
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	inst := r.List()[0]

	if err := r.UninstallPlugin(ctx, inst.ID); err != nil {
		t.Fatalf("UninstallPlugin: %v", err)
	}

	if got := r.List(); len(got) != 0 {
		t.Errorf("List() = %d entries after uninstall, want 0", len(got))
	}
	rows, err := store.ListPlugins(ctx)
	if err != nil {
		t.Fatalf("ListPlugins: %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("store has %d rows after uninstall, want 0", len(rows))
	}

	// The on-disk removal is what stops the next LoadAll from reinstalling it.
	if _, err := os.Stat(pluginDir); !os.IsNotExist(err) {
		t.Errorf("plugin directory survived uninstall (stat err = %v)", err)
	}
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll after uninstall: %v", err)
	}
	if got := r.List(); len(got) != 0 {
		t.Errorf("uninstalled plugin was resurrected by LoadAll: %d entries", len(got))
	}
}

// OC-0127: when the on-disk directory can't be removed, UninstallPlugin must
// report that instead of returning nil — the comment right above the removal
// says the removal is what stops scanPluginDirectory resurrecting the plugin
// on the next startup, so silently swallowing the error produces exactly the
// outcome the removal exists to prevent.
func TestRegistry_UninstallPlugin_ReturnsErrorWhenDirRemovalFails(t *testing.T) {
	r, store, dir := newRegistryWithDir(t)
	ctx := context.Background()
	pluginDir := writePluginDir(t, dir, "alpha", simpleManifest("alpha"))
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	inst := r.List()[0]

	// Force the directory removal to fail. There's no portable,
	// privilege-free way to make a real os.RemoveAll fail on Windows (it
	// happily deletes read-only files), so the removeAll seam is overridden
	// directly.
	origRemoveAll := removeAll
	removeAll = func(string) error { return fmt.Errorf("simulated removal failure") }
	t.Cleanup(func() { removeAll = origRemoveAll })

	err := r.UninstallPlugin(ctx, inst.ID)
	if err == nil {
		t.Fatal("UninstallPlugin succeeded despite a directory-removal failure; want an error")
	}

	if _, statErr := os.Stat(pluginDir); statErr != nil {
		t.Errorf("plugin directory was actually removed despite the reported error (stat err = %v)", statErr)
	}

	// The DB row and in-memory record are gone regardless — only the on-disk
	// cleanup failed, and that failure must be visible to the caller.
	rows, lErr := store.ListPlugins(ctx)
	if lErr != nil {
		t.Fatalf("ListPlugins: %v", lErr)
	}
	if len(rows) != 0 {
		t.Errorf("store row survived a failed uninstall; want it removed regardless of directory cleanup")
	}
}

// OC-0133: UninstallPlugin must remove the plugin's real on-disk directory,
// not one rebuilt from manifest.Name. scanPluginDirectory keys the directory
// off the filesystem entry name, so a plugin dropped in a folder whose name
// differs from its manifest name (e.g. a hand-installed "hello-v2" holding
// manifest name "hello") is otherwise resurrected by the next LoadAll: the
// wrong path 404s os.RemoveAll into a silent no-op.
func TestRegistry_UninstallPlugin_DirNameDiffersFromManifestName(t *testing.T) {
	r, store, dir := newRegistryWithDir(t)
	ctx := context.Background()

	actualDir := filepath.Join(dir, "hello-v2")
	if err := os.MkdirAll(actualDir, 0o750); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	manifestJSON := `{"name":"hello","version":"1.0.0","entrypoint":"hello.wasm","permissions":["storage"]}`
	if err := os.WriteFile(filepath.Join(actualDir, "plugin.json"), []byte(manifestJSON), 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(actualDir, "hello.wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0o600); err != nil {
		t.Fatalf("write wasm: %v", err)
	}

	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	inst := r.List()[0]
	if inst.Manifest.Name != "hello" {
		t.Fatalf("test setup: manifest name = %q, want hello", inst.Manifest.Name)
	}

	if err := r.UninstallPlugin(ctx, inst.ID); err != nil {
		t.Fatalf("UninstallPlugin: %v", err)
	}

	if _, statErr := os.Stat(actualDir); !os.IsNotExist(statErr) {
		t.Errorf("actual plugin directory %q survived uninstall (stat err = %v)", actualDir, statErr)
	}

	// The real bug symptom: a stale directory makes the plugin come back.
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll after uninstall: %v", err)
	}
	if got := r.List(); len(got) != 0 {
		t.Errorf("uninstalled plugin was resurrected by LoadAll: %d entries", len(got))
	}
	rows, err := store.ListPlugins(ctx)
	if err != nil {
		t.Fatalf("ListPlugins: %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("store still has %d rows after uninstall+reload, want 0", len(rows))
	}
}

func TestRegistry_UninstallPlugin_UnknownID(t *testing.T) {
	r, _, _ := newRegistryWithDir(t)

	if err := r.UninstallPlugin(context.Background(), 999); err != nil {
		t.Errorf("UninstallPlugin on an unknown id = %v, want nil", err)
	}
}

// ─── UITabBindings ──────────────────────────────────────────────────────────

func TestRegistry_UITabBindings(t *testing.T) {
	r, _, _ := newRegistryWithDir(t)

	if got := r.UITabBindings(); len(got) != 0 {
		t.Errorf("UITabBindings() = %v on a fresh registry, want empty", got)
	}

	binding := UITabBinding{
		PluginID:   7,
		PluginName: "alpha",
		Tab:        UITab{ID: "main", Label: "Alpha", Asset: "index.html"},
	}
	r.mu.Lock()
	r.uiTabs = append(r.uiTabs, binding)
	r.mu.Unlock()

	got := r.UITabBindings()
	if len(got) != 1 || got[0].PluginName != "alpha" {
		t.Fatalf("UITabBindings() = %+v, want the one registered binding", got)
	}

	// The returned slice is a copy — the client bridge must not be able to
	// rewrite the registry's bindings through it.
	got[0].PluginName = "mutated"
	if again := r.UITabBindings(); again[0].PluginName != "alpha" {
		t.Errorf("UITabBindings() returned the backing array; caller mutation leaked as %q", again[0].PluginName)
	}
}

// ─── InstallFromZip ─────────────────────────────────────────────────────────

// buildZip assembles an in-memory zip from name→content pairs.
func buildZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func TestRegistry_InstallFromZip_Success(t *testing.T) {
	r, store, dir := newRegistryWithDir(t)
	ctx := context.Background()

	zipBytes := buildZip(t, map[string]string{
		"plugin.json": simpleManifest("zipped"),
		"zipped.wasm": "\x00asm\x01\x00\x00\x00",
	})

	name, err := r.InstallFromZip(ctx, zipBytes)
	if err != nil {
		t.Fatalf("InstallFromZip: %v", err)
	}
	if name != "zipped" {
		t.Errorf("name = %q, want %q", name, "zipped")
	}

	if _, err := os.Stat(filepath.Join(dir, "zipped", "plugin.json")); err != nil {
		t.Errorf("plugin was not staged into the plugin directory: %v", err)
	}
	rows, err := store.ListPlugins(ctx)
	if err != nil {
		t.Fatalf("ListPlugins: %v", err)
	}
	if len(rows) != 1 || rows[0].Name != "zipped" {
		t.Errorf("store rows = %+v, want one row named zipped", rows)
	}

	// No staging directory may be left behind on the success path.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, e := range entries {
		if len(e.Name()) > 9 && e.Name()[:9] == ".install-" {
			t.Errorf("staging dir %q survived a successful install", e.Name())
		}
	}
}

// OC-0104: InstallFromZip is the hot-upgrade path (unlike LoadAll, nothing
// downstream of it calls activateAll). installFromDisk always registers the
// fresh Instance with Enabled: false and InstallPlugin's upsert never touches
// the `enabled` column, so a plugin that was enabled before the upgrade must
// come out the other side with its store row and its runtime instance still
// agreeing — otherwise the DB says enabled while the module is actually
// unloaded, and the admin panel has no reason to prompt a re-enable.
func TestRegistry_InstallFromZip_ReactivatesPreviouslyEnabledPlugin(t *testing.T) {
	r, store, dir := newRegistryWithDir(t)
	ctx := context.Background()
	writePluginDir(t, dir, "alpha", simpleManifest("alpha"))
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	inst := r.List()[0]

	// Simulate a previously-activated, enabled plugin — what activateAll
	// leaves behind under a real (wazero-tagged) runtime: DB row enabled and
	// the in-memory flag set to match.
	if err := store.EnablePlugin(ctx, inst.ID); err != nil {
		t.Fatalf("EnablePlugin (setup): %v", err)
	}
	r.mu.Lock()
	inst.Enabled = true
	r.mu.Unlock()

	// Upload a new version of the same plugin — the runtime-upgrade path.
	zipBytes := buildZip(t, map[string]string{
		"plugin.json": simpleManifest("alpha"),
		"alpha.wasm":  "\x00asm\x01\x00\x00\x00",
	})
	if _, err := r.InstallFromZip(ctx, zipBytes); err != nil {
		t.Fatalf("InstallFromZip: %v", err)
	}

	newInst := r.List()[0]
	row, err := store.GetPlugin(ctx, newInst.ID)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if row.Enabled != newInst.Enabled {
		t.Errorf("store row Enabled=%v but runtime instance Enabled=%v after InstallFromZip; a hot upgrade must never leave these disagreeing", row.Enabled, newInst.Enabled)
	}
}

func TestRegistry_InstallFromZip_Rejections(t *testing.T) {
	tests := []struct {
		name  string
		files map[string]string
	}{
		{
			name:  "missing plugin.json",
			files: map[string]string{"stray.wasm": "\x00asm\x01\x00\x00\x00"},
		},
		{
			name: "path traversal entry",
			files: map[string]string{
				"../escape.txt": "nope",
				"plugin.json":   simpleManifest("evil"),
				"evil.wasm":     "\x00asm\x01\x00\x00\x00",
			},
		},
		{
			name: "entrypoint missing from archive",
			files: map[string]string{
				"plugin.json": simpleManifest("ghost"),
			},
		},
		{
			name: "unparseable manifest",
			files: map[string]string{
				"plugin.json": `{"name":"bad"`,
				"bad.wasm":    "\x00asm\x01\x00\x00\x00",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, _, dir := newRegistryWithDir(t)

			_, err := r.InstallFromZip(context.Background(), buildZip(t, tt.files))
			if err == nil {
				t.Fatal("InstallFromZip succeeded; want a rejection")
			}

			// Every rejection path must clean its staging directory up.
			entries, readErr := os.ReadDir(dir)
			if readErr != nil {
				t.Fatalf("ReadDir: %v", readErr)
			}
			for _, e := range entries {
				if len(e.Name()) > 9 && e.Name()[:9] == ".install-" {
					t.Errorf("staging dir %q survived a rejected install", e.Name())
				}
			}
		})
	}
}

func TestRegistry_InstallFromZip_NotConfigured(t *testing.T) {
	store := openPluginTestDB(t)
	r, err := NewRegistry(Config{Store: store}) // no Directory
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	t.Cleanup(func() { _ = r.Close(context.Background()) })

	if _, err := r.InstallFromZip(context.Background(), []byte("whatever")); err == nil {
		t.Error("InstallFromZip with no plugin directory succeeded; want an error")
	}
}

func TestRegistry_InstallFromZip_OversizeRejected(t *testing.T) {
	r, _, _ := newRegistryWithDir(t)

	oversize := make([]byte, maxZipBytes+1)
	if _, err := r.InstallFromZip(context.Background(), oversize); err == nil {
		t.Error("InstallFromZip accepted a zip over maxZipBytes")
	}
}

func TestRegistry_InstallFromZip_InvalidArchive(t *testing.T) {
	r, _, _ := newRegistryWithDir(t)

	if _, err := r.InstallFromZip(context.Background(), []byte("this is not a zip")); err == nil {
		t.Error("InstallFromZip accepted a non-zip payload")
	}
}

// ─── bytesReaderAt ──────────────────────────────────────────────────────────

func TestBytesReaderAt(t *testing.T) {
	data := bytesReaderAt("hello world")

	buf := make([]byte, 5)
	n, err := data.ReadAt(buf, 0)
	if err != nil || n != 5 || string(buf) != "hello" {
		t.Errorf("ReadAt(0) = (%d, %v, %q), want (5, nil, \"hello\")", n, err, buf)
	}

	// A short read at the tail reports io.EOF alongside the bytes it managed
	// to copy, which is what archive/zip expects.
	tail := make([]byte, 10)
	n, err = data.ReadAt(tail, 6)
	if n != 5 || err == nil {
		t.Errorf("ReadAt(6) = (%d, %v), want (5, io.EOF)", n, err)
	}
	if string(tail[:n]) != "world" {
		t.Errorf("tail = %q, want %q", tail[:n], "world")
	}

	if _, err := data.ReadAt(buf, -1); err == nil {
		t.Error("ReadAt with a negative offset succeeded; want io.EOF")
	}
	if _, err := data.ReadAt(buf, 999); err == nil {
		t.Error("ReadAt past the end succeeded; want io.EOF")
	}
}
