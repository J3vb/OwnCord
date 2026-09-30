package app

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// The conn-writes close step flushes what the sockets queued: a touch still
// pending at shutdown reaches the sessions row instead of vanishing with the
// process (P5-S07).
func TestConnWritesStop_FlushesPendingTouches(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	ctx := context.Background()
	uid, err := database.CreateUser(ctx, "sleeper", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if _, err := database.CreateSession(ctx, uid, "tok", "dev", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`UPDATE sessions SET last_used = datetime('now', '-2 days') WHERE token = 'tok'`); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	w := service.NewConnWrites(database)
	sessions := service.NewSessionService(database)
	sessions.SetConnWrites(w)
	stop := startConnWrites(ctx, w)

	if err := sessions.TouchSession(ctx, "tok"); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}
	if err := stop(ctx); err != nil {
		t.Fatalf("stop: %v", err)
	}

	var fresh bool
	if err := database.QueryRowContext(ctx,
		`SELECT last_used > datetime('now', '-1 minute') FROM sessions WHERE token = 'tok'`).Scan(&fresh); err != nil {
		t.Fatalf("read session: %v", err)
	}
	if !fresh {
		t.Fatal("shutdown left the pending touch unwritten")
	}
}
