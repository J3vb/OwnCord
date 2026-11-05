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
	database := openMigratedMemory(t)
	ctx := context.Background()

	id := installTestPlugin(t, database, "hello")
	if id == 0 {
		t.Fatal("InstallPlugin returned id 0")
	}

	got, err := database.GetPlugin(ctx, id)
	mustDo(t, "GetPlugin", err)
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
	database := openMigratedMemory(t)
	ctx := context.Background()

	first := installTestPlugin(t, database, "hello")

	// ON CONFLICT(name) DO UPDATE — a reinstall must upgrade the existing row
	// rather than create a second one, and must return the same id (the path
	// where LastInsertId is 0 and the code falls back to a lookup by name).
	second, err := database.InstallPlugin(ctx, "hello", "2.0.0", `{"name":"hello","v":2}`)
	mustDo(t, "InstallPlugin reinstall", err)
	if second != first {
		t.Errorf("reinstall returned id %d, want the original %d", second, first)
	}

	got, err := database.GetPlugin(ctx, first)
	mustDo(t, "GetPlugin", err)
	if got.Version != "2.0.0" {
		t.Errorf("Version = %q after reinstall, want %q", got.Version, "2.0.0")
	}

	all, err := database.ListPlugins(ctx)
	mustDo(t, "ListPlugins", err)
	if len(all) != 1 {
		t.Errorf("ListPlugins len = %d after reinstall, want 1", len(all))
	}
}

func TestEnableDisablePlugin(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	id := installTestPlugin(t, database, "hello")

	mustDo(t, "EnablePlugin", database.EnablePlugin(ctx, id))
	got, err := database.GetPlugin(ctx, id)
	mustDo(t, "GetPlugin", err)
	if !got.Enabled {
		t.Error("Enabled = false after EnablePlugin")
	}

	mustDo(t, "DisablePlugin", database.DisablePlugin(ctx, id))
	got, err = database.GetPlugin(ctx, id)
	mustDo(t, "GetPlugin", err)
	if got.Enabled {
		t.Error("Enabled = true after DisablePlugin")
	}
}

func TestGetPluginByName(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	id := installTestPlugin(t, database, "hello")

	got, err := database.GetPluginByName(ctx, "hello")
	mustDo(t, "GetPluginByName", err)
	if got.ID != id {
		t.Errorf("ID = %d, want %d", got.ID, id)
	}

	_, err = database.GetPluginByName(ctx, "does-not-exist")
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("GetPluginByName on a missing name = %v, want sql.ErrNoRows", err)
	}
}

func TestGetPlugin_Missing(t *testing.T) {
	database := openMigratedMemory(t)
	_, err := database.GetPlugin(context.Background(), 4242)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("GetPlugin on a missing id = %v, want sql.ErrNoRows", err)
	}
}

func TestUninstallPlugin_CascadesKV(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	id := installTestPlugin(t, database, "hello")

	mustDo(t, "PluginKVSet", database.PluginKVSet(ctx, id, "k", []byte("v")))
	mustDo(t, "UninstallPlugin", database.UninstallPlugin(ctx, id))

	if _, err := database.GetPlugin(ctx, id); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("GetPlugin after uninstall = %v, want sql.ErrNoRows", err)
	}

	// plugin_kv has ON DELETE CASCADE; an uninstall must not leave the removed
	// plugin's stored data behind for whatever reinstalls under that id.
	var leftover int
	row := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM plugin_kv WHERE plugin_id = ?`, id)
	mustDo(t, "count plugin_kv", row.Scan(&leftover))
	if leftover != 0 {
		t.Errorf("%d plugin_kv rows survived the uninstall, want 0", leftover)
	}
}

func TestListPlugins_OrderedByName(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	empty, err := database.ListPlugins(ctx)
	mustDo(t, "ListPlugins on empty", err)
	if len(empty) != 0 {
		t.Errorf("ListPlugins on empty = %v, want none", empty)
	}

	for _, name := range []string{"zeta", "alpha", "mid"} {
		installTestPlugin(t, database, name)
	}

	got, err := database.ListPlugins(ctx)
	mustDo(t, "ListPlugins", err)
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
	database := openMigratedMemory(t)
	ctx := context.Background()
	id := installTestPlugin(t, database, "hello")

	if _, err := database.PluginKVGet(ctx, id, "absent"); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("PluginKVGet on a missing key = %v, want sql.ErrNoRows", err)
	}

	mustDo(t, "PluginKVSet", database.PluginKVSet(ctx, id, "greeting", []byte("hi")))
	v, err := database.PluginKVGet(ctx, id, "greeting")
	mustDo(t, "PluginKVGet", err)
	if !bytes.Equal(v, []byte("hi")) {
		t.Errorf("value = %q, want %q", v, "hi")
	}

	// ON CONFLICT(plugin_id, key) DO UPDATE — a second Set overwrites.
	mustDo(t, "PluginKVSet overwrite", database.PluginKVSet(ctx, id, "greeting", []byte("hello again")))
	v, err = database.PluginKVGet(ctx, id, "greeting")
	mustDo(t, "PluginKVGet after overwrite", err)
	if !bytes.Equal(v, []byte("hello again")) {
		t.Errorf("value = %q after overwrite, want %q", v, "hello again")
	}

	mustDo(t, "PluginKVDelete", database.PluginKVDelete(ctx, id, "greeting"))
	if _, err := database.PluginKVGet(ctx, id, "greeting"); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("PluginKVGet after delete = %v, want sql.ErrNoRows", err)
	}
}

func TestPluginKV_NamespacesAreIsolated(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	a := installTestPlugin(t, database, "plugin-a")
	b := installTestPlugin(t, database, "plugin-b")

	mustDo(t, "PluginKVSet a", database.PluginKVSet(ctx, a, "secret", []byte("a-value")))
	mustDo(t, "PluginKVSet b", database.PluginKVSet(ctx, b, "secret", []byte("b-value")))

	// Same key, different namespaces — neither plugin can read or clobber the
	// other's value. This is the whole isolation guarantee of the KV store.
	got, err := database.PluginKVGet(ctx, a, "secret")
	mustDo(t, "PluginKVGet a", err)
	if !bytes.Equal(got, []byte("a-value")) {
		t.Errorf("plugin-a read %q, want %q", got, "a-value")
	}

	mustDo(t, "PluginKVDelete a", database.PluginKVDelete(ctx, a, "secret"))
	got, err = database.PluginKVGet(ctx, b, "secret")
	mustDo(t, "PluginKVGet b after deleting a's key", err)
	if !bytes.Equal(got, []byte("b-value")) {
		t.Errorf("plugin-b value = %q after plugin-a deleted its own key, want %q", got, "b-value")
	}
}

func TestPluginKVScan(t *testing.T) {
	database := openMigratedMemory(t)
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
	mustDo(t, "PluginKVSet other", database.PluginKVSet(ctx, other, "cfg:a", []byte("nope")))

	got, err := database.PluginKVScan(ctx, id, "cfg:", 100)
	mustDo(t, "PluginKVScan", err)
	if len(got) != 2 {
		t.Fatalf("PluginKVScan returned %d entries, want 2: %v", len(got), got)
	}
	if !bytes.Equal(got["cfg:a"], []byte("1")) || !bytes.Equal(got["cfg:b"], []byte("2")) {
		t.Errorf("PluginKVScan = %v, want cfg:a=1 and cfg:b=2 from this plugin only", got)
	}

	limited, err := database.PluginKVScan(ctx, id, "cfg:", 1)
	mustDo(t, "PluginKVScan with limit", err)
	if len(limited) != 1 {
		t.Errorf("PluginKVScan with limit 1 returned %d entries, want 1", len(limited))
	}

	none, err := database.PluginKVScan(ctx, id, "nomatch:", 100)
	mustDo(t, "PluginKVScan no match", err)
	if len(none) != 0 {
		t.Errorf("PluginKVScan with a non-matching prefix = %v, want empty", none)
	}
}

// TestPluginKVScan_IsBinaryPrefixMatch pins that PluginKVScan is an exact,
// case-sensitive BINARY prefix match — matching the exact-match semantics of
// PluginKVGet/Set/Delete on the same table — rather than a SQL LIKE pattern
// match, where '_' and '%' are wildcards and matching is ASCII
// case-insensitive.
func TestPluginKVScan_IsBinaryPrefixMatch(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	id := installTestPlugin(t, database, "hello")

	for k, v := range map[string]string{
		"cfg_a": "underscore-match",
		"cfgXa": "not-a-prefix-match",
		"Key1":  "capital-key",
		"key1":  "lowercase-key",
	} {
		if err := database.PluginKVSet(ctx, id, k, []byte(v)); err != nil {
			t.Fatalf("PluginKVSet(%s): %v", k, err)
		}
	}

	// '_' in the prefix must be a literal underscore, not a LIKE
	// single-character wildcard, so "cfgXa" must not be returned.
	underscoreScan, err := database.PluginKVScan(ctx, id, "cfg_", 100)
	mustDo(t, "PluginKVScan cfg_", err)
	if _, ok := underscoreScan["cfgXa"]; ok {
		t.Errorf("PluginKVScan(%q) = %v; '_' matched any character like a LIKE wildcard, but PluginKVGet treats \"cfg_a\" and \"cfgXa\" as distinct keys", "cfg_", underscoreScan)
	}
	if len(underscoreScan) != 1 || !bytes.Equal(underscoreScan["cfg_a"], []byte("underscore-match")) {
		t.Errorf("PluginKVScan(%q) = %v, want exactly {cfg_a: underscore-match}", "cfg_", underscoreScan)
	}

	// Matching must be case-sensitive (BINARY), matching key = ? on the same
	// table, so scanning "Key" must not return "key1".
	caseScan, err := database.PluginKVScan(ctx, id, "Key", 100)
	mustDo(t, "PluginKVScan Key", err)
	if _, ok := caseScan["key1"]; ok {
		t.Errorf("PluginKVScan(%q) = %v; LIKE's ASCII case-insensitivity matched \"key1\", but PluginKVGet/Delete treat \"Key1\" and \"key1\" as distinct keys", "Key", caseScan)
	}
	if len(caseScan) != 1 || !bytes.Equal(caseScan["Key1"], []byte("capital-key")) {
		t.Errorf("PluginKVScan(%q) = %v, want exactly {Key1: capital-key}", "Key", caseScan)
	}
}

func TestInstallPlugin_ReinstallReturnsCorrectID_AfterOtherWrites(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	id1, err := database.InstallPlugin(ctx, "rowid-plugin", "1.0", "{}")
	mustDo(t, "InstallPlugin", err)

	// Other INSERTs on the shared single writer connection move
	// last_insert_rowid past the plugin's id; the upsert's UPDATE branch
	// does not reset it.
	seedUser(t, database, "rowid-mover-1")
	seedUser(t, database, "rowid-mover-2")
	seedUser(t, database, "rowid-mover-3")

	id2, err := database.InstallPlugin(ctx, "rowid-plugin", "2.0", "{}")
	mustDo(t, "InstallPlugin reinstall", err)
	if id2 != id1 {
		t.Errorf("reinstall returned id %d, want %d — EnablePlugin/plugin_kv would target a nonexistent row", id2, id1)
	}
}
