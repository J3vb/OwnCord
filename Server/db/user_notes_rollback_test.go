package db

import (
	"context"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/rollback"
)

func TestRollback069_Rehearsal(t *testing.T) {
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
	a, err := database.CreateUser(ctx, "ra", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	b, err := database.CreateUser(ctx, "rb", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.UpsertUserNote(ctx, a, b, "private"); err != nil {
		t.Fatal(err)
	}
	raw, err := rollback.FS.ReadFile("069_profile_notes_banners.down.sql")
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
	if n := count(`SELECT COUNT(*) FROM sqlite_master WHERE name IN ('user_notes','idx_users_banner_id','idx_user_notes_target')`); n != 0 {
		t.Errorf("%d objects survived the reversal", n)
	}
	if n := count(`SELECT COUNT(*) FROM pragma_table_info('users') WHERE name LIKE 'banner_%'`); n != 0 {
		t.Errorf("banner columns survived the reversal")
	}
	if n := count(`SELECT COUNT(*) FROM schema_versions WHERE version = '069_profile_notes_banners.sql'`); n != 0 {
		t.Errorf("schema_versions row survived the reversal")
	}
	var trig string
	if err := database.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='member_generation_users_update'`).Scan(&trig); err != nil {
		t.Fatalf("061 trigger not restored: %v", err)
	}
	if strings.Contains(trig, "banner") {
		t.Errorf("restored trigger still names banner columns")
	}
	if err := Migrate(database); err != nil {
		t.Fatalf("re-migrate after reversal: %v", err)
	}
	if n := count(`SELECT COUNT(*) FROM user_notes`); n != 0 {
		t.Errorf("notes after re-migrate = %d, want 0", n)
	}
}
