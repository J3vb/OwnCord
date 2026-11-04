package db

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func openWALTestDB(t *testing.T) *DB {
	t.Helper()
	d, err := Open(filepath.Join(t.TempDir(), "wal.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if _, err := d.writer.ExecContext(context.Background(), `CREATE TABLE blobs (id INTEGER PRIMARY KEY, b BLOB NOT NULL)`); err != nil {
		t.Fatalf("create table: %v", err)
	}
	return d
}

// Every pooled connection, writer and readers, carries the 64 MiB WAL cap.
func TestFilePragmas_CapTheWALOnEveryConnection(t *testing.T) {
	d := openWALTestDB(t)
	ctx := context.Background()
	var limit int64
	if err := d.writer.QueryRowContext(ctx, "PRAGMA journal_size_limit").Scan(&limit); err != nil {
		t.Fatalf("writer journal_size_limit: %v", err)
	}
	if limit != 64<<20 {
		t.Errorf("writer journal_size_limit = %d, want %d", limit, 64<<20)
	}
	if err := d.reader.QueryRowContext(ctx, "PRAGMA journal_size_limit").Scan(&limit); err != nil {
		t.Fatalf("reader journal_size_limit: %v", err)
	}
	if limit != 64<<20 {
		t.Errorf("reader journal_size_limit = %d, want %d", limit, 64<<20)
	}
}

// A reader holding an old snapshot lets the WAL grow past the limit; once it
// lets go, the optimizer tick's passive checkpoint plus one more write shrink
// the file back to the limit. The limit is lowered on the one writer
// connection so the test writes a few MiB rather than 64.
func TestOptimizeTick_LetsTheWALShrinkToTheLimit(t *testing.T) {
	d := openWALTestDB(t)
	ctx := context.Background()
	const limit = 256 << 10
	if _, err := d.writer.ExecContext(ctx, "PRAGMA journal_size_limit=262144"); err != nil {
		t.Fatalf("lower limit: %v", err)
	}
	t.Cleanup(func() { _, _ = d.writer.ExecContext(context.Background(), "PRAGMA journal_size_limit=67108864") })

	insert := func(n int) {
		t.Helper()
		blob := []byte(strings.Repeat("x", 32<<10))
		for range n {
			if _, err := d.writer.ExecContext(ctx, `INSERT INTO blobs (b) VALUES (?)`, blob); err != nil {
				t.Fatalf("insert: %v", err)
			}
		}
	}

	// Pin a read snapshot so no checkpoint can finish while the WAL grows.
	tx, err := d.reader.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin reader: %v", err)
	}
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM blobs`).Scan(&n); err != nil {
		t.Fatalf("pin snapshot: %v", err)
	}
	insert(128) // ~4 MiB of frames
	grown, err := d.WALBytes()
	if err != nil {
		t.Fatal(err)
	}
	if grown <= 4*limit {
		t.Fatalf("WAL = %d bytes with a pinned reader, want it well past %d to make the test meaningful", grown, limit)
	}
	_ = tx.Rollback()

	if err := d.optimizeTick(ctx); err != nil {
		t.Fatalf("optimizeTick: %v", err)
	}
	insert(1) // the write that restarts the log and truncates it
	shrunk, err := d.WALBytes()
	if err != nil {
		t.Fatal(err)
	}
	if shrunk > limit {
		t.Fatalf("WAL = %d bytes after the checkpoint and a write, want at most %d (it was %d)", shrunk, limit, grown)
	}
}

// CheckpointWAL is a no-op on an in-memory database and after Close.
func TestCheckpointWAL_NoOpInMemoryAndAfterClose(t *testing.T) {
	mem, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := mem.CheckpointWAL(context.Background()); err != nil {
		t.Fatalf("in-memory CheckpointWAL: %v", err)
	}
	_ = mem.Close()

	d := openWALTestDB(t)
	if err := d.CheckpointWAL(context.Background()); err != nil {
		t.Fatalf("CheckpointWAL: %v", err)
	}
	_ = d.Close()
	if err := d.CheckpointWAL(context.Background()); err != nil {
		t.Fatalf("CheckpointWAL after Close must be a no-op, got %v", err)
	}
}
