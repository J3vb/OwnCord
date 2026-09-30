package db_test

import (
	"context"
	"testing"
)

// Invite redemption tracking (migration 055): the report found
// invites.redeemed_by is never written, so a leaked invite cannot be traced to
// its redeemer. Every redemption now records a row naming the invite and the
// account that redeemed it.

func TestCreateUserWithInvite_RecordsRedemption(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	creator, _ := database.CreateUser(ctx, "invite-record-creator", "hash", 2)
	code, err := database.CreateInvite(ctx, creator, 5, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	uid, err := database.CreateUserWithInvite(ctx, "recorded-redeemer", "hash", 4, code, "sess-recorded", "test", "127.0.0.1")
	if err != nil {
		t.Fatalf("CreateUserWithInvite: %v", err)
	}

	inv, err := database.GetInvite(ctx, code)
	if err != nil || inv == nil {
		t.Fatalf("GetInvite: %v", err)
	}
	reds, err := database.ListInviteRedemptions(ctx, inv.ID, 50)
	if err != nil {
		t.Fatalf("ListInviteRedemptions: %v", err)
	}
	if len(reds) != 1 {
		t.Fatalf("redemptions = %d, want 1", len(reds))
	}
	if reds[0].UserID == nil || *reds[0].UserID != uid {
		t.Errorf("redemption user_id = %v, want %d", reds[0].UserID, uid)
	}
	if reds[0].Username != "recorded-redeemer" {
		t.Errorf("redemption username = %q, want recorded-redeemer", reds[0].Username)
	}
	if reds[0].RedeemedAt == "" {
		t.Error("redemption redeemed_at is empty")
	}
}

// A failed redemption (bad/revoked/exhausted code) must not leave a
// redemption row behind — the account transaction rolls back together.
func TestCreateUserWithInvite_FailedRedemptionRecordsNothing(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	if _, err := database.CreateUserWithInvite(ctx, "no-invite-user", "hash", 4, "does-not-exist", "sess-noinv", "test", "127.0.0.1"); err == nil {
		t.Fatal("expected CreateUserWithInvite to fail for a missing code")
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM invite_redemptions`).Scan(&n); err != nil {
		t.Fatalf("count redemptions: %v", err)
	}
	if n != 0 {
		t.Errorf("redemption rows = %d, want 0 after a failed registration", n)
	}
}

// Erasing a redeemer unlinks the redemption (kept so the invite's history and
// use count survive) and takes inventory class 15b to zero.
func TestEraseAccount_ClearsInviteRedemptionLink(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	creator, _ := database.CreateUser(ctx, "erase-invite-creator", "hash", 2)
	code, _ := database.CreateInvite(ctx, creator, 5, nil)
	redeemer, err := database.CreateUserWithInvite(ctx, "erase-redeemer", "hash", 4, code, "sess-erase-redeemer", "test", "127.0.0.1")
	if err != nil {
		t.Fatalf("CreateUserWithInvite: %v", err)
	}

	if _, err := database.EraseAccount(ctx, redeemer, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}

	// The invite survives with its use count; the redemption row survives with
	// no user link.
	inv, _ := database.GetInvite(ctx, code)
	if inv == nil || inv.Uses != 1 {
		t.Fatalf("invite after erasure = %+v, want uses 1", inv)
	}
	var linked int
	if err := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM invite_redemptions WHERE invite_id = ? AND user_id IS NOT NULL`, inv.ID).Scan(&linked); err != nil {
		t.Fatalf("count linked redemptions: %v", err)
	}
	if linked != 0 {
		t.Errorf("redemption still names the erased user (%d rows)", linked)
	}

	inv2, err := database.TakeInventory(ctx, redeemer, "erase-redeemer")
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	if got := inv2["15b invite redemptions"]; got != 0 {
		t.Errorf("inventory class 15b = %d, want 0", got)
	}
}
