package db

import (
	"context"
	"io/fs"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/migrations"
)

// Migration 042 moves the actor-side tokens migration 038 wrote into
// subject_token over to the actor_token column 041 added, where the target
// is not an erased user; a row with both sides at 0 keeps its token on both
// sides, except the replay row, whose actor is the server. Run against rows
// in 038's representation on a migrated database, with the statements taken
// from the migration file itself.
func TestMigration042_BackfillsLegacyActorTokens(t *testing.T) {
	database := openMigratedMemoryInternal(t)
	ctx := context.Background()
	raw, err := fs.ReadFile(migrations.FS, "042_audit_actor_token_backfill.sql")
	if err != nil {
		t.Fatal(err)
	}
	rows := []struct {
		actor, target int64
		ttype, action string
		token         string
	}{
		{0, 5, "channel", "channel_create", "tok-a"},
		{0, 9, "user", "user_ban", "tok-a"},
		{0, 0, "user", "account_deleted", "tok-a"},
		{0, 0, "user", "user_login", "tok-a"},
		{0, 0, "user", "account_erasure_replayed", "tok-a"},
		{7, 0, "user", "user_kick", "tok-b"},
		{7, 8, "user", "role_change", ""},
	}
	for _, r := range rows {
		if _, err := database.writer.ExecContext(ctx,
			`INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, subject_token) VALUES (?, ?, ?, ?, '', NULLIF(?, ''))`,
			r.actor, r.action, r.ttype, r.target, r.token); err != nil {
			t.Fatal(err)
		}
	}
	updates := 0
	for _, stmt := range splitStatements(string(raw)) {
		if !strings.Contains(strings.ToUpper(stmt), "UPDATE AUDIT_LOG") {
			continue
		}
		if _, err := database.writer.ExecContext(ctx, stmt); err != nil {
			t.Fatalf("backfill statement: %v\n%s", err, stmt)
		}
		updates++
	}
	if updates != 2 {
		t.Fatalf("backfill statements run = %d, want 2", updates)
	}
	want := map[string][2]string{ // action -> actor_token, subject_token ("" for NULL)
		"channel_create":           {"tok-a", ""},
		"user_ban":                 {"tok-a", ""},
		"account_deleted":          {"tok-a", "tok-a"},
		"user_login":               {"tok-a", "tok-a"},
		"account_erasure_replayed": {"", "tok-a"},
		"user_kick":                {"", "tok-b"},
		"role_change":              {"", ""},
	}
	for action, tokens := range want {
		var actorTok, subjectTok string
		if err := database.reader.QueryRowContext(ctx,
			`SELECT COALESCE(actor_token, ''), COALESCE(subject_token, '') FROM audit_log WHERE action = ?`, action).Scan(&actorTok, &subjectTok); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
		if actorTok != tokens[0] || subjectTok != tokens[1] {
			t.Errorf("%s: actor token %q subject token %q; want %q %q", action, actorTok, subjectTok, tokens[0], tokens[1])
		}
	}
}
