package db_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// seedStamped inserts a message and pins its stored timestamp.
func seedStamped(t *testing.T, database *db.DB, ch, user int64, content, ts string) int64 {
	t.Helper()
	id, err := database.CreateMessage(context.Background(), ch, user, content, nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := database.ExecContext(context.Background(), `UPDATE messages SET timestamp = ? WHERE id = ?`, ts, id); err != nil {
		t.Fatalf("set timestamp: %v", err)
	}
	return id
}

func resultIDs(rs []db.MessageSearchResult) []int64 {
	ids := make([]int64, len(rs))
	for i := range rs {
		ids[i] = rs[i].MessageID
	}
	return ids
}

func TestSearchFiltered_AuthorOrAndChannelAnd(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	a, b, c := seedUser(t, database, "fa"), seedUser(t, database, "fb"), seedUser(t, database, "fc")
	ch1, ch2 := seedChannel(t, database, "one"), seedChannel(t, database, "two")
	ma, _ := database.CreateMessage(ctx, ch1, a, "needle from a", nil)
	mb, _ := database.CreateMessage(ctx, ch1, b, "needle from b", nil)
	_, _ = database.CreateMessage(ctx, ch1, c, "needle from c", nil)
	_, _ = database.CreateMessage(ctx, ch2, a, "needle other channel", nil)

	got, err := database.SearchMessagesFiltered(ctx, db.SearchQuery{
		Text: "needle", ChannelIDs: []int64{ch1}, AuthorIDs: []int64{a, b},
	}, db.SearchPage{Limit: 10, Recent: true})
	if err != nil {
		t.Fatal(err)
	}
	if want := []int64{mb, ma}; !slices.Equal(resultIDs(got), want) {
		t.Errorf("ids = %v, want %v", resultIDs(got), want)
	}
}

func TestSearchFiltered_NoWordsNewestFirstWithCursor(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	u, other := seedUser(t, database, "np"), seedUser(t, database, "npo")
	ch := seedChannel(t, database, "paged")
	mine := make([]int64, 0, 7)
	for i := range 7 {
		id, _ := database.CreateMessage(ctx, ch, u, fmt.Sprintf("m%d", i), nil)
		mine = append(mine, id)
		_, _ = database.CreateMessage(ctx, ch, other, "noise", nil)
	}
	slices.Reverse(mine)

	var got []int64
	q := db.SearchQuery{ChannelIDs: []int64{ch}, AuthorIDs: []int64{u}}
	page := db.SearchPage{Limit: 3}
	for range 5 {
		rs, err := database.SearchMessagesFiltered(ctx, q, page)
		if err != nil {
			t.Fatal(err)
		}
		if len(rs) == 0 {
			break
		}
		got = append(got, resultIDs(rs)...)
		page.Before = rs[len(rs)-1].MessageID
	}
	if !slices.Equal(got, mine) {
		t.Errorf("paged ids = %v, want %v (no repeat, no skip)", got, mine)
	}
}

func TestSearchFiltered_DateBoundsExclusive(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	u := seedUser(t, database, "dt")
	ch := seedChannel(t, database, "dates")
	before := seedStamped(t, database, ch, u, "stamp", "2026-03-09 23:59:59")
	start := seedStamped(t, database, ch, u, "stamp", "2026-03-10 00:00:00")
	end := seedStamped(t, database, ch, u, "stamp", "2026-03-10 23:59:59")
	next := seedStamped(t, database, ch, u, "stamp", "2026-03-11 00:00:00")

	run := func(after, before string) []int64 {
		t.Helper()
		rs, err := database.SearchMessagesFiltered(ctx, db.SearchQuery{
			ChannelIDs: []int64{ch}, AfterTS: after, BeforeTS: before,
		}, db.SearchPage{Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		return resultIDs(rs)
	}
	if got, want := run("2026-03-10 00:00:00", "2026-03-11 00:00:00"), []int64{end, start}; !slices.Equal(got, want) {
		t.Errorf("during = %v, want %v", got, want)
	}
	if got, want := run("", "2026-03-10 00:00:00"), []int64{before}; !slices.Equal(got, want) {
		t.Errorf("before = %v, want %v", got, want)
	}
	if got, want := run("2026-03-11 00:00:00", ""), []int64{next}; !slices.Equal(got, want) {
		t.Errorf("after = %v, want %v", got, want)
	}
}

func TestFirstIDAtOrAfter_GapsAndEmptyTable(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	if id, err := database.FirstIDAtOrAfterForTest(ctx, "2026-01-01 00:00:00"); err != nil || id != 0 {
		t.Fatalf("empty table = %d, %v; want 0, nil", id, err)
	}
	u := seedUser(t, database, "gp")
	ch := seedChannel(t, database, "gaps")
	ids := make([]int64, 0, 10)
	for i := range 10 {
		ids = append(ids, seedStamped(t, database, ch, u, "x", fmt.Sprintf("2026-01-%02d 12:00:00", i+1)))
	}
	// Hard-delete a run of rows in the middle.
	for _, id := range ids[3:6] {
		if _, err := database.ExecContext(ctx, `DELETE FROM messages WHERE id = ?`, id); err != nil {
			t.Fatal(err)
		}
	}
	tests := []struct{ ts string }{
		{"2025-12-31 00:00:00"}, {"2026-01-01 12:00:00"}, {"2026-01-02 00:00:00"},
		{"2026-01-04 12:00:00"}, {"2026-01-06 00:00:00"}, {"2026-01-10 12:00:01"},
	}
	for _, tc := range tests {
		got, err := database.FirstIDAtOrAfterForTest(ctx, tc.ts)
		if err != nil {
			t.Fatal(err)
		}
		// The boundary may sit anywhere inside an id gap, but it must split
		// the surviving rows exactly where the timestamp does.
		var below, older int
		_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE id < ?`, got).Scan(&below)
		_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE timestamp < ?`, tc.ts).Scan(&older)
		if below != older {
			t.Errorf("ts %s: boundary %d has %d rows below, want %d", tc.ts, got, below, older)
		}
	}
}

func TestSearchFiltered_RequiresScope(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	u := seedUser(t, database, "sc")
	ch := seedChannel(t, database, "scope")
	_, _ = database.CreateMessage(ctx, ch, u, "needle", nil)
	for _, q := range []db.SearchQuery{{Text: "needle"}, {AuthorIDs: []int64{u}}, {Text: "needle", ChannelIDs: []int64{}}} {
		rs, err := database.SearchMessagesFiltered(ctx, q, db.SearchPage{Limit: 10})
		if !errors.Is(err, db.ErrSearchUnscoped) || len(rs) != 0 {
			t.Errorf("%+v: got %v, %v; want ErrSearchUnscoped and no rows", q, rs, err)
		}
	}
}

func TestSearchFiltered_ValuesAreBound(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	u := seedUser(t, database, "bd")
	ch := seedChannel(t, database, "bound")
	_, _ = database.CreateMessage(ctx, ch, u, "needle", nil)
	for _, text := range []string{"'); DROP TABLE messages;--", `"`, "*", "NEAR(", ""} {
		_, err := database.SearchMessagesFiltered(ctx, db.SearchQuery{
			Text: text, ChannelIDs: []int64{ch}, AfterTS: "x' OR 1=1 --", BeforeTS: "2099-01-01 00:00:00",
		}, db.SearchPage{Limit: 10})
		if err != nil {
			t.Errorf("text %q: %v", text, err)
		}
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&n); err != nil || n != 1 {
		t.Errorf("messages count = %d, %v; want 1", n, err)
	}
}
