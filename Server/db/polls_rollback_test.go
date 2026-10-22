package db

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/rollback"
)

func TestRollback073_Rehearsal(t *testing.T) {
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
	for _, q := range []string{
		`INSERT INTO polls (message_id, question, expires_at) VALUES (?1, 'q', '2999-01-01T00:00:00Z')`,
		`INSERT INTO poll_answers (message_id, answer_id, text) VALUES (?1, 1, 'a')`,
		`INSERT INTO poll_votes (message_id, answer_id, user_id) VALUES (?1, 1, ?2)`,
	} {
		if _, err := database.ExecContext(ctx, q, msg, u); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	raw, err := rollback.FS.ReadFile("073_polls.down.sql")
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
	if n := count(`SELECT COUNT(*) FROM sqlite_master WHERE name IN ('polls','poll_answers','poll_votes','idx_polls_open_expiry','idx_poll_votes_user')`); n != 0 {
		t.Errorf("%d objects survived the reversal", n)
	}
	if n := count(`SELECT COUNT(*) FROM schema_versions WHERE version = '073_polls.sql'`); n != 0 {
		t.Errorf("schema_versions row survived the reversal")
	}
	if n := count(`SELECT COUNT(*) FROM messages WHERE content = 'kept'`); n != 1 {
		t.Errorf("the message did not survive the reversal")
	}
}
