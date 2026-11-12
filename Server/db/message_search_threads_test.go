package db_test

import (
	"context"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func seedThreadRow(t *testing.T, database *db.DB, parent int64, name string) int64 {
	t.Helper()
	res, err := database.ExecContext(context.Background(),
		`INSERT INTO channels (name, type, parent_channel_id) VALUES (?, 'thread', ?)`, name, parent)
	if err != nil {
		t.Fatalf("seed thread: %v", err)
	}
	id, err := res.LastInsertId()
	mustDo(t, "LastInsertId", err)
	return id
}

// The threads under the scope ride in SQL, so a parent with far more threads than SQLite's bound-parameter
// limit still searches, and the hit names its parent.
func TestSearchFiltered_ThreadsExpandedInSQL(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	u := seedUser(t, database, "tu")
	parent, other := seedChannel(t, database, "parent"), seedChannel(t, database, "other")
	last := seedThreadRow(t, database, parent, "t-last")
	if _, err := database.ExecContext(ctx, `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 40000)
		INSERT INTO channels (name, type, parent_channel_id) SELECT 't' || i, 'thread', ? FROM s`, parent); err != nil {
		t.Fatalf("seed threads: %v", err)
	}
	inThread := mustCreateMessage(t, database, last, u, "needle in thread", nil)
	top := mustCreateMessage(t, database, parent, u, "needle top level", nil)
	_ = mustCreateMessage(t, database, seedThreadRow(t, database, other, "elsewhere"), u, "needle elsewhere", nil)

	got, err := database.SearchMessagesFiltered(ctx, db.SearchQuery{Text: "needle", ChannelIDs: []int64{parent}},
		db.SearchPage{Limit: 10, Recent: true})
	mustDo(t, "SearchMessagesFiltered", err)
	if want := []int64{top, inThread}; !slices.Equal(resultIDs(got), want) {
		t.Fatalf("ids = %v, want %v", resultIDs(got), want)
	}
	for i := range got {
		wantParent := int64(0)
		if got[i].MessageID == inThread {
			wantParent = parent
		}
		if got[i].ThreadParentID != wantParent {
			t.Errorf("message %d: ThreadParentID = %d, want %d", got[i].MessageID, got[i].ThreadParentID, wantParent)
		}
	}
}

// With an imported channel in scope the date bound skips only that channel: the threads of a native parent
// keep the id range and still match.
func TestSearchFiltered_ThreadsWithDateBoundAndImportedScope(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	u := seedUser(t, database, "tu2")
	native, imported := seedChannel(t, database, "native"), seedChannel(t, database, "imported")
	if _, err := database.ExecContext(ctx, `INSERT INTO import_jobs (channel_id) VALUES (?)`, imported); err != nil {
		t.Fatalf("seed import job: %v", err)
	}
	thread := seedThreadRow(t, database, native, "nt")
	old := seedStamped(t, database, thread, u, "needle thread old", "2026-01-01 10:00:00")
	inThread := seedStamped(t, database, thread, u, "needle thread", "2026-05-01 10:00:00")
	inImported := seedStamped(t, database, imported, u, "needle imported", "2026-05-01 11:00:00")

	got, err := database.SearchMessagesFiltered(ctx, db.SearchQuery{
		Text: "needle", ChannelIDs: []int64{native, imported}, AfterTS: "2026-03-01 00:00:00",
	}, db.SearchPage{Limit: 10, Recent: true})
	mustDo(t, "SearchMessagesFiltered", err)
	want := []int64{inImported, inThread}
	slices.Sort(want)
	slices.Reverse(want)
	if !slices.Equal(resultIDs(got), want) || slices.Contains(resultIDs(got), old) {
		t.Errorf("ids = %v, want %v", resultIDs(got), want)
	}

	// Only the imported parent in scope: the native parent's thread stays out.
	got, err = database.SearchMessagesFiltered(ctx, db.SearchQuery{
		Text: "needle", ChannelIDs: []int64{imported}, AfterTS: "2026-03-01 00:00:00",
	}, db.SearchPage{Limit: 10, Recent: true})
	mustDo(t, "SearchMessagesFiltered", err)
	if !slices.Equal(resultIDs(got), []int64{inImported}) {
		t.Errorf("imported-only ids = %v, want %v", resultIDs(got), []int64{inImported})
	}
}
