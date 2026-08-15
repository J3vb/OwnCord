package db_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/owncord/server/db"
)

// TestOpenShared_WorksWhileServerHoldsLock locks the token-CLI contract: a
// short-lived tool must be able to open the database while a server process
// holds the single-process lock — SQLite WAL makes the file access safe, and
// the lock only guards the server's process-local state.
func TestOpenShared_WorksWhileServerHoldsLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared.db")

	server, err := db.Open(path) // takes the process lock
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })

	cli, err := db.OpenShared(path) // must not block on or steal the lock
	if err != nil {
		t.Fatalf("OpenShared while lock held: %v", err)
	}
	defer cli.Close() //nolint:errcheck

	if err := cli.PingRead(context.Background()); err != nil {
		t.Fatalf("PingRead on shared handle: %v", err)
	}
}
