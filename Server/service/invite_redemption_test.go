package service

import (
	"context"
	"testing"
)

// ListInviteRedemptions resolves an invite by code and returns its redemption
// history so an owner can trace a leaked invite to its redeemer (O1).
func TestInviteService_ListInviteRedemptions(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	svc := NewInviteService(database)

	creator, err := database.CreateUser(ctx, "svc-redemption-creator", "hash", 2)
	if err != nil {
		t.Fatalf("CreateUser creator: %v", err)
	}
	inv, err := svc.CreateInvite(ctx, creator, 5, 24)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	redeemer, err := database.CreateUserWithInvite(ctx, "svc-redeemer", "hash", 4, inv.Code, "sess-svc-redeemer", "test", "127.0.0.1")
	if err != nil {
		t.Fatalf("CreateUserWithInvite: %v", err)
	}

	reds, err := svc.ListInviteRedemptions(ctx, inv.Code)
	if err != nil {
		t.Fatalf("ListInviteRedemptions: %v", err)
	}
	if len(reds) != 1 {
		t.Fatalf("redemptions = %d, want 1", len(reds))
	}
	if reds[0].UserID == nil || *reds[0].UserID != redeemer {
		t.Errorf("redemption user_id = %v, want %d", reds[0].UserID, redeemer)
	}
	if reds[0].Username != "svc-redeemer" {
		t.Errorf("redemption username = %q, want svc-redeemer", reds[0].Username)
	}
}

// An unknown code is a not-found, not an empty list: the caller asked about an
// invite that does not exist.
func TestInviteService_ListInviteRedemptions_UnknownCode(t *testing.T) {
	database := newTestDB(t)
	svc := NewInviteService(database)

	if _, err := svc.ListInviteRedemptions(context.Background(), "no-such-code"); err == nil {
		t.Error("expected ErrNotFound for an unknown invite code")
	}
}
