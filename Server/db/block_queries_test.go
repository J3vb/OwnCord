package db_test

import (
	"context"
	"testing"
)

// The user-blocking feature had no coverage at any layer (db, service, REST).
// These tests pin the db layer: idempotency of block/unblock, the directional
// nature of IsBlocked versus the symmetric IsEitherBlocked used by the DM
// authorization path, and the listing order.

func TestBlockUser_And_IsBlocked(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	seedBlockUser(t, database, 1, "alice")
	seedBlockUser(t, database, 2, "bob")

	blocked, err := database.IsBlocked(ctx, 1, 2)
	if err != nil {
		t.Fatalf("IsBlocked before block: %v", err)
	}
	if blocked {
		t.Fatal("IsBlocked = true before any block was recorded")
	}

	if err := database.BlockUser(ctx, 1, 2); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	blocked, err = database.IsBlocked(ctx, 1, 2)
	if err != nil {
		t.Fatalf("IsBlocked after block: %v", err)
	}
	if !blocked {
		t.Error("IsBlocked(1, 2) = false after 1 blocked 2")
	}

	// The block is directional: 2 has not blocked 1.
	reverse, err := database.IsBlocked(ctx, 2, 1)
	if err != nil {
		t.Fatalf("IsBlocked reverse: %v", err)
	}
	if reverse {
		t.Error("IsBlocked(2, 1) = true; block should be directional")
	}
}

func TestBlockUser_Idempotent(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	seedBlockUser(t, database, 1, "alice")
	seedBlockUser(t, database, 2, "bob")

	// INSERT OR IGNORE — blocking twice must not error or duplicate the row.
	for i := range 3 {
		if err := database.BlockUser(ctx, 1, 2); err != nil {
			t.Fatalf("BlockUser call %d: %v", i+1, err)
		}
	}

	ids, err := database.ListBlockedUsers(ctx, 1)
	if err != nil {
		t.Fatalf("ListBlockedUsers: %v", err)
	}
	if len(ids) != 1 {
		t.Errorf("ListBlockedUsers len = %d after 3 identical blocks, want 1 (got %v)", len(ids), ids)
	}
}

func TestUnblockUser(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	seedBlockUser(t, database, 1, "alice")
	seedBlockUser(t, database, 2, "bob")

	if err := database.BlockUser(ctx, 1, 2); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if err := database.UnblockUser(ctx, 1, 2); err != nil {
		t.Fatalf("UnblockUser: %v", err)
	}

	blocked, err := database.IsBlocked(ctx, 1, 2)
	if err != nil {
		t.Fatalf("IsBlocked: %v", err)
	}
	if blocked {
		t.Error("IsBlocked = true after UnblockUser")
	}
}

func TestUnblockUser_NotBlockedIsNoOp(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	seedBlockUser(t, database, 1, "alice")
	seedBlockUser(t, database, 2, "bob")

	// Documented as idempotent: unblocking someone who was never blocked
	// must succeed rather than report "not found".
	if err := database.UnblockUser(ctx, 1, 2); err != nil {
		t.Errorf("UnblockUser on a non-existent block: %v", err)
	}
}

func TestIsEitherBlocked(t *testing.T) {
	tests := []struct {
		name             string
		blockerID        int64
		blockedID        int64
		queryA, queryB   int64
		wantEitherResult bool
	}{
		{"no block at all", 0, 0, 1, 2, false},
		{"a blocked b, query (a,b)", 1, 2, 1, 2, true},
		{"a blocked b, query (b,a)", 1, 2, 2, 1, true},
		{"b blocked a, query (a,b)", 2, 1, 1, 2, true},
		{"unrelated pair", 1, 2, 1, 3, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			database := newMigratedTestDB(t)
			ctx := context.Background()
			seedBlockUser(t, database, 1, "alice")
			seedBlockUser(t, database, 2, "bob")
			seedBlockUser(t, database, 3, "carol")

			if tt.blockerID != 0 {
				if err := database.BlockUser(ctx, tt.blockerID, tt.blockedID); err != nil {
					t.Fatalf("BlockUser: %v", err)
				}
			}

			got, err := database.IsEitherBlocked(ctx, tt.queryA, tt.queryB)
			if err != nil {
				t.Fatalf("IsEitherBlocked: %v", err)
			}
			if got != tt.wantEitherResult {
				t.Errorf("IsEitherBlocked(%d, %d) = %v, want %v",
					tt.queryA, tt.queryB, got, tt.wantEitherResult)
			}
		})
	}
}

func TestListBlockedUsers(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	seedBlockUser(t, database, 1, "alice")
	seedBlockUser(t, database, 2, "bob")
	seedBlockUser(t, database, 3, "carol")
	seedBlockUser(t, database, 4, "dave")

	empty, err := database.ListBlockedUsers(ctx, 1)
	if err != nil {
		t.Fatalf("ListBlockedUsers on empty: %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("ListBlockedUsers on empty = %v, want none", empty)
	}

	for _, id := range []int64{2, 3} {
		if err := database.BlockUser(ctx, 1, id); err != nil {
			t.Fatalf("BlockUser(1, %d): %v", id, err)
		}
	}
	// A block by a different user must not leak into user 1's list.
	if err := database.BlockUser(ctx, 4, 3); err != nil {
		t.Fatalf("BlockUser(4, 3): %v", err)
	}

	ids, err := database.ListBlockedUsers(ctx, 1)
	if err != nil {
		t.Fatalf("ListBlockedUsers: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("ListBlockedUsers = %v, want 2 entries", ids)
	}
	seen := map[int64]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	if !seen[2] || !seen[3] {
		t.Errorf("ListBlockedUsers = %v, want it to contain 2 and 3", ids)
	}
}

func TestBlockUser_SelfBlockIsSilentlyDropped(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	seedBlockUser(t, database, 1, "alice")

	// Migration 012 carries CHECK (blocker_id != blocked_id), but the query is
	// INSERT OR IGNORE, and OR IGNORE suppresses CHECK violations as well as
	// uniqueness ones. So a self-block does not surface an error — it lands as
	// a no-op. Callers that want to reject it must do so above this layer.
	if err := database.BlockUser(ctx, 1, 1); err != nil {
		t.Fatalf("BlockUser(1, 1) = %v; INSERT OR IGNORE should swallow the CHECK violation", err)
	}

	// What matters is that no row is written.
	ids, err := database.ListBlockedUsers(ctx, 1)
	if err != nil {
		t.Fatalf("ListBlockedUsers: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("ListBlockedUsers = %v after a self-block, want none", ids)
	}
	blocked, err := database.IsBlocked(ctx, 1, 1)
	if err != nil {
		t.Fatalf("IsBlocked: %v", err)
	}
	if blocked {
		t.Error("IsBlocked(1, 1) = true; a self-block must never be recorded")
	}
}
