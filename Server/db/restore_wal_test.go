package db_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func openPlainFileDB(t *testing.T) (*db.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "restore.db")
	database, err := db.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err := database.ExecContext(context.Background(), `CREATE TABLE t (v INTEGER)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	return database, path
}

func TestCheckpointForRestore_EmptiesTheLog(t *testing.T) {
	database, _ := openPlainFileDB(t)
	if _, err := database.ExecContext(context.Background(), `INSERT INTO t VALUES (1)`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	truncated, err := database.CheckpointForRestore(context.Background())
	if err != nil || !truncated {
		t.Fatalf("CheckpointForRestore = %v, %v; want true, nil", truncated, err)
	}
}

func TestCheckpointForRestore_InMemoryHasNoLog(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer database.Close() //nolint:errcheck
	truncated, err := database.CheckpointForRestore(context.Background())
	if err != nil || !truncated {
		t.Fatalf("CheckpointForRestore = %v, %v; want true, nil", truncated, err)
	}
}

func TestCheckpointForRestore_ReaderInSnapshotReportsBusy(t *testing.T) {
	database, _ := openPlainFileDB(t)
	ctx := context.Background()
	if _, err := database.SQLDb().Exec(`PRAGMA busy_timeout=100`); err != nil {
		t.Fatalf("busy_timeout: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO t VALUES (1)`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	conn, err := database.SQLReaderDB().Conn(ctx)
	if err != nil {
		t.Fatalf("reader conn: %v", err)
	}
	defer conn.Close() //nolint:errcheck
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback() //nolint:errcheck
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM t`).Scan(&n); err != nil {
		t.Fatalf("select: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO t VALUES (2)`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	truncated, err := database.CheckpointForRestore(ctx)
	if err != nil || truncated {
		t.Fatalf("CheckpointForRestore = %v, %v; want false, nil while a reader holds a snapshot", truncated, err)
	}
}

func TestCheckpointForRestore_ClosedDatabaseErrors(t *testing.T) {
	database, _ := openPlainFileDB(t)
	_ = database.Close()
	if _, err := database.CheckpointForRestore(context.Background()); err == nil {
		t.Fatal("CheckpointForRestore on a closed database returned no error")
	}
}

func TestWaitConnsClosed(t *testing.T) {
	database, _ := openPlainFileDB(t)
	ctx := context.Background()
	conn, err := database.SQLReaderDB().Conn(ctx)
	if err != nil {
		t.Fatalf("reader conn: %v", err)
	}
	_ = database.Close()

	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if err := database.WaitConnsClosed(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("WaitConnsClosed with a connection in use = %v, want a deadline error", err)
	}

	_ = conn.Close()
	long, cancel2 := context.WithTimeout(ctx, 2*time.Second)
	defer cancel2()
	if err := database.WaitConnsClosed(long); err != nil {
		t.Fatalf("WaitConnsClosed after release = %v, want nil", err)
	}
}

func TestRemoveWALSidecars(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.db")
	if err := db.RemoveWALSidecars(path); err != nil {
		t.Fatalf("no sidecars: %v", err)
	}
	for _, s := range []string{"", "-wal", "-shm"} {
		if err := os.WriteFile(path+s, []byte("x"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	if err := db.RemoveWALSidecars(path); err != nil {
		t.Fatalf("RemoveWALSidecars: %v", err)
	}
	for _, s := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(path + s); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s still exists (%v)", s, err)
		}
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("main file was removed: %v", err)
	}

	if err := os.Mkdir(path+"-wal", 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(path+"-wal", "child"), nil, 0o600); err != nil {
		t.Fatalf("write child: %v", err)
	}
	if err := db.RemoveWALSidecars(path); err == nil {
		t.Error("RemoveWALSidecars returned no error for a -wal it could not remove")
	}
}
