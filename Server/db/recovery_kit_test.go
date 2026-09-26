package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestRecoveryKit_UpsertReplacesAndUnspends(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, _ := database.CreateUser(ctx, "kitholder", "hash", 4)
	if kit, err := database.GetRecoveryKit(ctx, uid); err != nil || kit != nil {
		t.Fatalf("GetRecoveryKit before enrolment = %+v, %v; want nil", kit, err)
	}
	if err := database.UpsertRecoveryKit(ctx, uid, "$argon2id$first"); err != nil {
		t.Fatalf("UpsertRecoveryKit: %v", err)
	}
	if _, err := database.RedeemRecoveryKit(ctx, uid, "newhash", "recovery_kit_used", "test"); err != nil {
		t.Fatalf("RedeemRecoveryKit: %v", err)
	}
	kit, _ := database.GetRecoveryKit(ctx, uid)
	if kit == nil || kit.UsedAt == nil {
		t.Fatalf("kit after redeem = %+v, want spent", kit)
	}
	if err := database.UpsertRecoveryKit(ctx, uid, "$argon2id$second"); err != nil {
		t.Fatalf("UpsertRecoveryKit (rotation): %v", err)
	}
	kit, _ = database.GetRecoveryKit(ctx, uid)
	if kit == nil || kit.Verifier != "$argon2id$second" || kit.UsedAt != nil {
		t.Fatalf("kit after rotation = %+v, want the new verifier, unspent", kit)
	}
}

func TestRedeemRecoveryKit_IsOneTransaction(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, _ := database.CreateUser(ctx, "recovering", "oldhash", 4)
	if _, err := database.CreateSession(ctx, uid, "tok-a", "laptop", "10.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := database.CreateSession(ctx, uid, "tok-b", "phone", "10.0.0.2"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := database.UpsertRecoveryKit(ctx, uid, "$argon2id$v"); err != nil {
		t.Fatalf("UpsertRecoveryKit: %v", err)
	}

	revoked, err := database.RedeemRecoveryKit(ctx, uid, "newhash", "recovery_kit_used", "recovered")
	if err != nil || revoked != 2 {
		t.Fatalf("RedeemRecoveryKit = %d, %v; want 2 sessions revoked", revoked, err)
	}
	u, _ := database.GetUserByID(ctx, uid)
	if u.PasswordHash != "newhash" {
		t.Errorf("password hash = %q, want the new one", u.PasswordHash)
	}
	if sessions, _ := database.ListUserSessions(ctx, uid); len(sessions) != 0 {
		t.Errorf("sessions after redeem = %d, want 0", len(sessions))
	}
	var audits int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'recovery_kit_used' AND actor_id = ?`, uid).Scan(&audits); err != nil || audits != 1 {
		t.Errorf("audit rows = %d, %v; want 1", audits, err)
	}
	// Spent: a second redemption finds nothing and changes nothing.
	if _, err := database.RedeemRecoveryKit(ctx, uid, "third", "recovery_kit_used", "again"); !errors.Is(err, db.ErrRecoveryKitSpent) {
		t.Fatalf("second redeem = %v, want ErrRecoveryKitSpent", err)
	}
	u, _ = database.GetUserByID(ctx, uid)
	if u.PasswordHash != "newhash" {
		t.Errorf("a refused redeem changed the password to %q", u.PasswordHash)
	}
}

// Data-lifecycle O8 axis A1: a failure anywhere inside the redeem leaves
// the kit unspent, the password unchanged and the sessions live.
func TestRedeemRecoveryKit_RollsBackAsAWhole(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, _ := database.CreateUser(ctx, "unlucky", "oldhash", 4)
	if _, err := database.CreateSession(ctx, uid, "tok-live", "laptop", "10.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := database.UpsertRecoveryKit(ctx, uid, "$argon2id$v"); err != nil {
		t.Fatalf("UpsertRecoveryKit: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		"CREATE TRIGGER fault_delete_sessions BEFORE DELETE ON sessions BEGIN SELECT RAISE(FAIL, 'injected fault'); END"); err != nil {
		t.Fatalf("install fault: %v", err)
	}
	if _, err := database.RedeemRecoveryKit(ctx, uid, "newhash", "recovery_kit_used", "recovered"); err == nil {
		t.Fatal("redeem succeeded through an injected session-delete failure")
	}
	kit, _ := database.GetRecoveryKit(ctx, uid)
	if kit == nil || kit.UsedAt != nil {
		t.Errorf("kit = %+v, want still unspent", kit)
	}
	u, _ := database.GetUserByID(ctx, uid)
	if u.PasswordHash != "oldhash" {
		t.Errorf("password hash = %q, want unchanged", u.PasswordHash)
	}
	if sessions, _ := database.ListUserSessions(ctx, uid); len(sessions) != 1 {
		t.Errorf("sessions = %d, want the live one kept", len(sessions))
	}
	var audits int
	_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'recovery_kit_used'`).Scan(&audits)
	if audits != 0 {
		t.Errorf("audit rows = %d, want none from a rolled-back redeem", audits)
	}
}

func TestEraseAccount_PurgesTheRecoveryKit(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	if _, err := database.CreateUser(ctx, "owner", "hash", 1); err != nil {
		t.Fatalf("CreateUser(owner): %v", err)
	}
	uid, _ := database.CreateUser(ctx, "leaving", "hash", 4)
	if err := database.UpsertRecoveryKit(ctx, uid, "$argon2id$v"); err != nil {
		t.Fatalf("UpsertRecoveryKit: %v", err)
	}
	if _, err := database.EraseAccount(ctx, uid, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	if kit, _ := database.GetRecoveryKit(ctx, uid); kit != nil {
		t.Fatal("the recovery kit survived account deletion")
	}
}
