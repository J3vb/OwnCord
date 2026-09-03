package db_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// openTestMarkersExternal opens a marker store from the external test
// package (db_test), where the internal helper is out of reach.
func openTestMarkersExternal(t *testing.T) *db.MarkerStore {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = 11
	}
	m, err := db.OpenMarkerStore(filepath.Join(t.TempDir(), "erasure", "markers.sqlite"), key)
	if err != nil {
		t.Fatalf("OpenMarkerStore: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m
}

// First-run setup is unauthenticated and gated by CreateOwnerIfEmpty. The
// users table is no longer the whole gate: account erasure can empty it —
// a marker replay erases past the last-admin guard on a restored backup —
// and that must not reopen the endpoint. The durable setup_completed flag
// (migration 043), written in the same transaction as the first owner,
// keeps it closed (Codex's security review of #1522).
func TestCreateOwnerIfEmpty_SetupStaysClosedOnceAnOwnerExisted(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	if v, err := database.GetSetting(ctx, "setup_completed"); err != nil || v != "0" {
		t.Fatalf("setup_completed on a fresh database = %q, %v; want \"0\"", v, err)
	}
	uid, err := database.CreateOwnerIfEmpty(ctx, "the-owner", "hash", 1)
	if err != nil || uid == 0 {
		t.Fatalf("CreateOwnerIfEmpty = %d, %v", uid, err)
	}
	if v, err := database.GetSetting(ctx, "setup_completed"); err != nil || v != "1" {
		t.Fatalf("setup_completed after the first owner = %q, %v; want \"1\"", v, err)
	}
	if _, err := database.CreateOwnerIfEmpty(ctx, "second", "hash", 1); !errors.Is(err, db.ErrConflict) {
		t.Fatalf("second CreateOwnerIfEmpty = %v, want ErrConflict", err)
	}

	// The erasure's aftermath: no users at all, by any route.
	if _, err := database.ExecContext(ctx, `DELETE FROM users`); err != nil {
		t.Fatal(err)
	}
	if n, err := database.UserCount(ctx); err != nil || n != 0 {
		t.Fatalf("users after the delete = %d, %v", n, err)
	}
	if _, err := database.CreateOwnerIfEmpty(ctx, "takeover", "hash", 1); !errors.Is(err, db.ErrConflict) {
		t.Fatalf("CreateOwnerIfEmpty on an emptied table = %v, want ErrConflict — setup must stay closed", err)
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("users after the refused takeover = %d, %v; want 0", n, err)
	}

	// The operator's deliberate re-open, with filesystem access.
	if err := database.SetSetting(ctx, "setup_completed", "0"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateOwnerIfEmpty(ctx, "recovered-owner", "hash", 1); err != nil {
		t.Fatalf("CreateOwnerIfEmpty after the operator re-opened setup = %v", err)
	}
	if v, _ := database.GetSetting(ctx, "setup_completed"); v != "1" {
		t.Errorf("setup_completed after the recovery run = %q, want \"1\"", v)
	}
}

// A database from before migration 043 has no flag: the user count is still
// the gate, so an upgrade cannot lock an unset-up server out of its own
// first run.
func TestCreateOwnerIfEmpty_NoFlagFallsBackToTheCount(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `DELETE FROM settings WHERE key = 'setup_completed'`); err != nil {
		t.Fatal(err)
	}
	uid, err := database.CreateOwnerIfEmpty(ctx, "pre-043-owner", "hash", 1)
	if err != nil || uid == 0 {
		t.Fatalf("CreateOwnerIfEmpty without the flag = %d, %v", uid, err)
	}
	if v, err := database.GetSetting(ctx, "setup_completed"); err != nil || v != "1" {
		t.Errorf("setup_completed after that run = %q, %v; want it written", v, err)
	}
}

// LocateSequenceFloor recovers the ids a pre-floor marker file's markers
// name, by hashing candidates until every marker is accounted for: the
// tokens are one-way, and the live counter cannot stand in for the floor on
// a restored database (Codex's review of #1523).
func TestMarkerStore_LocateSequenceFloor(t *testing.T) {
	ctx := context.Background()
	m := openTestMarkersExternal(t)
	// A ceiling the test can exceed cheaply; production passes
	// db.SequenceFloorProbeCeiling.
	const probeCeiling = 2000

	// Nothing recorded: nothing to locate, and the answer is complete.
	got, complete, err := m.LocateSequenceFloor(ctx, db.SequenceFloorUsers, probeCeiling)
	if err != nil || got != 0 || !complete {
		t.Fatalf("LocateSequenceFloor on an empty file = %d, %v, %v", got, complete, err)
	}
	for _, id := range []int64{3, 41, 900} {
		tok, _, err := m.RecordPendingAccount(ctx, id, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := m.ConfirmAccount(ctx, tok); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.RecordMessagesSweep(ctx, 7, "2026-01-01 00:00:00", 0); err != nil {
		t.Fatal(err)
	}
	got, complete, err = m.LocateSequenceFloor(ctx, db.SequenceFloorUsers, probeCeiling)
	if err != nil || got != 900 || !complete {
		t.Errorf("users floor = %d, %v, %v; want 900 located completely", got, complete, err)
	}
	got, complete, err = m.LocateSequenceFloor(ctx, db.SequenceFloorChannels, probeCeiling)
	if err != nil || got != 7 || !complete {
		t.Errorf("channels floor = %d, %v, %v; want 7 located completely", got, complete, err)
	}
	if _, _, err := m.LocateSequenceFloor(ctx, "emoji", probeCeiling); err == nil {
		t.Error("LocateSequenceFloor on a table with no marker scope returned no error")
	}

	// An id past the probe's ceiling cannot be located: the floor comes back
	// as the lower bound it is, and says so, which the caller treats as
	// fatal rather than persisting it.
	tok, _, err := m.RecordPendingAccount(ctx, probeCeiling+5, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.ConfirmAccount(ctx, tok); err != nil {
		t.Fatal(err)
	}
	got, complete, err = m.LocateSequenceFloor(ctx, db.SequenceFloorUsers, probeCeiling)
	if err != nil || complete || got != 900 {
		t.Errorf("users floor with an out-of-range marker = %d, %v, %v; want 900 reported incomplete", got, complete, err)
	}
}
