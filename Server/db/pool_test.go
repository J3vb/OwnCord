package db_test

// pool_test.go — file-backed reader/writer pool split tests.
//
// db.Open gives file-backed databases two pools: a single-connection writer
// and a multi-connection reader (see db.go). The per-connection PRAGMAs move
// into the DSN in that mode, because an Exec'd PRAGMA would only configure
// one arbitrary pooled connection. These tests pin the properties that split
// must preserve: foreign_keys=ON on every reader connection, WAL journaling,
// FK enforcement on the write path, and reads proceeding while a write
// transaction is open.

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/owncord/server/db"
)

// openFileDB opens a temp-file-backed database with the full embedded
// migration set applied.
func openFileDB(t *testing.T) *db.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "pool_test.db")
	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open(%q) error: %v", dbPath, err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}
	return database
}

// seedChannelAndUser creates one text channel and one member user for
// message-write tests, returning their IDs.
func seedChannelAndUser(t *testing.T, database *db.DB) (channelID, userID int64) {
	t.Helper()
	ctx := context.Background()
	channelID, err := database.AdminCreateChannel(ctx, "pool-test", "text", "", "", 99)
	if err != nil {
		t.Fatalf("AdminCreateChannel: %v", err)
	}
	userID, err = database.CreateUser(ctx, "pooluser", "x", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return channelID, userID
}

// TestFilePool_ForeignKeysOnReaderConnections asserts PRAGMA foreign_keys
// returns 1 on many reader-pool connections. The PRAGMA read routes to the
// reader pool, and the sequential + parallel mix below forces the pool to
// grow and to serve the checks from different physical connections — the
// regression this catches is the DSN `_pragma=` parameters being dropped,
// which would leave fresh pooled connections with foreign_keys=OFF.
func TestFilePool_ForeignKeysOnReaderConnections(t *testing.T) {
	database := openFileDB(t)
	ctx := context.Background()

	checkFK := func() error {
		var fk int
		if err := database.QueryRowContext(ctx, "PRAGMA foreign_keys;").Scan(&fk); err != nil {
			return fmt.Errorf("PRAGMA foreign_keys: %w", err)
		}
		if fk != 1 {
			return fmt.Errorf("foreign_keys = %d, want 1", fk)
		}
		return nil
	}

	// Sequential warm-up checks.
	for i := 0; i < 20; i++ {
		if err := checkFK(); err != nil {
			t.Fatalf("sequential check %d: %v", i, err)
		}
	}

	// Parallel: 16 goroutines interleaving reads and PRAGMA checks so the
	// pool opens multiple connections and the checks land on different ones.
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				var n int
				if err := database.QueryRowContext(ctx, "SELECT COUNT(*) FROM users").Scan(&n); err != nil {
					t.Errorf("read query: %v", err)
					return
				}
				if err := checkFK(); err != nil {
					t.Errorf("parallel check: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()

	// journal_mode must be WAL on the reader connections too.
	var mode string
	if err := database.QueryRowContext(ctx, "PRAGMA journal_mode;").Scan(&mode); err != nil {
		t.Fatalf("PRAGMA journal_mode: %v", err)
	}
	if mode != "wal" {
		t.Errorf("journal_mode = %q, want %q", mode, "wal")
	}
}

// TestFilePool_ConcurrentReadsAndWrites hammers the split with 8 writer
// goroutines (both the sqlc INSERT...RETURNING path, which travels through
// QueryRowContext and must be routed to the writer, and the raw ExecContext
// path) against 8 reader goroutines, then asserts nothing errored and every
// row landed.
func TestFilePool_ConcurrentReadsAndWrites(t *testing.T) {
	database := openFileDB(t)
	ctx := context.Background()
	channelID, userID := seedChannelAndUser(t, database)

	const (
		writers         = 8
		readers         = 8
		perWriter       = 25
		wantRows  int64 = writers * perWriter
	)

	var wg sync.WaitGroup

	// Writers: CreateMessage exercises INSERT ... RETURNING via the dbtx
	// router; PersistEvent exercises the plain ExecContext write path.
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				if _, err := database.CreateMessage(ctx, channelID, userID, fmt.Sprintf("msg %d-%d", w, i), nil); err != nil {
					t.Errorf("CreateMessage: %v", err)
					return
				}
				seq := int64(w*perWriter + i + 1)
				if err := database.PersistEvent(ctx, seq, "test_event", channelID, []byte(`{}`)); err != nil {
					t.Errorf("PersistEvent: %v", err)
					return
				}
			}
		}(w)
	}

	// Readers: list messages and events while the writers run.
	for r := 0; r < readers; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				if _, err := database.GetMessages(ctx, channelID, 0, 50); err != nil {
					t.Errorf("GetMessages: %v", err)
					return
				}
				if _, err := database.GetEventsSince(ctx, 0, 50); err != nil {
					t.Errorf("GetEventsSince: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()

	var msgCount, evtCount int64
	if err := database.QueryRowContext(ctx, "SELECT COUNT(*) FROM messages").Scan(&msgCount); err != nil {
		t.Fatalf("count messages: %v", err)
	}
	if msgCount != wantRows {
		t.Errorf("messages = %d, want %d", msgCount, wantRows)
	}
	if err := database.QueryRowContext(ctx, "SELECT COUNT(*) FROM events").Scan(&evtCount); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if evtCount != wantRows {
		t.Errorf("events = %d, want %d", evtCount, wantRows)
	}
}

// TestFilePool_FKViolationRejectedOnFile proves foreign key enforcement is
// live on the writer connection of a file-backed database, through both the
// sqlc RETURNING write path and a raw ExecContext insert.
func TestFilePool_FKViolationRejectedOnFile(t *testing.T) {
	database := openFileDB(t)
	ctx := context.Background()
	channelID, userID := seedChannelAndUser(t, database)

	// Nonexistent channel via the sqlc INSERT ... RETURNING path.
	if _, err := database.CreateMessage(ctx, 999999, userID, "orphan", nil); err == nil {
		t.Error("CreateMessage with nonexistent channel succeeded, want FK violation")
	}

	// Nonexistent user via the raw ExecContext path.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'orphan')`,
		channelID, int64(999999),
	); err == nil {
		t.Error("raw insert with nonexistent user succeeded, want FK violation")
	}

	// The valid combination still works.
	if _, err := database.CreateMessage(ctx, channelID, userID, "valid", nil); err != nil {
		t.Errorf("CreateMessage with valid FKs: %v", err)
	}
}

// TestFilePool_ReadDuringOpenWriteTx verifies the WAL property the split
// exists for: a read on the reader pool completes while the writer holds an
// open (BEGIN IMMEDIATE) write transaction, seeing the pre-transaction
// snapshot, and sees the new data once the transaction commits.
func TestFilePool_ReadDuringOpenWriteTx(t *testing.T) {
	database := openFileDB(t)
	ctx := context.Background()
	channelID, userID := seedChannelAndUser(t, database)

	if _, err := database.CreateMessage(ctx, channelID, userID, "before", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("BeginTx: %v", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'uncommitted')`,
		channelID, userID,
	); err != nil {
		_ = tx.Rollback()
		t.Fatalf("tx insert: %v", err)
	}

	// The read must not block on the open write transaction. Bound it with a
	// timeout so a lock conflict fails fast instead of hanging the test.
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var count int64
	if err := database.QueryRowContext(readCtx,
		"SELECT COUNT(*) FROM messages WHERE channel_id = ?", channelID,
	).Scan(&count); err != nil {
		_ = tx.Rollback()
		t.Fatalf("read during open write tx: %v", err)
	}
	if count != 1 {
		t.Errorf("read during open tx saw %d messages, want 1 (pre-tx snapshot)", count)
	}

	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if err := database.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM messages WHERE channel_id = ?", channelID,
	).Scan(&count); err != nil {
		t.Fatalf("read after commit: %v", err)
	}
	if count != 2 {
		t.Errorf("read after commit saw %d messages, want 2", count)
	}
}
