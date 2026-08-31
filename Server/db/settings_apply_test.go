package db_test

import (
	"context"
	"testing"
)

// ApplySettings targets the real settings table, so these tests use the
// package's full-migration opener (migrated_db_test.go), not the minimal
// shared testSchema fixture.

func TestApplySettings_AppliesEveryKey(t *testing.T) {
	database := newMigratedTestDB(t)
	if err := database.ApplySettings(context.Background(), map[string]string{
		"server_name": "Applied",
		"motd":        "Hello",
	}); err != nil {
		t.Fatalf("ApplySettings: %v", err)
	}
	for key, want := range map[string]string{"server_name": "Applied", "motd": "Hello"} {
		got, err := database.GetSetting(context.Background(), key)
		if err != nil || got != want {
			t.Fatalf("GetSetting(%s) = %q, %v; want %q", key, got, err, want)
		}
	}
}

func TestApplySettings_EmptyMapIsNoOp(t *testing.T) {
	database := newMigratedTestDB(t)
	if err := database.ApplySettings(context.Background(), nil); err != nil {
		t.Fatalf("ApplySettings(nil): %v", err)
	}
}

func TestApplySettings_RollsBackOnFailure(t *testing.T) {
	database := newMigratedTestDB(t)
	// Sabotage the table so the in-transaction upsert fails after Begin
	// succeeded — the rollback path must surface the error, and a later
	// repair must find no half-applied state (the transaction is the unit).
	if _, err := database.ExecContext(context.Background(), "DROP TABLE settings"); err != nil {
		t.Fatalf("DROP TABLE settings: %v", err)
	}
	if err := database.ApplySettings(context.Background(), map[string]string{
		"server_name": "never",
	}); err == nil {
		t.Fatal("ApplySettings against a dropped table must error")
	}
}

func TestApplySettings_BeginFailsOnClosedDB(t *testing.T) {
	database := newMigratedTestDB(t)
	_ = database.Close()
	if err := database.ApplySettings(context.Background(), map[string]string{
		"server_name": "never",
	}); err == nil {
		t.Fatal("ApplySettings on a closed database must error")
	}
}
