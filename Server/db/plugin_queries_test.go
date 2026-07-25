package db_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"testing"
)

// Plugin persistence (migration 015) and the per-plugin KV namespace had no
// coverage. The KV namespace is the isolation boundary between plugins — the
// primary key is (plugin_id, key), so a plugin cannot name another plugin's
// namespace — and that property is worth pinning explicitly.

func installTestPlugin(t *testing.T, database interface {
	InstallPlugin(ctx context.Context, name, version, manifestJSON string) (int64, error)
}, name string) int64 {
	t.Helper()
	id, err := database.InstallPlugin(context.Background(), name, "1.0.0", `{"name":"`+name+`"}`)
	if err != nil {
		t.Fatalf("InstallPlugin(%s): %v", name, err)
	}
	return id
}

func TestInstallPlugin_AndGetPlugin(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	id := installTestPlugin(t, database, "hello")
	if id == 0 {
		t.Fatal("InstallPlugin returned id 0")
	}

	got, err := database.GetPlugin(ctx, id)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if got.Name != "hello" {
		t.Errorf("Name = %q, want %q", got.Name, "hello")
	}
	if got.Version != "1.0.0" {
		t.Errorf("Version = %q, want %q", got.Version, "1.0.0")
	}
	if got.Enabled {
		t.Error("Enabled = true; a freshly installed plugin must default to disabled")
	}
	if got.InstalledAt.IsZero() {
		t.Error("InstalledAt is zero; scanPluginRow should have parsed the timestamp")
	}
}

func TestInstallPlugin_ReinstallUpdatesInPlace(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	first := installTestPlugin(t, database, "hello")

	// ON CONFLICT(name) DO UPDATE — a reinstall must upgrade the existing row
	// rather than create a second one, and must return the same id (the path
	// where LastInsertId is 0 and the code falls back to a lookup by name).
	second, err := database.InstallPlugin(ctx, "hello", "2.0.0", `{"name":"hello","v":2}`)
	if err != nil {
		t.Fatalf("InstallPlugin reinstall: %v", err)
	}
	if second != first {
		t.Errorf("reinstall returned id %d, want the original %d", second, first)
	}

	got, err := database.GetPlugin(ctx, first)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if got.Version != "2.0.0" {
		t.Errorf("Version = %q after reinstall, want %q", got.Version, "2.0.0")
	}

	all, err := database.ListPlugins(ctx)
	if err != nil {
		t.Fatalf("ListPlugins: %v", err)
	}
	if len(all) != 1 {
		t.Errorf("ListPlugins len = %d after reinstall, want 1", len(all))
	}
}

func TestEnableDisablePlugin(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	id := installTestPlugin(t, database, "hello")

	if err := database.EnablePlugin(ctx, id); err != nil {
		t.Fatalf("EnablePlugin: %v", err)
	}
	got, err := database.GetPlugin(ctx, id)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if !got.Enabled {
		t.Error("Enabled = false after EnablePlugin")
	}

	if err := database.DisablePlugin(ctx, id); err != nil {
		t.Fatalf("DisablePlugin: %v", err)
	}
	got, err = database.GetPlugin(ctx, id)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if got.Enabled {
		t.Error("Enabled = true after DisablePlugin")
	}
}

func TestGetPluginByName(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	id := installTestPlugin(t, database, "hello")

	got, err := database.GetPluginByName(ctx, "hello")
	if err != nil {
		t.Fatalf("GetPluginByName: %v", err)
	}
	if got.ID != id {
		t.Errorf("ID = %d, want %d", got.ID, id)
	}

	_, err = database.GetPluginByName(ctx, "does-not-exist")
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("GetPluginByName on a missing name = %v, want sql.ErrNoRows", err)
	}
}

func TestGetPlugin_Missing(t *testing.T) {
	database := newMigratedTestDB(t)
	_, err := database.GetPlugin(context.Background(), 4242)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("GetPlugin on a missing id = %v, want sql.ErrNoRows", err)
	}
}

func TestUninstallPlugin_CascadesKV(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	id := installTestPlugin(t, database, "hello")

	if err := database.PluginKVSet(ctx, id, "k", []byte("v")); err != nil {
		t.Fatalf("PluginKVSet: %v", err)
	}
	if err := database.UninstallPlugin(ctx, id); err != nil {
		t.Fatalf("UninstallPlugin: %v", err)
	}

	if _, err := database.GetPlugin(ctx, id); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("GetPlugin after uninstall = %v, want sql.ErrNoRows", err)
	}

	// plugin_kv has ON DELETE CASCADE; an uninstall must not leave the removed
	// plugin's stored data behind for whatever reinstalls under that id.
	var leftover int
	row := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM plugin_kv WHERE plugin_id = ?`, id)
	if err := row.Scan(&leftover); err != nil {
		t.Fatalf("count plugin_kv: %v", err)
	}
	if leftover != 0 {
		t.Errorf("%d plugin_kv rows survived the uninstall, want 0", leftover)
	}
}

func TestListPlugins_OrderedByName(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	empty, err := database.ListPlugins(ctx)
	if err != nil {
		t.Fatalf("ListPlugins on empty: %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("ListPlugins on empty = %v, want none", empty)
	}

	for _, name := range []string{"zeta", "alpha", "mid"} {
		installTestPlugin(t, database, name)
	}

	got, err := database.ListPlugins(ctx)
	if err != nil {
		t.Fatalf("ListPlugins: %v", err)
	}
	want := []string{"alpha", "mid", "zeta"}
	if len(got) != len(want) {
		t.Fatalf("ListPlugins len = %d, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].Name != w {
			t.Errorf("ListPlugins[%d].Name = %q, want %q", i, got[i].Name, w)
		}
	}
}

func TestPluginKV_SetGetDelete(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	id := installTestPlugin(t, database, "hello")

	if _, err := database.PluginKVGet(ctx, id, "absent"); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("PluginKVGet on a missing key = %v, want sql.ErrNoRows", err)
	}

	if err := database.PluginKVSet(ctx, id, "greeting", []byte("hi")); err != nil {
		t.Fatalf("PluginKVSet: %v", err)
	}
	v, err := database.PluginKVGet(ctx, id, "greeting")
	if err != nil {
		t.Fatalf("PluginKVGet: %v", err)
	}
	if !bytes.Equal(v, []byte("hi")) {
		t.Errorf("value = %q, want %q", v, "hi")
	}

	// ON CONFLICT(plugin_id, key) DO UPDATE — a second Set overwrites.
	if err := database.PluginKVSet(ctx, id, "greeting", []byte("hello again")); err != nil {
		t.Fatalf("PluginKVSet overwrite: %v", err)
	}
	v, err = database.PluginKVGet(ctx, id, "greeting")
	if err != nil {
		t.Fatalf("PluginKVGet after overwrite: %v", err)
	}
	if !bytes.Equal(v, []byte("hello again")) {
		t.Errorf("value = %q after overwrite, want %q", v, "hello again")
	}

	if err := database.PluginKVDelete(ctx, id, "greeting"); err != nil {
		t.Fatalf("PluginKVDelete: %v", err)
	}
	if _, err := database.PluginKVGet(ctx, id, "greeting"); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("PluginKVGet after delete = %v, want sql.ErrNoRows", err)
	}
}

func TestPluginKV_NamespacesAreIsolated(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	a := installTestPlugin(t, database, "plugin-a")
	b := installTestPlugin(t, database, "plugin-b")

	if err := database.PluginKVSet(ctx, a, "secret", []byte("a-value")); err != nil {
		t.Fatalf("PluginKVSet a: %v", err)
	}
	if err := database.PluginKVSet(ctx, b, "secret", []byte("b-value")); err != nil {
		t.Fatalf("PluginKVSet b: %v", err)
	}

	// Same key, different namespaces — neither plugin can read or clobber the
	// other's value. This is the whole isolation guarantee of the KV store.
	got, err := database.PluginKVGet(ctx, a, "secret")
	if err != nil {
		t.Fatalf("PluginKVGet a: %v", err)
	}
	if !bytes.Equal(got, []byte("a-value")) {
		t.Errorf("plugin-a read %q, want %q", got, "a-value")
	}

	if err := database.PluginKVDelete(ctx, a, "secret"); err != nil {
		t.Fatalf("PluginKVDelete a: %v", err)
	}
	got, err = database.PluginKVGet(ctx, b, "secret")
	if err != nil {
		t.Fatalf("PluginKVGet b after deleting a's key: %v", err)
	}
	if !bytes.Equal(got, []byte("b-value")) {
		t.Errorf("plugin-b value = %q after plugin-a deleted its own key, want %q", got, "b-value")
	}
}

func TestPluginKVScan(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	id := installTestPlugin(t, database, "hello")
	other := installTestPlugin(t, database, "other")

	for k, v := range map[string]string{
		"cfg:a":   "1",
		"cfg:b":   "2",
		"state:x": "3",
	} {
		if err := database.PluginKVSet(ctx, id, k, []byte(v)); err != nil {
			t.Fatalf("PluginKVSet(%s): %v", k, err)
		}
	}
	if err := database.PluginKVSet(ctx, other, "cfg:a", []byte("nope")); err != nil {
		t.Fatalf("PluginKVSet other: %v", err)
	}

	got, err := database.PluginKVScan(ctx, id, "cfg:", 100)
	if err != nil {
		t.Fatalf("PluginKVScan: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("PluginKVScan returned %d entries, want 2: %v", len(got), got)
	}
	if !bytes.Equal(got["cfg:a"], []byte("1")) || !bytes.Equal(got["cfg:b"], []byte("2")) {
		t.Errorf("PluginKVScan = %v, want cfg:a=1 and cfg:b=2 from this plugin only", got)
	}

	limited, err := database.PluginKVScan(ctx, id, "cfg:", 1)
	if err != nil {
		t.Fatalf("PluginKVScan with limit: %v", err)
	}
	if len(limited) != 1 {
		t.Errorf("PluginKVScan with limit 1 returned %d entries, want 1", len(limited))
	}

	none, err := database.PluginKVScan(ctx, id, "nomatch:", 100)
	if err != nil {
		t.Fatalf("PluginKVScan no match: %v", err)
	}
	if len(none) != 0 {
		t.Errorf("PluginKVScan with a non-matching prefix = %v, want empty", none)
	}
}
