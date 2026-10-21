package db_test

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func scalarInt(t *testing.T, database *db.DB, q string, args ...any) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return n
}

func TestMigration069_ColumnsTableTrigger(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	for _, col := range []string{"banner_id", "banner_color"} {
		if n := scalarInt(t, database, `SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = ?`, col); n != 1 {
			t.Errorf("users.%s missing", col)
		}
	}
	if n := scalarInt(t, database, `SELECT COUNT(*) FROM pragma_table_info('user_notes')`); n != 4 {
		t.Errorf("user_notes columns = %d, want 4", n)
	}
	for _, idx := range []string{"idx_users_banner_id", "idx_user_notes_target"} {
		if n := scalarInt(t, database, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name = ?`, idx); n != 1 {
			t.Errorf("index %s missing", idx)
		}
	}
	var trig string
	if err := database.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='member_generation_users_update'`).Scan(&trig); err != nil {
		t.Fatalf("trigger lookup: %v", err)
	}
	for _, col := range []string{"banner_id", "banner_color"} {
		if strings.Count(trig, col) < 2 {
			t.Errorf("trigger must name %s in UPDATE OF and WHEN", col)
		}
	}
	uid := seedUser(t, database, "bannered")
	gen := func() int { return scalarInt(t, database, `SELECT generation FROM member_generation WHERE id = 1`) }
	before := gen()
	execAll(t, database, `UPDATE users SET banner_color = '#aabbcc' WHERE id = `+strconv.FormatInt(uid, 10))
	if gen() == before {
		t.Error("a banner_color write did not move the member generation")
	}
}

func TestUserNoteQueries_UpsertGetDeleteScoped(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	a, b, c := seedUser(t, database, "na"), seedUser(t, database, "nb"), seedUser(t, database, "nc")
	if ok, err := database.UpsertUserNote(ctx, a, c, "from a"); err != nil || !ok {
		t.Fatalf("upsert: ok=%v err=%v", ok, err)
	}
	if ok, err := database.UpsertUserNote(ctx, a, c, "from a again"); err != nil || !ok {
		t.Fatalf("upsert again: ok=%v err=%v", ok, err)
	}
	if got, _ := database.GetUserNote(ctx, a, c); got != "from a again" {
		t.Errorf("a's note = %q", got)
	}
	if got, err := database.GetUserNote(ctx, b, c); err != nil || got != "" {
		t.Errorf("b's note about c = %q, %v; want empty", got, err)
	}
	if ok, err := database.UpsertUserNote(ctx, a, 99999, "x"); err != nil || ok {
		t.Errorf("upsert for missing target: ok=%v err=%v, want false", ok, err)
	}
	if err := database.DeleteUserNote(ctx, a, c); err != nil {
		t.Fatal(err)
	}
	if got, _ := database.GetUserNote(ctx, a, c); got != "" {
		t.Errorf("note after delete = %q", got)
	}
}
