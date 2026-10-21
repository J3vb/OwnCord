package db

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/rollback"
)

// TestRollback073_Rehearsal reverses migration 073 on a database holding a
// thread: the thread row and its messages go, the parent and its own messages
// stay, and type 'thread' is refused again. It runs with foreign keys off, as
// the sqlite3 shell runs a reversal, so nothing may depend on a cascade.
func TestRollback073_Rehearsal(t *testing.T) {
	database := openMigratedMemoryInternal(t)
	ctx := context.Background()
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := database.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
	u, err := database.CreateUser(ctx, "rt", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	starter, err := database.CreateMessage(ctx, parent, u, "kept", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := database.ExecContext(ctx,
		`INSERT INTO channels (name, type, parent_channel_id, thread_starter_message_id) VALUES ('t', 'thread', ?, ?)`,
		parent, starter)
	if err != nil {
		t.Fatal(err)
	}
	thread, _ := res.LastInsertId()
	inThread, err := database.CreateMessage(ctx, thread, u, "in thread", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, 'x')`, inThread, u); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO read_states (user_id, channel_id, last_message_id) VALUES (?, ?, ?)`, u, thread, inThread); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateAttachment(ctx, "att-rb", u, "a.png", "a.png", "image/png", 1, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := database.LinkAttachmentsToMessage(ctx, inThread, u, []string{"att-rb"}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.writer.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = database.writer.Exec(`PRAGMA foreign_keys = ON`) })

	raw, err := rollback.FS.ReadFile("073_threads.down.sql")
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
	if n := count(`SELECT COUNT(*) FROM pragma_table_info('channels') WHERE name LIKE 'thread_%' OR name = 'parent_channel_id'`); n != 0 {
		t.Errorf("%d thread columns survived the reversal", n)
	}
	if n := count(`SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'idx_channels_thread%' OR name = 'idx_channels_parent' OR name LIKE 'trg_channels_thread%'`); n != 0 {
		t.Errorf("%d thread objects survived the reversal", n)
	}
	if n := count(`SELECT COUNT(*) FROM schema_versions WHERE version = '073_threads.sql'`); n != 0 {
		t.Error("schema_versions row survived the reversal")
	}
	if n := count(`SELECT COUNT(*) FROM channels WHERE id = ?`, thread); n != 0 {
		t.Error("the thread row survived the reversal")
	}
	if n := count(`SELECT COUNT(*) FROM messages WHERE content = 'in thread'`); n != 0 {
		t.Error("a thread message survived the reversal")
	}
	if n := count(`SELECT COUNT(*) FROM messages WHERE content = 'kept'`); n != 1 {
		t.Error("the parent's message did not survive the reversal")
	}
	if n := count(`SELECT COUNT(*) FROM pragma_foreign_key_check`); n != 0 {
		t.Errorf("foreign_key_check reports %d violations after the reversal", n)
	}
	if n := count(`SELECT COUNT(*) FROM attachments WHERE id = 'att-rb' AND message_id IS NULL`); n != 1 {
		t.Error("the thread message's attachment was not unlinked")
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO channels (name, type) VALUES ('x', 'thread')`); err == nil {
		t.Error("type 'thread' accepted after the reversal")
	}
}
