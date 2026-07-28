package db_test

import (
	"context"
	"testing"
	"time"
)

// Rate-limit lockouts are persisted so a brute-force lockout survives a server
// restart (migration 011). auth/ratelimit_test.go covers the in-memory limiter
// but never its persistence, so these four functions had no coverage — a gap
// with security consequences, since a lockout that fails to round-trip reopens
// the window it was meant to close.

func TestUpsertLockout_RoundTrip(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	expiry := time.Now().UTC().Add(15 * time.Minute).Truncate(time.Second)
	if err := database.UpsertLockout(ctx, "ip:203.0.113.7", expiry); err != nil {
		t.Fatalf("UpsertLockout: %v", err)
	}

	keys, expiries, err := database.LoadActiveLockouts(ctx)
	if err != nil {
		t.Fatalf("LoadActiveLockouts: %v", err)
	}
	if len(keys) != 1 || len(expiries) != 1 {
		t.Fatalf("LoadActiveLockouts returned %d keys / %d expiries, want 1 each", len(keys), len(expiries))
	}
	if keys[0] != "ip:203.0.113.7" {
		t.Errorf("key = %q, want %q", keys[0], "ip:203.0.113.7")
	}
	if !expiries[0].Equal(expiry) {
		t.Errorf("expiry = %v, want %v", expiries[0], expiry)
	}
}

func TestUpsertLockout_ReplacesExistingKey(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	first := time.Now().UTC().Add(5 * time.Minute).Truncate(time.Second)
	later := time.Now().UTC().Add(30 * time.Minute).Truncate(time.Second)

	if err := database.UpsertLockout(ctx, "user:alice", first); err != nil {
		t.Fatalf("UpsertLockout first: %v", err)
	}
	if err := database.UpsertLockout(ctx, "user:alice", later); err != nil {
		t.Fatalf("UpsertLockout second: %v", err)
	}

	keys, expiries, err := database.LoadActiveLockouts(ctx)
	if err != nil {
		t.Fatalf("LoadActiveLockouts: %v", err)
	}
	if len(keys) != 1 {
		t.Fatalf("got %d lockouts after re-upserting the same key, want 1: %v", len(keys), keys)
	}
	// An escalating lockout must extend, not duplicate or shorten.
	if !expiries[0].Equal(later) {
		t.Errorf("expiry = %v, want the later value %v", expiries[0], later)
	}
}

func TestLoadActiveLockouts_ExcludesExpired(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	past := time.Now().UTC().Add(-1 * time.Hour).Truncate(time.Second)
	future := time.Now().UTC().Add(1 * time.Hour).Truncate(time.Second)

	if err := database.UpsertLockout(ctx, "expired", past); err != nil {
		t.Fatalf("UpsertLockout expired: %v", err)
	}
	if err := database.UpsertLockout(ctx, "active", future); err != nil {
		t.Fatalf("UpsertLockout active: %v", err)
	}

	keys, _, err := database.LoadActiveLockouts(ctx)
	if err != nil {
		t.Fatalf("LoadActiveLockouts: %v", err)
	}
	if len(keys) != 1 || keys[0] != "active" {
		t.Errorf("LoadActiveLockouts = %v, want only [active]", keys)
	}
}

func TestCleanupExpiredLockouts(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	past := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Second)
	future := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Second)
	for key, exp := range map[string]time.Time{
		"stale-a": past,
		"stale-b": past,
		"live":    future,
	} {
		if err := database.UpsertLockout(ctx, key, exp); err != nil {
			t.Fatalf("UpsertLockout(%s): %v", key, err)
		}
	}

	if err := database.CleanupExpiredLockouts(ctx); err != nil {
		t.Fatalf("CleanupExpiredLockouts: %v", err)
	}

	var remaining int
	row := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM rate_lockouts`)
	if err := row.Scan(&remaining); err != nil {
		t.Fatalf("count rate_lockouts: %v", err)
	}
	if remaining != 1 {
		t.Errorf("%d rows left after cleanup, want 1 (only the unexpired one)", remaining)
	}

	keys, _, err := database.LoadActiveLockouts(ctx)
	if err != nil {
		t.Fatalf("LoadActiveLockouts: %v", err)
	}
	if len(keys) != 1 || keys[0] != "live" {
		t.Errorf("LoadActiveLockouts = %v, want only [live]", keys)
	}
}

func TestCleanupExpiredLockouts_EmptyTable(t *testing.T) {
	database := newMigratedTestDB(t)
	if err := database.CleanupExpiredLockouts(context.Background()); err != nil {
		t.Errorf("CleanupExpiredLockouts on an empty table: %v", err)
	}
}

func TestDeleteLockout(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	future := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	if err := database.UpsertLockout(ctx, "ip:198.51.100.4", future); err != nil {
		t.Fatalf("UpsertLockout: %v", err)
	}
	if err := database.UpsertLockout(ctx, "ip:198.51.100.5", future); err != nil {
		t.Fatalf("UpsertLockout: %v", err)
	}

	if err := database.DeleteLockout(ctx, "ip:198.51.100.4"); err != nil {
		t.Fatalf("DeleteLockout: %v", err)
	}

	keys, _, err := database.LoadActiveLockouts(ctx)
	if err != nil {
		t.Fatalf("LoadActiveLockouts: %v", err)
	}
	if len(keys) != 1 || keys[0] != "ip:198.51.100.5" {
		t.Errorf("LoadActiveLockouts = %v, want only the untouched key", keys)
	}
}

func TestDeleteLockout_UnknownKeyIsNoOp(t *testing.T) {
	database := newMigratedTestDB(t)
	if err := database.DeleteLockout(context.Background(), "never-locked"); err != nil {
		t.Errorf("DeleteLockout on an unknown key: %v", err)
	}
}
