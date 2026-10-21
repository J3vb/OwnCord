package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// Migration 072 turns the free-text channels.category into channel_categories
// rows. The backfill must make the first render after the upgrade identical:
// one category per distinct trimmed name (ignoring case), spelled like the
// lowest-positioned channel, ordered by that channel, and no category at all
// for an empty or whitespace-only value.
func TestMigrate_072BackfillsCategoriesFromFreeText(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()

	if err := db.MigrateFS(database, migrationsUpTo(t, "072_")); err != nil {
		t.Fatalf("MigrateFS() building pre-072 schema: %v", err)
	}
	if !columnExists(t, database, "channels", "category") || columnExists(t, database, "channels", "category_id") {
		t.Fatal("the pre-072 schema should have channels.category and no category_id")
	}
	// id, name, category, position. "Games" at position 5 and "games" at
	// position 2 are one category spelled "games"; " Text Channels " trims;
	// "Voice" ties with "Voice " on the minimum position, so the lower id
	// decides which spelling wins; blank, whitespace and NULL get none.
	for _, c := range []struct {
		id       int
		name     string
		category any
		position int
	}{
		{1, "g-big", "Games", 5},
		{2, "g-small", "games", 2},
		{3, "t-one", " Text Channels ", 0},
		{4, "t-two", "Text Channels", 1},
		{5, "v-one", "Voice", 9},
		{6, "v-two", "VOICE ", 9},
		{7, "blank", "", 3},
		{8, "spaces", " \t\n ", 4},
		{9, "none", nil, 6},
		{10, "later", "Zed", 12},
	} {
		if _, err := database.ExecContext(ctx,
			`INSERT INTO channels (id, name, type, category, position) VALUES (?, ?, 'text', ?, ?)`,
			c.id, c.name, c.category, c.position); err != nil {
			t.Fatalf("seed channel %d: %v", c.id, err)
		}
	}

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() applying 072: %v", err)
	}

	cats, err := database.ListChannelCategories(ctx)
	if err != nil {
		t.Fatalf("ListChannelCategories: %v", err)
	}
	want := []struct {
		name     string
		position int
	}{
		{"Text Channels", 0}, // min position 0
		{"games", 1},         // min position 2, spelled like channel 2
		{"Voice", 2},         // min position 9, channel 5 has the lower id
		{"Zed", 3},           // min position 12
	}
	if len(cats) != len(want) {
		t.Fatalf("categories = %+v, want %d", cats, len(want))
	}
	byName := map[string]int64{}
	for i, w := range want {
		if cats[i].Name != w.name || cats[i].Position != w.position {
			t.Errorf("category %d = %q at %d, want %q at %d", i, cats[i].Name, cats[i].Position, w.name, w.position)
		}
		byName[w.name] = cats[i].ID
	}

	wantCategory := map[int64]string{
		1: "games", 2: "games", 3: "Text Channels", 4: "Text Channels",
		5: "Voice", 6: "Voice", 7: "", 8: "", 9: "", 10: "Zed",
	}
	for id, name := range wantCategory {
		ch, err := database.GetChannel(ctx, id)
		if err != nil || ch == nil {
			t.Fatalf("GetChannel(%d): %v", id, err)
		}
		if ch.Category != name {
			t.Errorf("channel %d category = %q, want %q", id, ch.Category, name)
		}
		if name == "" && ch.CategoryID != 0 {
			t.Errorf("channel %d (blank category) has category_id %d, want none", id, ch.CategoryID)
		}
		if name != "" && ch.CategoryID != byName[name] {
			t.Errorf("channel %d category_id = %d, want %d (%s)", id, ch.CategoryID, byName[name], name)
		}
	}
	// A channel's category_position is its category's position.
	if ch, _ := database.GetChannel(ctx, 5); ch.CategoryPosition != 2 {
		t.Errorf("channel 5 category_position = %d, want 2", ch.CategoryPosition)
	}

	// The name index is case-insensitive from here on.
	if _, err := database.CreateChannelCategory(ctx, "GAMES"); err == nil {
		t.Error("a second category named GAMES was accepted")
	}
}

// A database with no categorized channel upgrades to an empty category table,
// and the dropped-column rollback story is untouched: the column stays.
func TestMigrate_072WithNoCategorizedChannels(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()
	if err := db.MigrateFS(database, migrationsUpTo(t, "072_")); err != nil {
		t.Fatalf("pre-072: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO channels (name, type) VALUES ('general', 'text')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	cats, err := database.ListChannelCategories(ctx)
	if err != nil || len(cats) != 0 {
		t.Fatalf("categories = %+v, err %v; want none", cats, err)
	}
	if !columnExists(t, database, "channels", "category_id") {
		t.Fatal("channels.category_id missing after 072")
	}
}
