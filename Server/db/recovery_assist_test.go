package db_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func seedRecoveringUser(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	ctx := context.Background()
	uid, err := database.CreateUser(ctx, name, "oldhash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	for _, dev := range []string{"laptop", "phone"} {
		if _, err := database.CreateSession(ctx, uid, "tok-"+name+"-"+dev, dev, "10.0.0.1"); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
	}
	return uid
}

func TestRecoveryAssist_IssueReplacesAndRedeemConsumes(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedRecoveringUser(t, database, "assisted")
	if a, err := database.GetRecoveryAssist(ctx, uid); err != nil || a != nil {
		t.Fatalf("GetRecoveryAssist before issuance = %+v, %v; want nil", a, err)
	}
	if err := database.UpsertRecoveryAssist(ctx, uid, "$argon2id$first", 1, "in_person", time.Now().Add(15*time.Minute)); err != nil {
		t.Fatalf("UpsertRecoveryAssist: %v", err)
	}
	a, _ := database.GetRecoveryAssist(ctx, uid)
	if a == nil || a.Verifier != "$argon2id$first" || a.IssuedBy != 1 || a.Verification != "in_person" || !a.Live(time.Now()) {
		t.Fatalf("credential = %+v, want the issued, live one", a)
	}
	// A second issuance replaces the first.
	if err := database.UpsertRecoveryAssist(ctx, uid, "$argon2id$second", 1, "voice_call", time.Now().Add(15*time.Minute)); err != nil {
		t.Fatalf("UpsertRecoveryAssist (replace): %v", err)
	}
	if a, _ = database.GetRecoveryAssist(ctx, uid); a == nil || a.Verifier != "$argon2id$second" || a.Verification != "voice_call" {
		t.Fatalf("credential after replacement = %+v", a)
	}

	revoked, err := database.RedeemRecoveryAssist(ctx, uid, "newhash", "recovery_assist_used", "recovered")
	if err != nil || revoked != 2 {
		t.Fatalf("RedeemRecoveryAssist = %d, %v; want 2 sessions revoked", revoked, err)
	}
	if a, _ = database.GetRecoveryAssist(ctx, uid); a != nil {
		t.Fatalf("credential after redeem = %+v, want deleted", a)
	}
	u, _ := database.GetUserByID(ctx, uid)
	if u.PasswordHash != "newhash" {
		t.Errorf("password hash = %q, want the new one", u.PasswordHash)
	}
	if sessions, _ := database.ListUserSessions(ctx, uid); len(sessions) != 0 {
		t.Errorf("sessions after redeem = %d, want 0", len(sessions))
	}
	var audits int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'recovery_assist_used' AND actor_id = ?`, uid).Scan(&audits); err != nil || audits != 1 {
		t.Errorf("audit rows = %d, %v; want 1", audits, err)
	}
	// Single use: a replay finds nothing and changes nothing.
	if _, err := database.RedeemRecoveryAssist(ctx, uid, "third", "recovery_assist_used", "again"); !errors.Is(err, db.ErrRecoveryAssistSpent) {
		t.Fatalf("replay = %v, want ErrRecoveryAssistSpent", err)
	}
	if u, _ = database.GetUserByID(ctx, uid); u.PasswordHash != "newhash" {
		t.Errorf("a refused redeem changed the password to %q", u.PasswordHash)
	}
}

func TestRedeemRecoveryAssist_RefusesAnExpiredCredential(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedRecoveringUser(t, database, "late")
	if err := database.UpsertRecoveryAssist(ctx, uid, "$argon2id$v", 1, "in_person", time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("UpsertRecoveryAssist: %v", err)
	}
	if a, _ := database.GetRecoveryAssist(ctx, uid); a == nil || a.Live(time.Now()) {
		t.Fatalf("credential = %+v, want present but expired", a)
	}
	if _, err := database.RedeemRecoveryAssist(ctx, uid, "newhash", "recovery_assist_used", "late"); !errors.Is(err, db.ErrRecoveryAssistSpent) {
		t.Fatalf("expired redeem = %v, want ErrRecoveryAssistSpent", err)
	}
	u, _ := database.GetUserByID(ctx, uid)
	if u.PasswordHash != "oldhash" {
		t.Errorf("password hash = %q, want unchanged", u.PasswordHash)
	}
	if sessions, _ := database.ListUserSessions(ctx, uid); len(sessions) != 2 {
		t.Errorf("sessions = %d, want both kept", len(sessions))
	}
}

// Data-lifecycle O8 axis A1 for the assisted path: a failure anywhere inside
// the redeem leaves the credential live, the password unchanged and the
// sessions in place (the restart-mid-flow case).
func TestRedeemRecoveryAssist_RollsBackAsAWhole(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedRecoveringUser(t, database, "unlucky")
	if err := database.UpsertRecoveryAssist(ctx, uid, "$argon2id$v", 1, "in_person", time.Now().Add(15*time.Minute)); err != nil {
		t.Fatalf("UpsertRecoveryAssist: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		"CREATE TRIGGER fault_delete_sessions BEFORE DELETE ON sessions BEGIN SELECT RAISE(FAIL, 'injected fault'); END"); err != nil {
		t.Fatalf("install fault: %v", err)
	}
	if _, err := database.RedeemRecoveryAssist(ctx, uid, "newhash", "recovery_assist_used", "recovered"); err == nil {
		t.Fatal("redeem succeeded through an injected session-delete failure")
	}
	if a, _ := database.GetRecoveryAssist(ctx, uid); a == nil || !a.Live(time.Now()) {
		t.Errorf("credential = %+v, want still live", a)
	}
	u, _ := database.GetUserByID(ctx, uid)
	if u.PasswordHash != "oldhash" {
		t.Errorf("password hash = %q, want unchanged", u.PasswordHash)
	}
	if sessions, _ := database.ListUserSessions(ctx, uid); len(sessions) != 2 {
		t.Errorf("sessions = %d, want both kept", len(sessions))
	}
	var audits int
	_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'recovery_assist_used'`).Scan(&audits)
	if audits != 0 {
		t.Errorf("audit rows = %d, want none from a rolled-back redeem", audits)
	}
}

func TestRedeemRecoveryKit_WithdrawsTheOutstandingCredential(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedRecoveringUser(t, database, "both")
	if err := database.UpsertRecoveryKit(ctx, uid, "$argon2id$kit"); err != nil {
		t.Fatalf("UpsertRecoveryKit: %v", err)
	}
	if err := database.UpsertRecoveryAssist(ctx, uid, "$argon2id$assist", 1, "in_person", time.Now().Add(15*time.Minute)); err != nil {
		t.Fatalf("UpsertRecoveryAssist: %v", err)
	}
	if _, err := database.RedeemRecoveryKit(ctx, uid, "newhash", "recovery_kit_used", "by kit"); err != nil {
		t.Fatalf("RedeemRecoveryKit: %v", err)
	}
	if a, _ := database.GetRecoveryAssist(ctx, uid); a != nil {
		t.Fatalf("credential after a kit recovery = %+v, want withdrawn", a)
	}
}

func TestDeleteAccount_PurgesTheRecoveryCredential(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	if _, err := database.CreateUser(ctx, "owner", "hash", 1); err != nil {
		t.Fatalf("CreateUser(owner): %v", err)
	}
	uid, _ := database.CreateUser(ctx, "leaving", "hash", 4)
	if err := database.UpsertRecoveryAssist(ctx, uid, "$argon2id$v", 1, "in_person", time.Now().Add(15*time.Minute)); err != nil {
		t.Fatalf("UpsertRecoveryAssist: %v", err)
	}
	if err := database.DeleteAccount(ctx, uid); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	if a, _ := database.GetRecoveryAssist(ctx, uid); a != nil {
		t.Fatal("the recovery credential survived account deletion")
	}
}
