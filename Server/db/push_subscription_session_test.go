package db_test

import (
	"context"
	"database/sql"
	"testing"
)

// Migration 093: a subscription made by a session ends with it, and a
// re-subscribe from a new session moves the row so ending the old one no
// longer touches it.

func countPushRows(t *testing.T, database interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id int64) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM push_subscriptions WHERE id = ?`, id).Scan(&n); err != nil {
		t.Fatalf("counting push rows: %v", err)
	}
	return n
}

func TestPushSubscription_EndsWithItsSession(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)
	sessionID, err := database.CreateSession(ctx, 1, "hash-a", "phone", "127.0.0.1")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	id, err := database.UpsertPushSubscription(ctx, 1, &sessionID, "https://push.example/a", "p", "a", "d", "k", 10)
	if err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}
	other, err := database.UpsertPushSubscription(ctx, 1, nil, "https://push.example/b", "p", "a", "d", "k", 10)
	if err != nil {
		t.Fatalf("UpsertPushSubscription without a session: %v", err)
	}

	if err := database.DeleteSession(ctx, "hash-a"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	if n := countPushRows(t, database, id); n != 0 {
		t.Errorf("the signed-out session's subscription survived (%d rows)", n)
	}
	if n := countPushRows(t, database, other); n != 1 {
		t.Errorf("a subscription with no session was deleted with an unrelated session (%d rows)", n)
	}
}

func TestPushSubscription_ResubscribeMovesToTheNewSession(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)
	oldID, err := database.CreateSession(ctx, 1, "hash-old", "phone", "127.0.0.1")
	if err != nil {
		t.Fatalf("CreateSession old: %v", err)
	}
	newID, err := database.CreateSession(ctx, 1, "hash-new", "phone", "127.0.0.1")
	if err != nil {
		t.Fatalf("CreateSession new: %v", err)
	}
	first, err := database.UpsertPushSubscription(ctx, 1, &oldID, "https://push.example/a", "p", "a", "d", "k", 10)
	if err != nil {
		t.Fatalf("UpsertPushSubscription old: %v", err)
	}
	second, err := database.UpsertPushSubscription(ctx, 1, &newID, "https://push.example/a", "p", "a", "d", "k", 10)
	if err != nil || second != first {
		t.Fatalf("re-subscribe: id=%d err=%v, want the same row %d", second, err, first)
	}

	if err := database.DeleteSession(ctx, "hash-old"); err != nil {
		t.Fatalf("DeleteSession old: %v", err)
	}
	if n := countPushRows(t, database, first); n != 1 {
		t.Fatalf("ending the old session deleted the row the new session owns (%d rows)", n)
	}
	if err := database.DeleteSession(ctx, "hash-new"); err != nil {
		t.Fatalf("DeleteSession new: %v", err)
	}
	if n := countPushRows(t, database, first); n != 0 {
		t.Errorf("ending the new session left its subscription (%d rows)", n)
	}
}
