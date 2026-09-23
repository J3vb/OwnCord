package db_test

import (
	"context"
	"testing"
	"time"
)

// Only an unlifted, unexpired timeout is listed for re-arming, with its
// target and expiry.
func TestListActiveTimeoutExpiries_OnlyActive(t *testing.T) {
	database, ownerID, activeID := newModerationActionsTestDB(t)
	ctx := context.Background()
	liftedID, err := database.CreateUser(ctx, "liftedmember", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(lifted): %v", err)
	}
	expiredID, err := database.CreateUser(ctx, "expiredmember", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(expired): %v", err)
	}

	expires := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	if _, _, err := database.TimeoutUser(ctx, activeID, ownerID, nil, "active", expires); err != nil {
		t.Fatalf("TimeoutUser(active): %v", err)
	}
	if _, _, err := database.TimeoutUser(ctx, liftedID, ownerID, nil, "lifted", expires); err != nil {
		t.Fatalf("TimeoutUser(lifted): %v", err)
	}
	if _, err := database.LiftTimeout(ctx, liftedID, ownerID); err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	if _, _, err := database.TimeoutUser(ctx, expiredID, ownerID, nil, "expired", time.Now().Add(-time.Hour)); err != nil {
		t.Fatalf("TimeoutUser(expired): %v", err)
	}

	got, err := database.ListActiveTimeoutExpiries(ctx)
	if err != nil {
		t.Fatalf("ListActiveTimeoutExpiries: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("ListActiveTimeoutExpiries returned %d rows, want 1: %+v", len(got), got)
	}
	if got[0].UserID != activeID || !got[0].ExpiresAt.Equal(expires) {
		t.Fatalf("got {UserID: %d, ExpiresAt: %v}, want {UserID: %d, ExpiresAt: %v}",
			got[0].UserID, got[0].ExpiresAt, activeID, expires)
	}
}
