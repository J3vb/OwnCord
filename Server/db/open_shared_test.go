package db_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// TestOpenShared_WorksWhileServerHoldsLock locks the token-CLI contract: a
// short-lived tool must be able to open the database while a server process
// holds the single-process lock — SQLite WAL makes the file access safe, and
// the lock only guards the server's process-local state.
func TestOpenShared_WorksWhileServerHoldsLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared.db")

	server, err := db.Open(path) // takes the process lock
	mustDo(t, "Open", err)
	t.Cleanup(func() { _ = server.Close() })

	cli, err := db.OpenShared(path) // must not block on or steal the lock
	mustDo(t, "OpenShared while lock held", err)
	defer cli.Close() //nolint:errcheck

	mustDo(t, "PingRead on shared handle", cli.PingRead(context.Background()))
}
