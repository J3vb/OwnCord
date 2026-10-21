package db

import (
	"context"
	"fmt"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/J3vb/OwnCord/Server/migrations"
	"github.com/J3vb/OwnCord/Server/rollback"
)

// schemaSnapshot describes every schema object of database in a form that
// survives ALTER TABLE rewriting the stored text: a table is its column list,
// everything else is its whitespace-normalised SQL.
func schemaSnapshot(t *testing.T, database *DB) map[string]string {
	t.Helper()
	ctx := context.Background()
	rows, err := database.QueryContext(ctx, `SELECT type, name, COALESCE(sql, '') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type obj struct{ typ, name, sql string }
	var objs []obj
	for rows.Next() {
		var o obj
		if err := rows.Scan(&o.typ, &o.name, &o.sql); err != nil {
			t.Fatal(err)
		}
		objs = append(objs, o)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	out := make(map[string]string, len(objs))
	for _, o := range objs {
		if o.typ != "table" {
			out[o.typ+" "+o.name] = strings.Join(strings.Fields(o.sql), " ")
			continue
		}
		cols, err := database.QueryContext(ctx, fmt.Sprintf(`SELECT name, type, "notnull", COALESCE(dflt_value, ''), pk FROM pragma_table_info('%s') ORDER BY cid`, o.name))
		if err != nil {
			t.Fatal(err)
		}
		var parts []string
		for cols.Next() {
			var name, typ, dflt string
			var notnull, pk int
			if err := cols.Scan(&name, &typ, &notnull, &dflt, &pk); err != nil {
				t.Fatal(err)
			}
			parts = append(parts, fmt.Sprintf("%s %s %d %q %d", name, typ, notnull, dflt, pk))
		}
		_ = cols.Close()
		out["table "+o.name] = strings.Join(parts, "; ")
	}
	return out
}

// TestForumsRollback runs 075's reversal on a database holding a forum, its
// tags, a post and the post's messages. The schema must equal the one a
// database that never ran 075 has, the forum side must be gone, and the text
// channel with its thread must be untouched. It runs with foreign keys off,
// as the sqlite3 shell runs a reversal, so nothing may depend on a cascade.
func TestForumsRollback(t *testing.T) {
	ctx := context.Background()

	// The baseline: every migration except 075.
	without075 := fstest.MapFS{}
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".sql") || e.Name() == "075_forums.sql" {
			continue
		}
		raw, err := fs.ReadFile(migrations.FS, e.Name())
		if err != nil {
			t.Fatal(err)
		}
		without075[e.Name()] = &fstest.MapFile{Data: raw}
	}
	base, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = base.Close() })
	if err := MigrateFS(base, without075); err != nil {
		t.Fatal(err)
	}
	want := schemaSnapshot(t, base)

	database := openMigratedMemoryInternal(t)
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := database.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
	u, err := database.CreateUser(ctx, "rf", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	text, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	starter, err := database.CreateMessage(ctx, text, u, "kept", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := database.ExecContext(ctx, `INSERT INTO channels (name, type, parent_channel_id, thread_starter_message_id) VALUES ('t', 'thread', ?, ?)`, text, starter)
	if err != nil {
		t.Fatal(err)
	}
	textThread, _ := res.LastInsertId()
	kept, err := database.CreateMessage(ctx, textThread, u, "kept in a text thread", nil)
	if err != nil {
		t.Fatal(err)
	}
	forum, err := database.CreateChannel(ctx, "ideas", "forum", "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	tags, err := database.ReplaceForumSettings(ctx, forum, ForumSettingsWrite{RequireTag: true, DefaultAutoArchiveMinutes: 60, Tags: []ForumTagWrite{{Name: "bug"}}})
	if err != nil {
		t.Fatal(err)
	}
	res, err = database.ExecContext(ctx, `INSERT INTO channels (name, type, parent_channel_id, thread_owner_id) VALUES ('post', 'thread', ?, ?)`, forum, u)
	if err != nil {
		t.Fatal(err)
	}
	post, _ := res.LastInsertId()
	opening, err := database.CreateMessage(ctx, post, u, "opening message", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`UPDATE channels SET thread_post_message_id = ?1 WHERE id = ?2`,
		`INSERT INTO reactions (message_id, user_id, emoji) VALUES (?1, ?3, 'x')`,
		`INSERT INTO read_states (user_id, channel_id, last_message_id) VALUES (?3, ?2, ?1)`,
	} {
		if _, err := database.ExecContext(ctx, q, opening, post, u); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO thread_tags (thread_id, tag_id) VALUES (?, ?)`, post, tags[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateAttachment(ctx, "att-forum", u, "a.png", "a.png", "image/png", 1, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := database.LinkAttachmentsToMessage(ctx, opening, u, []string{"att-forum"}); err != nil {
		t.Fatal(err)
	}

	if _, err := database.writer.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = database.writer.Exec(`PRAGMA foreign_keys = ON`) })
	raw, err := rollback.FS.ReadFile("075_forums.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range splitStatements(string(raw)) {
		if sqlText(stmt) == "" {
			continue
		}
		if _, err := database.writer.ExecContext(ctx, stmt); err != nil {
			t.Fatalf("reversal statement %q: %v", stmt, err)
		}
	}

	got := schemaSnapshot(t, database)
	for k, w := range want {
		if g, ok := got[k]; !ok {
			t.Errorf("%s is missing after the reversal", k)
		} else if g != w {
			t.Errorf("%s differs after the reversal:\n got  %s\n want %s", k, g, w)
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok && k != "table schema_versions" {
			t.Errorf("%s survived the reversal", k)
		}
	}
	if n := count(`SELECT COUNT(*) FROM schema_versions WHERE version = '075_forums.sql'`); n != 0 {
		t.Error("schema_versions row survived the reversal")
	}
	for name, id := range map[string]int64{"forum": forum, "post": post} {
		if n := count(`SELECT COUNT(*) FROM channels WHERE id = ?`, id); n != 0 {
			t.Errorf("the %s row survived the reversal", name)
		}
	}
	if n := count(`SELECT COUNT(*) FROM messages WHERE content = 'opening message'`); n != 0 {
		t.Error("the post's opening message survived the reversal")
	}
	if n := count(`SELECT COUNT(*) FROM reactions WHERE message_id = ?`, opening); n != 0 {
		t.Error("a reaction on the opening message survived the reversal")
	}
	if n := count(`SELECT COUNT(*) FROM attachments WHERE id = 'att-forum' AND message_id IS NULL`); n != 1 {
		t.Error("the opening message's attachment was not unlinked")
	}
	if n := count(`SELECT COUNT(*) FROM channels WHERE id IN (?, ?)`, text, textThread); n != 2 {
		t.Error("the text channel or its thread did not survive the reversal")
	}
	if n := count(`SELECT COUNT(*) FROM messages WHERE id IN (?, ?)`, starter, kept); n != 2 {
		t.Error("a message outside the forum did not survive the reversal")
	}
	if n := count(`SELECT COUNT(*) FROM pragma_foreign_key_check`); n != 0 {
		t.Errorf("foreign_key_check reports %d violations after the reversal", n)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO channels (name, type) VALUES ('x', 'forum')`); err == nil {
		t.Error("type 'forum' accepted after the reversal")
	}
}
