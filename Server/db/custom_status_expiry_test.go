package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// A status set in the same instant the old one expires carries a different
// expiry, so the expirer's compare-and-clear for the old instant must leave it.
func TestClearCustomStatusIfExpiry_TagMismatchNoop(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, err := database.CreateUser(ctx, "alice", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	const old, fresh = "2026-01-01T00:00:00Z", "2026-01-01T00:30:00Z"
	if err := database.UpdateUserPresence(ctx, uid, db.StatusOnline, new("lunch"), new(old)); err != nil {
		t.Fatal(err)
	}
	// The user re-sets the status before the expirer's clear lands.
	if err := database.UpdateUserPresence(ctx, uid, db.StatusOnline, new("meeting"), new(fresh)); err != nil {
		t.Fatal(err)
	}
	ok, err := database.ClearCustomStatusIfExpiry(ctx, uid, old)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("ClearCustomStatusIfExpiry cleared a status carrying a different expiry")
	}
	u, err := database.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	if u.CustomStatus == nil || *u.CustomStatus != "meeting" || u.CustomStatusExpiresAt == nil || *u.CustomStatusExpiresAt != fresh {
		t.Fatalf("new status was disturbed: %v / %v", u.CustomStatus, u.CustomStatusExpiresAt)
	}
	ok, err = database.ClearCustomStatusIfExpiry(ctx, uid, fresh)
	if err != nil || !ok {
		t.Fatalf("clear with the matching expiry = %v, %v; want true, nil", ok, err)
	}
	u, _ = database.GetUserByID(ctx, uid)
	if u.CustomStatus != nil || u.CustomStatusExpiresAt != nil {
		t.Fatalf("matching clear left %v / %v", u.CustomStatus, u.CustomStatusExpiresAt)
	}
}

func TestCustomStatusExpiry_NextAndListExpired(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	if _, ok, err := database.NextCustomStatusExpiry(ctx); err != nil || ok {
		t.Fatalf("empty: Next = ok %v err %v, want none", ok, err)
	}
	a, _ := database.CreateUser(ctx, "a", "hash", 4)
	b, _ := database.CreateUser(ctx, "b", "hash", 4)
	c, _ := database.CreateUser(ctx, "c", "hash", 4)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(database.UpdateUserPresence(ctx, a, db.StatusOnline, new("a"), new("2026-01-02T00:00:00Z")))
	must(database.UpdateUserPresence(ctx, b, db.StatusOnline, new("b"), new("2026-01-01T00:00:00Z")))
	must(database.UpdateUserPresence(ctx, c, db.StatusOnline, new("c"), nil)) // no expiry

	next, ok, err := database.NextCustomStatusExpiry(ctx)
	if err != nil || !ok || next != "2026-01-01T00:00:00Z" {
		t.Fatalf("Next = %q, %v, %v; want the soonest", next, ok, err)
	}
	rows, err := database.ListExpiredCustomStatuses(ctx, "2026-01-01T12:00:00Z", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].UserID != b || rows[0].ExpiresAt != "2026-01-01T00:00:00Z" {
		t.Fatalf("ListExpired = %+v, want only b", rows)
	}
	// Writing a new text without an expiry replaces the old expiry.
	must(database.UpdateUserCustomStatus(ctx, b, new("b2")))
	if rows, _ = database.ListExpiredCustomStatuses(ctx, "2027-01-01T00:00:00Z", 10); len(rows) != 1 || rows[0].UserID != a {
		t.Fatalf("after b's rewrite, expired = %+v, want only a", rows)
	}
}

func TestDenyPendingUser_ClearsCustomStatusExpiry(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	pid, err := database.CreatePendingUser(ctx, "applicant", "hash", 4, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.UpdateUserPresence(ctx, pid, db.StatusOnline, new("hi"), new(time.Now().UTC().Add(time.Hour).Format(dbtime.ISOLayout))); err != nil {
		t.Fatal(err)
	}
	if err := database.DenyPendingUser(ctx, pid); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := database.NextCustomStatusExpiry(ctx); err != nil || ok {
		t.Fatalf("a denied account kept an expiry: ok %v err %v", ok, err)
	}
}
