package service

import (
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// The erasure can empty the users table — the administrator erases the last
// account, or a marker replay erases past the last-admin guard on a
// restored backup — and the unauthenticated first-run endpoint must stay
// closed when it does (Codex's security review of #1522): the durable flag,
// not the user count, is the gate. NeedsSetup reports it, so the setup page
// does not offer a wizard that Bootstrap would refuse.
func TestSetupService_AnEmptiedUserTableDoesNotReopenSetup(t *testing.T) {
	svc, database, ctx := setupFixture(t)
	seedRole(t, database, &db.Role{ID: permissions.AdminRoleID, Name: "Admin", Position: permissions.OwnerRolePosition - 1})

	if needs, err := svc.NeedsSetup(ctx); err != nil || !needs {
		t.Fatalf("NeedsSetup on an empty server = %v, %v; want true", needs, err)
	}
	res, err := svc.Bootstrap(ctx, BootstrapInput{Username: "owner", Password: "correct horse battery staple", Host: "127.0.0.1"})
	if err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}

	// The erasure's aftermath.
	erasure := NewErasureService(database)
	if err := erasure.Erase(ctx, res.OwnerID); !errors.Is(err, db.ErrLastAdmin) {
		t.Fatalf("Erase(the only owner) = %v, want ErrLastAdmin — the live guard still holds", err)
	}
	// The replay path erases past that guard; the restored-backup case.
	if _, err := database.ReplayEraseAccount(ctx, res.OwnerID, "tok"); err != nil {
		t.Fatalf("ReplayEraseAccount: %v", err)
	}
	if n, err := database.UserCount(ctx); err != nil || n != 0 {
		t.Fatalf("users after the replay = %d, %v; want 0", n, err)
	}

	if needs, err := svc.NeedsSetup(ctx); err != nil || needs {
		t.Errorf("NeedsSetup after the replay emptied the table = %v, %v; want false", needs, err)
	}
	if _, err := svc.Bootstrap(ctx, BootstrapInput{Username: "takeover", Password: "correct horse battery staple", Host: "203.0.113.9"}); !errors.Is(err, ErrSetupAlreadyDone) {
		t.Errorf("Bootstrap after the replay = %v, want ErrSetupAlreadyDone", err)
	}
	if n, _ := database.UserCount(ctx); n != 0 {
		t.Errorf("the refused bootstrap created %d accounts, want none", n)
	}

	// The operator's deliberate recovery: clear the flag with filesystem
	// access, and the wizard is offered again.
	if err := database.SetSetting(ctx, SetupCompletedSetting, "0"); err != nil {
		t.Fatal(err)
	}
	if needs, err := svc.NeedsSetup(ctx); err != nil || !needs {
		t.Fatalf("NeedsSetup after the operator re-opened setup = %v, %v; want true", needs, err)
	}
	if _, err := svc.Bootstrap(ctx, BootstrapInput{Username: "recovered", Password: "correct horse battery staple", Host: "127.0.0.1"}); err != nil {
		t.Errorf("Bootstrap after the re-open = %v", err)
	}
}
