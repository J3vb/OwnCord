package service

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// AuthService's core and parts must all reach the same store and the same
// shared limiter. db.WriteAuditEntry and db.WriteAudit assert optional audit
// capabilities on the store at run time and fall back to a token-less or
// synchronous write when a store lacks them, so each store that writes audit
// rows must still carry them.
func TestAuthServicePartsShareStoreAndAuditCapabilities(t *testing.T) {
	database := newTestDB(t)
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
	for name, st := range map[string]any{
		"core":            svc.st,
		"twoFactor":       svc.twoFactor.st,
		"accountRecovery": svc.accountRecovery.st,
	} {
		if st != any(database) {
			t.Errorf("%s store = %T, want the shared *db.DB", name, st)
		}
		if _, ok := st.(db.EntryAuditor); !ok {
			t.Errorf("%s store lost db.EntryAuditor", name)
		}
		if _, ok := st.(db.AsyncEntryAuditor); !ok {
			t.Errorf("%s store lost db.AsyncEntryAuditor", name)
		}
	}
	var _ db.EntryAuditor = svc.st
	if svc.twoFactor.authCommon != svc.authCommon || svc.accountRecovery.authCommon != svc.authCommon {
		t.Error("parts hold their own authCommon; limiter and broadcaster would diverge")
	}
}

// UseErasure swaps the runner after construction; DeleteAccount, which stays on
// the core, must run the swapped one and write its audit row through the core
// store with the erasure's subject token intact.
func TestAuthServiceUseErasureReachesDeleteAccount(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, _ := seedErasureMember(t, database, dir)
	hash, err := auth.HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.UpdateUserPassword(ctx, uid, hash); err != nil {
		t.Fatal(err)
	}
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
	shared := NewErasureService(database)
	shared.SetFiles(newTestStorage(t, dir))
	shared.SetMarkers(newTestMarkers(t))
	svc.UseErasure(shared)
	if svc.erasure != shared {
		t.Fatal("UseErasure did not install the shared runner")
	}
	welcome := &WelcomeService{}
	svc.UseWelcome(welcome)
	if svc.welcome != welcome {
		t.Fatal("UseWelcome did not install the welcome service")
	}

	if err := svc.DeleteAccount(ctx, sessionPrincipal(user), "correct horse battery", "203.0.113.9"); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	var tokened int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'account_deleted' AND subject_token IS NOT NULL AND subject_token <> ''`).Scan(&tokened); err != nil || tokened != 1 {
		t.Errorf("account_deleted rows carrying the subject token = %d (%v), want 1", tokened, err)
	}
}
