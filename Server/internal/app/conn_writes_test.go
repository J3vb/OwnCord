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
	stop := startConnWrites(ctx, w, nil, nil)

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

// A graceful stop stamps every user the hub still holds disconnected in the
// final flush: the stopped hub's readPump defers queue their own stamps too
// late, which left them "online" with last_seen at connect time.
func TestConnWritesStop_StampsUsersStillConnected(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	ctx := context.Background()
	online, err := database.CreateUser(ctx, "online", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	dnd, err := database.CreateUser(ctx, "dnd", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`UPDATE users SET status = CASE id WHEN ? THEN 'online' ELSE 'dnd' END,
		 last_seen = datetime('now', '-2 days') WHERE id IN (?, ?)`, online, online, dnd); err != nil {
		t.Fatalf("seed: %v", err)
	}

	w := service.NewConnWrites(database)
	users := service.NewUserService(database)
	users.SetConnWrites(w)
	stop := startConnWrites(ctx, w, users, func() []int64 { return []int64{online, dnd} })
	if err := stop(ctx); err != nil {
		t.Fatalf("stop: %v", err)
	}

	for id, want := range map[int64]string{online: "offline", dnd: "dnd"} {
		var status string
		var fresh bool
		if err := database.QueryRowContext(ctx,
			`SELECT status, last_seen > datetime('now', '-1 minute') FROM users WHERE id = ?`, id).Scan(&status, &fresh); err != nil {
			t.Fatalf("read user %d: %v", id, err)
		}
		if status != want || !fresh {
			t.Errorf("user %d after stop: status %q fresh last_seen %v, want %q and true", id, status, fresh, want)
		}
	}
}
