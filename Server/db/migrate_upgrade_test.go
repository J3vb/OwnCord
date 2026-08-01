package db_test

// migrate_upgrade_test.go — schema-coherence and upgrade round-trip tests for
// the tracked migration system. These extend migrate_test.go (which locks
// MigrateFS's tracking mechanics) with two higher-level guarantees:
//
//  1. The full embedded migration chain produces a coherent end schema: every
//     table/column added by phases 2-6 exists, and the MENTION_EVERYONE bit
//     seeded by migration 022 lands on the privileged roles only.
//  2. A database that was created at an older schema point (migrations
//     001..019 only, before any of the phase 2-6 additions) and already has
//     data in it can be upgraded by applying the remaining migrations
//     (020..028) without error, and every pre-existing row survives with sane
//     defaults for the newly added columns.
//
// TestMigrate_022SeedsMentionEveryone and TestMigrate_022CreatesMentionSchema
// in migrate_test.go already lock the mention-specific pieces in isolation;
// this file's TestMigrate_FullChainSchemaIsCoherent asserts the same facts as
// part of one end-to-end pass over the whole chain rather than duplicating
// those tests.

import (
	"context"
	"io/fs"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/migrations"
)

// migrationCutoffFS presents a filtered view of an underlying migrations FS
// that only exposes files sorting lexicographically before cutoff. Migration
// filenames are zero-padded ("019_perf_indexes.sql", "020_..."), so a string
// cutoff of "020_" exposes exactly 001..019 and hides 020 and everything
// after it. It implements fs.ReadDirFS and fs.ReadFileFS directly so
// fs.ReadDir/fs.ReadFile use the filtered listing without needing Open to be
// exercised.
type migrationCutoffFS struct {
	underlying fs.FS
	cutoff     string
}

func (m migrationCutoffFS) included(name string) bool {
	return name < m.cutoff
}

func (m migrationCutoffFS) Open(name string) (fs.File, error) {
	if name != "." && !m.included(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return m.underlying.Open(name)
}

func (m migrationCutoffFS) ReadDir(name string) ([]fs.DirEntry, error) {
	entries, err := fs.ReadDir(m.underlying, name)
	if err != nil {
		return nil, err
	}
	out := make([]fs.DirEntry, 0, len(entries))
	for _, e := range entries {
		if m.included(e.Name()) {
			out = append(out, e)
		}
	}
	return out, nil
}

func (m migrationCutoffFS) ReadFile(name string) ([]byte, error) {
	if !m.included(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return fs.ReadFile(m.underlying, name)
}

// columnExists reports whether a table has a column with the given name,
// using pragma_table_info so it works for columns added by ALTER TABLE ADD
// COLUMN as well as ones present since CREATE TABLE.
func columnExists(t *testing.T, database *db.DB, table, column string) bool {
	t.Helper()
	var n int
	err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, table, column,
	).Scan(&n)
	if err != nil {
		t.Fatalf("pragma_table_info(%s) for column %s: %v", table, column, err)
	}
	return n > 0
}

// TestMigrate_FullChainSchemaIsCoherent applies the full embedded migration
// chain to a fresh in-memory database and asserts that every table/column
// added across phases 2-6 exists, and that the MENTION_EVERYONE permission
// bit landed on exactly the privileged seeded roles.
func TestMigrate_FullChainSchemaIsCoherent(t *testing.T) {
	database := openMemory(t)
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	for _, tbl := range []string{"message_mentions", "channel_user_overrides"} {
		if !tableExists(t, database, tbl) {
			t.Errorf("table %q not created by the full migration chain", tbl)
		}
	}

	type colCheck struct{ table, column string }
	for _, c := range []colCheck{
		{"channels", "nsfw"},
		{"channels", "is_group"},
		{"users", "display_name"},
		{"users", "about"},
		{"users", "custom_status"},
		{"voice_states", "server_muted"},
		{"voice_states", "server_deafened"},
		{"emoji", "mime_type"},
		{"messages", "mentions_everyone"},
	} {
		if !columnExists(t, database, c.table, c.column) {
			t.Errorf("column %s.%s not added by the full migration chain", c.table, c.column)
		}
	}

	const mentionEveryone = int64(0x200000)
	for _, tc := range []struct {
		roleID int64
		name   string
		want   bool
	}{
		{1, "Owner", true},
		{2, "Admin", true},
		{3, "Moderator", true},
		{4, "Member", false},
	} {
		var perms int64
		if err := database.QueryRowContext(context.Background(),
			`SELECT permissions FROM roles WHERE id = ?`, tc.roleID).Scan(&perms); err != nil {
			t.Fatalf("read role %s: %v", tc.name, err)
		}
		if got := perms&mentionEveryone != 0; got != tc.want {
			t.Errorf("%s MENTION_EVERYONE = %v, want %v (perms=0x%X)", tc.name, got, tc.want, perms)
		}
	}
}

// TestMigrate_UpgradeFromMigration019PreservesData simulates upgrading a
// database that was last migrated at 019_perf_indexes.sql: it builds that
// schema via a filtered view of the real embedded migrations, inserts a row
// each into users/roles/channels/messages/voice_states/emoji (the tables the
// 020..028 migrations touch), then applies the full chain and asserts:
//
//   - the upgrade completes without error,
//   - the pre-existing rows are all still present (by primary key), and
//   - the new columns those rows gained have the migration's stated defaults
//     (0/NULL), not some other value — i.e. old data is not silently
//     backfilled with something other than the documented default.
func TestMigrate_UpgradeFromMigration019PreservesData(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()

	oldFS := migrationCutoffFS{underlying: migrations.FS, cutoff: "020_"}
	if err := db.MigrateFS(database, oldFS); err != nil {
		t.Fatalf("MigrateFS() building pre-020 schema: %v", err)
	}

	// Sanity: none of the phase 2-6 additions exist yet.
	for _, tbl := range []string{"message_mentions", "channel_user_overrides"} {
		if tableExists(t, database, tbl) {
			t.Fatalf("table %q already exists before migration 020+ ran — cutoff FS leaked later migrations", tbl)
		}
	}
	if columnExists(t, database, "channels", "nsfw") {
		t.Fatal("channels.nsfw already exists before migration 025 ran — cutoff FS leaked later migrations")
	}

	// Seed rows on the pre-upgrade schema. The default seeded roles (1-4) and
	// their permission masks already exist from 001; add one custom role,
	// one user, one channel, and one message referencing them, plus a
	// voice_states row and an emoji row so every 020..028-touched table has a
	// pre-existing row to check survival on.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (5, 'Veteran', '#00FF00', 0x00000663, 50, 0)`); err != nil {
		t.Fatalf("seed role: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'alice', 'hash', 5)`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO channels (id, name, type) VALUES (1, 'general', 'text')`); err != nil {
		t.Fatalf("seed channel: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO messages (id, channel_id, user_id, content) VALUES (1, 1, 1, 'hello from before the upgrade')`); err != nil {
		t.Fatalf("seed message: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO voice_states (user_id, channel_id, muted, deafened) VALUES (1, 1, 1, 0)`); err != nil {
		t.Fatalf("seed voice_states: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO emoji (id, shortcode, filename, uploaded_by) VALUES (1, 'partyparrot', 'stored-uuid', 1)`); err != nil {
		t.Fatalf("seed emoji: %v", err)
	}

	// Apply the remaining migrations (020..028) via the real production path.
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() upgrading from 019 to head: %v", err)
	}

	// Every pre-existing row must still be present.
	for _, tc := range []struct {
		query string
		args  []any
		desc  string
	}{
		{"SELECT 1 FROM roles WHERE id = ?", []any{5}, "custom role"},
		{"SELECT 1 FROM users WHERE id = ?", []any{1}, "user"},
		{"SELECT 1 FROM channels WHERE id = ?", []any{1}, "channel"},
		{"SELECT 1 FROM messages WHERE id = ?", []any{1}, "message"},
		{"SELECT 1 FROM voice_states WHERE user_id = ?", []any{1}, "voice_states"},
		{"SELECT 1 FROM emoji WHERE id = ?", []any{1}, "emoji"},
	} {
		var one int
		if err := database.QueryRowContext(ctx, tc.query, tc.args...).Scan(&one); err != nil {
			t.Errorf("%s row did not survive the upgrade: %v", tc.desc, err)
		}
	}

	// New columns on the surviving rows must carry the documented defaults,
	// not be silently backfilled with something else.
	var nsfw, isGroup int
	if err := database.QueryRowContext(ctx,
		`SELECT nsfw, is_group FROM channels WHERE id = 1`).Scan(&nsfw, &isGroup); err != nil {
		t.Fatalf("reading upgraded channel: %v", err)
	}
	if nsfw != 0 {
		t.Errorf("channels.nsfw = %d for pre-existing channel, want 0", nsfw)
	}
	if isGroup != 0 {
		t.Errorf("channels.is_group = %d for pre-existing channel, want 0", isGroup)
	}

	var displayName, about, customStatus *string
	if err := database.QueryRowContext(ctx,
		`SELECT display_name, about, custom_status FROM users WHERE id = 1`).Scan(&displayName, &about, &customStatus); err != nil {
		t.Fatalf("reading upgraded user: %v", err)
	}
	if displayName != nil || about != nil || customStatus != nil {
		t.Errorf("upgraded user gained non-NULL profile fields: display_name=%v about=%v custom_status=%v",
			displayName, about, customStatus)
	}

	var serverMuted, serverDeafened int
	if err := database.QueryRowContext(ctx,
		`SELECT server_muted, server_deafened FROM voice_states WHERE user_id = 1`).Scan(&serverMuted, &serverDeafened); err != nil {
		t.Fatalf("reading upgraded voice_states: %v", err)
	}
	if serverMuted != 0 || serverDeafened != 0 {
		t.Errorf("voice_states gained non-zero server_muted/server_deafened: %d/%d", serverMuted, serverDeafened)
	}

	var mimeType string
	if err := database.QueryRowContext(ctx,
		`SELECT mime_type FROM emoji WHERE id = 1`).Scan(&mimeType); err != nil {
		t.Fatalf("reading upgraded emoji: %v", err)
	}
	if mimeType != "image/png" {
		t.Errorf("emoji.mime_type = %q for pre-existing row, want the migration's documented default %q", mimeType, "image/png")
	}

	var mentionsEveryone int
	if err := database.QueryRowContext(ctx,
		`SELECT mentions_everyone FROM messages WHERE id = 1`).Scan(&mentionsEveryone); err != nil {
		t.Fatalf("reading upgraded message: %v", err)
	}
	if mentionsEveryone != 0 {
		t.Errorf("messages.mentions_everyone = %d for pre-existing message, want 0", mentionsEveryone)
	}

	// The custom role (id 5, not in the seeded 1-3 set) must NOT have gained
	// MENTION_EVERYONE — migration 022 only updates roles 1-3.
	const mentionEveryone = int64(0x200000)
	var perms int64
	if err := database.QueryRowContext(ctx, `SELECT permissions FROM roles WHERE id = 5`).Scan(&perms); err != nil {
		t.Fatalf("reading upgraded custom role: %v", err)
	}
	if perms&mentionEveryone != 0 {
		t.Errorf("custom role id=5 gained MENTION_EVERYONE from the upgrade (perms=0x%X), want unchanged", perms)
	}

	// New tables introduced by 022/024 must now exist and be queryable.
	for _, tbl := range []string{"message_mentions", "channel_user_overrides"} {
		if !tableExists(t, database, tbl) {
			t.Errorf("table %q missing after upgrade", tbl)
		}
	}

	// Every migration file, old and new, must be recorded — this is the
	// upgrade path's real contract: 001..019 came from the seed/normal path
	// during the first MigrateFS call, 020..028 from the second.
	all, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("reading embedded migrations dir: %v", err)
	}
	for _, e := range all {
		if !hasVersion(t, database, e.Name()) {
			t.Errorf("migration %q not recorded in schema_versions after upgrade", e.Name())
		}
	}
}
