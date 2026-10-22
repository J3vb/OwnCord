package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// Migration 060 adds message_mentions.reply_ping. A mention row written before
// it ran was never a reply ping, so it must read back as 0.
func TestMigrate_060ReplyPingDefaultsToZeroOnExistingRows(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()

	if err := db.MigrateFS(database, migrationsUpTo(t, "060_")); err != nil {
		t.Fatalf("MigrateFS() building pre-060 schema: %v", err)
	}
	if columnExists(t, database, "message_mentions", "reply_ping") {
		t.Fatal("reply_ping exists before migration 060 ran")
	}
	for _, stmt := range []string{
		`INSERT INTO users (id, username, password, role_id) VALUES (1, 'alice', 'hash', 4), (2, 'bob', 'hash', 4)`,
		`INSERT INTO channels (id, name, type) VALUES (1, 'general', 'text')`,
		`INSERT INTO messages (id, channel_id, user_id, content) VALUES (1, 1, 1, 'hi @bob')`,
		`INSERT INTO message_mentions (message_id, mentioned_user_id) VALUES (1, 2)`,
	} {
		if _, err := database.ExecContext(ctx, stmt); err != nil {
			t.Fatalf("seed %q: %v", stmt, err)
		}
	}

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() applying 060: %v", err)
	}
	if !columnExists(t, database, "message_mentions", "reply_ping") {
		t.Fatal("reply_ping missing after migration 060")
	}
	var flag int
	if err := database.QueryRowContext(ctx,
		`SELECT reply_ping FROM message_mentions WHERE message_id = 1 AND mentioned_user_id = 2`).Scan(&flag); err != nil {
		t.Fatalf("read reply_ping: %v", err)
	}
	if flag != 0 {
		t.Errorf("reply_ping on a pre-existing row = %d, want 0", flag)
	}
}
