package db

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/rollback"
)

func TestRollback071_Rehearsal(t *testing.T) {
	database := openMigratedMemoryInternal(t)
	ctx := context.Background()
	count := func(q string) int {
		t.Helper()
		var n int
		if err := database.QueryRowContext(ctx, q).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
	u, err := database.CreateUser(ctx, "ra", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	ch, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	msg, err := database.CreateMessage(ctx, ch, u, "kept", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO message_forwards (message_id, source_message_id, source_channel_id, source_timestamp) VALUES (?, NULL, ?, 't')`,
		msg, ch); err != nil {
		t.Fatal(err)
	}
	raw, err := rollback.FS.ReadFile("071_message_forwards.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range splitStatements(string(raw)) {
		if sqlText(stmt) == "" {
			continue
		}
		if _, err := database.ExecContext(ctx, stmt); err != nil {
			t.Fatalf("reversal statement %q: %v", stmt, err)
		}
	}
	if n := count(`SELECT COUNT(*) FROM sqlite_master WHERE name IN ('message_forwards','idx_message_forwards_source')`); n != 0 {
		t.Errorf("%d objects survived the reversal", n)
	}
	if n := count(`SELECT COUNT(*) FROM schema_versions WHERE version = '071_message_forwards.sql'`); n != 0 {
		t.Errorf("schema_versions row survived the reversal")
	}
	// The forward stays as an ordinary message.
	if n := count(`SELECT COUNT(*) FROM messages WHERE content = 'kept'`); n != 1 {
		t.Errorf("the message did not survive the reversal")
	}
}
