package db_test

import (
	"context"
	"path/filepath"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// History pages of every size share a few cached statements: the IN lists
// bind one JSON array or are padded to a size bucket. A query that put each
// page size into its own SQL text would fill the cache, and the second sweep
// would add entries.
func TestHistoryPages_StatementCacheStaysSmall(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	userID := seedUser(t, database, "pager")
	chID := mustCreateChannel(t, database, "paged", "text", "", "", 0)
	for i := range 120 {
		id := mustCreateMessage(t, database, chID, userID, "row", nil)
		if i%5 == 0 {
			mustDo(t, "AddReaction", database.AddReaction(ctx, id, userID, "👍"))
		}
	}
	sweep := func() {
		for limit := 1; limit <= 100; limit++ {
			msgs, err := database.GetMessagesForAPI(ctx, chID, 0, limit, userID)
			if err != nil {
				t.Fatalf("GetMessagesForAPI(limit %d): %v", limit, err)
			}
			if len(msgs) != limit {
				t.Fatalf("GetMessagesForAPI(limit %d) returned %d rows", limit, len(msgs))
			}
		}
	}
	sweep()
	after := db.ReadStmtCountForTest(database)
	if after == 0 || after > 64 {
		t.Errorf("cached statements after 100 page sizes = %d, want 1..64", after)
	}
	sweep()
	if again := db.ReadStmtCountForTest(database); again != after {
		t.Errorf("a second sweep grew the cache from %d to %d", after, again)
	}
}

// Readers on several pool connections share the cached statements while a
// writer keeps adding rows; run with -race.
func TestHistoryPages_ConcurrentReadersShareCache(t *testing.T) {
	database, err := db.Open(filepath.Join(t.TempDir(), "cache.db"))
	mustDo(t, "Open", err)
	t.Cleanup(func() { _ = database.Close() })
	mustDo(t, "Migrate", db.Migrate(database))
	ctx := context.Background()
	userID := seedUser(t, database, "reader")
	chID := mustCreateChannel(t, database, "shared", "text", "", "", 0)
	for range 60 {
		mustCreateMessage(t, database, chID, userID, "seed", nil)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for r := range 6 {
		wg.Add(1)
		go func(limit int) {
			defer wg.Done()
			for range 30 {
				msgs, err := database.GetMessagesForAPI(ctx, chID, 0, limit, userID)
				if err != nil {
					errs <- err
					return
				}
				if len(msgs) != limit {
					t.Errorf("limit %d returned %d rows", limit, len(msgs))
					return
				}
			}
		}(10 + r*7)
	}
	wg.Go(func() {
		for range 30 {
			if _, err := database.CreateMessage(ctx, chID, userID, "live", nil); err != nil {
				errs <- err
				return
			}
		}
	})
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent page: %v", err)
	}
}
