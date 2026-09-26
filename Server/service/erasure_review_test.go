package service

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// countAudit counts audit_log rows matching where.
func countAudit(t *testing.T, database *db.DB, where string, args ...any) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM audit_log WHERE `+where, args...).Scan(&n); err != nil {
		t.Fatalf("count audit rows (%s): %v", where, err)
	}
	return n
}

// The production audit path is asynchronous: an entry about the subject
// queued just before the erasure would land raw after the transaction had
// rewritten the persisted rows. The erasure takes the writer's barrier
// before its transaction, so the entry is on disk for the UPDATE to
// rewrite, and installs the unlinking rule on commit, so a producer that
// enqueues after the erasure is written unlinked too; a refused erasure
// leaves everything as it was (B4-10).
func TestErasureService_QueuedAuditEntriesAreUnlinked(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, _ := seedErasureMember(t, database, dir)
	owner, err := database.GetUserByUsername(ctx, "erasure-owner")
	if err != nil || owner == nil {
		t.Fatalf("owner: %v", err)
	}
	// The timer is an hour away: the barrier is the only flush.
	w := db.NewAuditWriter(database, 64, 50, time.Hour)
	database.SetAuditWriter(w)
	w.Start(ctx)
	t.Cleanup(func() { w.Stop(context.Background()) })
	markers := newTestMarkers(t)
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	tok := svc.SubjectToken(uid)

	db.WriteAudit(ctx, database, owner.ID, "role_change", "user", uid, "member → moderator")
	db.WriteAudit(ctx, database, uid, "message_delete", "message", 9, "by the subject")
	if n := countAudit(t, database, `action IN ('role_change', 'message_delete')`); n != 0 {
		t.Fatalf("the entries were written synchronously (%d rows); the writer is not installed", n)
	}
	if err := svc.Erase(ctx, uid); err != nil {
		t.Fatalf("Erase: %v", err)
	}
	if n := countAudit(t, database, `actor_id = ? OR (target_type = 'user' AND target_id = ?)`, uid, uid); n != 0 {
		t.Errorf("%d audit rows still name the subject by id after the erasure", n)
	}
	if n := countAudit(t, database, `action = 'role_change' AND actor_id = ? AND target_id = 0 AND detail = '' AND subject_token = ?`, owner.ID, tok); n != 1 {
		t.Errorf("queued role_change rows written unlinked = %d, want 1", n)
	}
	if n := countAudit(t, database, `action = 'message_delete' AND actor_id = 0 AND detail = '' AND actor_token = ? AND subject_token IS NULL`, tok); n != 1 {
		t.Errorf("queued message_delete rows written unlinked = %d, want 1", n)
	}

	// A producer that read its rows before the commit and enqueues after
	// the erasure.
	db.WriteAudit(ctx, database, uid, "user_login", "user", uid, "203.0.113.9")
	if err := w.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countAudit(t, database, `action = 'user_login' AND actor_id = 0 AND target_id = 0 AND detail = '' AND subject_token = ? AND actor_token = ?`, tok, tok); n != 1 {
		t.Errorf("late entry rows written unlinked = %d, want 1", n)
	}
	if n := countAudit(t, database, `actor_id = ? OR (target_type = 'user' AND target_id = ?)`, uid, uid); n != 0 {
		t.Errorf("%d audit rows name the subject by id after the late entry", n)
	}

	// A refused erasure changes nothing: the entry queued before it went
	// down with its ids at the barrier and the transaction never ran, so
	// no rule exists and a later entry keeps its ids too. Without a marker
	// store there is no preflight, so the transaction itself refuses,
	// after the barrier.
	bare := NewErasureService(database)
	db.WriteAudit(ctx, database, owner.ID, "role_change", "user", owner.ID, "queued before the refused erasure")
	if err := bare.Erase(ctx, owner.ID); !errors.Is(err, db.ErrLastAdmin) {
		t.Fatalf("Erase(sole owner) = %v, want ErrLastAdmin", err)
	}
	if n := countAudit(t, database, `action = 'role_change' AND actor_id = ? AND target_id = ? AND detail = 'queued before the refused erasure' AND subject_token IS NULL AND actor_token IS NULL`, owner.ID, owner.ID); n != 1 {
		t.Errorf("the entry queued before the refused erasure = %d rows with its ids and detail, want 1", n)
	}
	db.WriteAudit(ctx, database, owner.ID, "settings_change", "settings", 0, "retention")
	if err := w.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countAudit(t, database, `action = 'settings_change' AND actor_id = ? AND detail = 'retention' AND subject_token IS NULL AND actor_token IS NULL`, owner.ID); n != 1 {
		t.Errorf("the owner's entry after the refused erasure = %d rows with their id, want 1", n)
	}
}

// A marker file from before the floors existed has none, and the counter it
// is paired with may itself be a restore — rolled back below the id a
// marker still names, which is the case the floors defend against. The
// first replay recovers the floor from the markers' own tokens, not from
// the counter (Codex's review of #1523).
func TestErasureService_ReplayMarkersRecoversMissingFloors(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, _ := seedErasureMember(t, database, dir)
	markers := newTestMarkers(t)
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	if err := svc.Erase(ctx, uid); err != nil {
		t.Fatalf("Erase: %v", err)
	}
	channelsSeq, err := database.SequenceValue(ctx, db.SequenceFloorChannels)
	if err != nil || channelsSeq == 0 {
		t.Fatalf("channels sequence = %d, %v; want the seeded channel counted", channelsSeq, err)
	}

	// The previous build's file: the marker, no floors. And the restore the
	// review describes: the counter rolled back below the erased id, so it
	// cannot stand in for the floor.
	rawFile, err := sql.Open("sqlite", markers.Path())
	if err != nil {
		t.Fatal(err)
	}
	defer rawFile.Close()
	if _, err := rawFile.ExecContext(ctx, `DELETE FROM sequence_floors`); err != nil {
		t.Fatal(err)
	}
	if floors, _ := markers.SequenceFloors(ctx); len(floors) != 0 {
		t.Fatalf("floors after the deletion = %v", floors)
	}
	if _, err := database.ExecContext(ctx, `UPDATE sqlite_sequence SET seq = ? WHERE name = 'users'`, uid-1); err != nil {
		t.Fatal(err)
	}

	if rep, err := svc.ReplayMarkers(ctx); err != nil || rep.Erased != 0 {
		t.Fatalf("ReplayMarkers = %+v, %v", rep, err)
	}
	floors, err := markers.SequenceFloors(ctx)
	if err != nil || floors[db.SequenceFloorUsers] < uid {
		t.Fatalf("floors after the first replay = %v, %v; want the users floor at or above the erased %d, not the rolled-back counter %d", floors, err, uid, uid-1)
	}
	if floors[db.SequenceFloorChannels] != channelsSeq {
		t.Errorf("channels floor = %v, want %d (no messages marker names a channel, so the counter stands)", floors, channelsSeq)
	}
	if got, _ := database.SequenceValue(ctx, db.SequenceFloorUsers); got < uid {
		t.Errorf("users counter after the replay = %d, want it raised to at least %d", got, uid)
	}
	fresh, err := database.CreateUser(ctx, "after-the-recovery", "hash", 4)
	if err != nil || fresh <= uid {
		t.Fatalf("the next account got id %d (%v), want one above the erased %d", fresh, err, uid)
	}
	if rep, err := svc.ReplayMarkers(ctx); err != nil || rep.Erased != 0 {
		t.Fatalf("second ReplayMarkers = %+v, %v; the new account must not match the old marker", rep, err)
	}
	if u, _ := database.GetUserByID(ctx, fresh); u == nil {
		t.Error("the account created after the recovery was erased by the old marker")
	}
}

// openFileDB opens a file-backed, migrated database at path.
func openFileDB(t *testing.T, path string) *db.DB {
	t.Helper()
	database, err := db.Open(path)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// restoreBackupOver closes database, copies backup over path and reopens.
func restoreBackupOver(t *testing.T, database *db.DB, path, backup string) *db.DB {
	t.Helper()
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	restored := openFileDB(t, path)
	t.Cleanup(func() { _ = restored.Close() })
	return restored
}

// A backup from before the admin handover holds the erased administrator as
// the only one. The replay must still erase them: the guard is a
// live-operation rule the erasure passed when it ran (B4-10).
func TestErasureService_ReplayErasesTheLastAdminOfAnOlderBackup(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "main.sqlite")
	database := openFileDB(t, dbPath)
	ctx := context.Background()
	first, err := database.CreateUser(ctx, "first-owner", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(t.TempDir(), "before-handover.db")
	if err := database.BackupToSafe(ctx, backup, filepath.Dir(backup)); err != nil {
		t.Fatal(err)
	}
	second, err := database.CreateUser(ctx, "second-owner", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	markers := newTestMarkers(t)
	svc := NewErasureService(database)
	svc.SetMarkers(markers)
	if err := svc.Erase(ctx, first); err != nil {
		t.Fatalf("Erase(first owner, with a second): %v", err)
	}

	restored := restoreBackupOver(t, database, dbPath, backup)
	if u, _ := restored.GetUserByID(ctx, first); u == nil {
		t.Fatal("the restore did not resurrect the first owner")
	}
	if u, _ := restored.GetUserByID(ctx, second); u != nil {
		t.Fatal("the backup should predate the second owner")
	}
	fresh := NewErasureService(restored)
	fresh.SetMarkers(markers)
	rep, err := fresh.ReplayMarkers(ctx)
	if err != nil {
		t.Fatalf("ReplayMarkers against the older backup: %v", err)
	}
	if rep.Erased != 1 {
		t.Fatalf("report = %+v, want the first owner erased again", rep)
	}
	if u, _ := restored.GetUserByID(ctx, first); u != nil {
		t.Error("the first owner survived the replay because they were the last administrator")
	}
	if n, _ := restored.CountAdminClassAccounts(ctx); n != 0 {
		t.Errorf("admin-class accounts after the replay = %d, want 0 (the backup's state)", n)
	}
	// The live guard is untouched: a new sole owner cannot be erased.
	newOwner, err := restored.CreateUser(ctx, "new-owner", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := fresh.Erase(ctx, newOwner); !errors.Is(err, db.ErrLastAdmin) {
		t.Errorf("Erase(new sole owner) = %v, want ErrLastAdmin", err)
	}
	if m, _ := markers.Markers(ctx); len(m) != 1 {
		t.Errorf("markers after the refused erasure = %+v, want only the first owner's", m)
	}
}

// The transaction commits, the process dies before the marker is confirmed,
// and a backup from before the erasure is restored: the pending marker is
// the only trace, and it must erase again (B4-10). A pending marker whose
// transaction never ran is applied too — the request behind it was
// authorised — and one whose account is gone is confirmed.
func TestErasureService_PendingMarkerSurvivesACrashAndARestore(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "main.sqlite")
	database := openFileDB(t, dbPath)
	ctx := context.Background()
	dir := t.TempDir()
	uid, files := seedErasureMember(t, database, dir)
	backup := filepath.Join(t.TempDir(), "before-erasure.db")
	if err := database.BackupToSafe(ctx, backup, filepath.Dir(backup)); err != nil {
		t.Fatal(err)
	}
	markers := newTestMarkers(t)
	// The crash, by hand: the pending marker, the transaction, no confirm.
	seq, err := database.SequenceValue(ctx, db.SequenceFloorUsers)
	if err != nil {
		t.Fatal(err)
	}
	tok, _, err := markers.RecordPendingAccount(ctx, uid, seq)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.EraseAccount(ctx, uid, tok); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}

	restored := restoreBackupOver(t, database, dbPath, backup)
	if u, _ := restored.GetUserByID(ctx, uid); u == nil {
		t.Fatal("the restore did not resurrect the account")
	}
	fresh := NewErasureService(restored)
	fresh.SetFiles(newTestStorage(t, dir))
	fresh.SetMarkers(markers)
	rep, err := fresh.ReplayMarkers(ctx)
	if err != nil {
		t.Fatalf("ReplayMarkers: %v", err)
	}
	if rep.Erased != 1 || rep.Confirmed != 0 {
		t.Fatalf("report = %+v, want the pending marker applied", rep)
	}
	if u, _ := restored.GetUserByID(ctx, uid); u != nil {
		t.Error("the account behind the pending marker survived the restore")
	}
	for _, f := range files {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s still on disk after the replayed erasure", f)
		}
	}
	if m, _ := markers.Markers(ctx); len(m) != 1 || m[0].State != db.MarkerRecorded {
		t.Errorf("markers after the replay = %+v, want the marker recorded", m)
	}

	// A pending marker whose transaction never ran.
	late, err := restored.CreateUser(ctx, "late-member", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := markers.RecordPendingAccount(ctx, late, 0); err != nil {
		t.Fatal(err)
	}
	// A pending marker whose account is gone: confirmed, nothing erased.
	goneID, err := restored.CreateUser(ctx, "gone-member", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := markers.RecordPendingAccount(ctx, goneID, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := restored.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, goneID); err != nil {
		t.Fatal(err)
	}
	rep, err = fresh.ReplayMarkers(ctx)
	if err != nil {
		t.Fatalf("second ReplayMarkers: %v", err)
	}
	if rep.Erased != 1 || rep.Confirmed != 1 {
		t.Errorf("second report = %+v, want 1 erased (the late member), 1 confirmed", rep)
	}
	if u, _ := restored.GetUserByID(ctx, late); u != nil {
		t.Error("the late member survived their pending marker")
	}
	for _, m := range mustMarkers(t, markers) {
		if m.State != db.MarkerRecorded {
			t.Errorf("marker %+v still pending after the replay", m)
		}
	}
}

func mustMarkers(t *testing.T, m *db.MarkerStore) []db.DeletionMarker {
	t.Helper()
	list, err := m.Markers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return list
}

// A restore rolls sqlite_sequence back with the rest of the file, and the
// next account would inherit the erased id — and the marker's token. The
// marker file keeps the counter as a floor and the replay raises the
// database to it first (B4-10).
func TestErasureService_ReplayMarkersRaisesTheSequenceFloors(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, _ := seedErasureMember(t, database, dir)
	markers := newTestMarkers(t)
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	if err := svc.Erase(ctx, uid); err != nil {
		t.Fatalf("Erase: %v", err)
	}
	floors, err := markers.SequenceFloors(ctx)
	if err != nil || floors[db.SequenceFloorUsers] < uid {
		t.Fatalf("floors after the erasure = %v, %v; want users >= %d", floors, err, uid)
	}
	rollBack := func() {
		t.Helper()
		if _, err := database.ExecContext(ctx, `UPDATE sqlite_sequence SET seq = ? WHERE name = 'users'`, uid-1); err != nil {
			t.Fatal(err)
		}
	}

	// Negative control: with the counter rolled back and no floor applied,
	// the next account takes the erased id, which the marker names.
	rollBack()
	reused, err := database.CreateUser(ctx, "reused-id", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	if reused != uid {
		t.Fatalf("negative control: the new account got id %d, not the erased %d", reused, uid)
	}
	if svc.SubjectToken(reused) != svc.SubjectToken(uid) {
		t.Fatal("negative control: the reused id does not hash to the marker")
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, reused); err != nil {
		t.Fatal(err)
	}

	// The start-up replay raises the counter to the floor first.
	rollBack()
	rep, err := svc.ReplayMarkers(ctx)
	if err != nil || rep.Erased != 0 {
		t.Fatalf("ReplayMarkers = %+v, %v; want nothing erased", rep, err)
	}
	fresh, err := database.CreateUser(ctx, "fresh-id", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	if fresh <= uid {
		t.Fatalf("the new account got id %d, within the erased range (<= %d)", fresh, uid)
	}
	rep, err = svc.ReplayMarkers(ctx)
	if err != nil || rep.Erased != 0 {
		t.Fatalf("ReplayMarkers with the new account = %+v, %v; want it left alone", rep, err)
	}
	if u, _ := database.GetUserByID(ctx, fresh); u == nil {
		t.Error("the new account was erased by the old marker")
	}
}

// A pre-floor marker file can already hold a floor written by a later
// erasure while an older marker still names a higher id, so the presence of
// a floor row is not evidence that every marker is covered. The probe runs
// until it has been recorded as complete, not until a row exists, and its
// result is merged with the row (Codex's second review of #1523).
func TestErasureService_ReplayMarkersProbesPastAnInsufficientFloor(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, _ := seedErasureMember(t, database, dir)
	markers := newTestMarkers(t)
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	if err := svc.Erase(ctx, uid); err != nil {
		t.Fatalf("Erase: %v", err)
	}

	// The legacy store: the marker for uid survives, and the only floor is a
	// lower one a later erasure recorded after a restore rolled the counter
	// back. No probe has been recorded.
	rawFile, err := sql.Open("sqlite", markers.Path())
	if err != nil {
		t.Fatal(err)
	}
	defer rawFile.Close()
	if _, err := rawFile.ExecContext(ctx, `DELETE FROM floor_probes`); err != nil {
		t.Fatal(err)
	}
	if _, err := rawFile.ExecContext(ctx, `UPDATE sequence_floors SET seq = ? WHERE name = ?`, uid-1, db.SequenceFloorUsers); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE sqlite_sequence SET seq = ? WHERE name = 'users'`, uid-1); err != nil {
		t.Fatal(err)
	}
	if floors, _ := markers.SequenceFloors(ctx); floors[db.SequenceFloorUsers] != uid-1 {
		t.Fatalf("floors before the replay = %v, want the insufficient %d", floors, uid-1)
	}

	if rep, err := svc.ReplayMarkers(ctx); err != nil || rep.Erased != 0 {
		t.Fatalf("ReplayMarkers = %+v, %v", rep, err)
	}
	if floors, _ := markers.SequenceFloors(ctx); floors[db.SequenceFloorUsers] < uid {
		t.Errorf("floors after the replay = %v, want the users floor raised to at least the erased %d", floors, uid)
	}
	fresh, err := database.CreateUser(ctx, "after-the-merge", "hash", 4)
	if err != nil || fresh <= uid {
		t.Fatalf("the next account got id %d (%v), want one above the erased %d", fresh, err, uid)
	}

	// The probe is recorded, so a later open does not pay for it again.
	if probed, err := markers.FloorProbed(ctx, db.SequenceFloorUsers); err != nil || !probed {
		t.Errorf("FloorProbed = %v, %v; want it recorded", probed, err)
	}
}

// A marker whose id lies beyond the probe ceiling leaves no safe floor, so
// start-up fails rather than persisting one that only looks safe (Codex's
// second review of #1523).
func TestErasureService_ReplayMarkersRefusesAnUnresolvableFloor(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	markers := newTestMarkers(t)
	svc := NewErasureService(database)
	svc.SetMarkers(markers)
	svc.floorProbeCeiling = 200

	tok, _, err := markers.RecordPendingAccount(ctx, 5000, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := markers.ConfirmAccount(ctx, tok); err != nil {
		t.Fatal(err)
	}
	rawFile, err := sql.Open("sqlite", markers.Path())
	if err != nil {
		t.Fatal(err)
	}
	defer rawFile.Close()
	if _, err := rawFile.ExecContext(ctx, `DELETE FROM floor_probes`); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ReplayMarkers(ctx); !errors.Is(err, ErrSequenceFloorUnresolved) {
		t.Fatalf("ReplayMarkers with an unreachable marker = %v, want ErrSequenceFloorUnresolved", err)
	}
	if probed, _ := markers.FloorProbed(ctx, db.SequenceFloorUsers); probed {
		t.Error("a refused probe was recorded as complete")
	}

	// The operator's way out, which the refusal's log names: set the floor
	// above the highest id ever handed out, then acknowledge it. The next
	// start-up honours it instead of probing again — without that, the
	// advertised remedy would not unblock anything (Codex's third review of
	// #1523).
	if err := markers.RaiseSequenceFloor(ctx, db.SequenceFloorUsers, 9000); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReplayMarkers(ctx); !errors.Is(err, ErrSequenceFloorUnresolved) {
		t.Fatalf("ReplayMarkers with a raised but unacknowledged floor = %v, want the refusal to stand", err)
	}
	if err := markers.MarkFloorProbed(ctx, db.SequenceFloorUsers); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReplayMarkers(ctx); err != nil {
		t.Fatalf("ReplayMarkers after the operator acknowledged the floor = %v", err)
	}
	if got, _ := database.SequenceValue(ctx, db.SequenceFloorUsers); got != 9000 {
		t.Errorf("users counter after the acknowledged floor = %d, want it raised to 9000", got)
	}
	if floors, _ := markers.SequenceFloors(ctx); floors[db.SequenceFloorUsers] != 9000 {
		t.Errorf("floors = %v, want the operator's 9000 kept", floors)
	}

	// And with a ceiling that reaches the marker, the probe establishes the
	// floor on its own.
	fresh := newTestMarkers(t)
	freshSvc := NewErasureService(database)
	freshSvc.SetMarkers(fresh)
	freshSvc.floorProbeCeiling = 6000
	tok, _, err = fresh.RecordPendingAccount(ctx, 5000, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := fresh.ConfirmAccount(ctx, tok); err != nil {
		t.Fatal(err)
	}
	rawFresh, err := sql.Open("sqlite", fresh.Path())
	if err != nil {
		t.Fatal(err)
	}
	defer rawFresh.Close()
	if _, err := rawFresh.ExecContext(ctx, `DELETE FROM floor_probes`); err != nil {
		t.Fatal(err)
	}
	if _, err := freshSvc.ReplayMarkers(ctx); err != nil {
		t.Fatalf("ReplayMarkers with a ceiling past the marker = %v", err)
	}
	if floors, _ := fresh.SequenceFloors(ctx); floors[db.SequenceFloorUsers] < 5000 {
		t.Errorf("floors = %v, want the users floor at least the located 5000", floors)
	}
}

// A backup taken before first-run setup rolls the users table and the setup
// flag back to their fresh state together, and the replay finds nothing to
// erase because the marked account is absent from it. The marker file is the
// only evidence left that this installation was ever set up, and it lives
// outside the database the restore overwrote — so the start-up replay closes
// the gate from it, keeping the unauthenticated setup endpoint shut (Codex's
// fifth review of #1523, landing here after that PR merged).
func TestErasureService_AccountMarkersCloseSetupAcrossAPreSetupRestore(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "main.sqlite")
	database := openFileDB(t, dbPath)
	ctx := context.Background()

	// The backup the maintenance loop takes before anyone has set up.
	preSetup := filepath.Join(t.TempDir(), "before-setup.db")
	if err := database.BackupToSafe(ctx, preSetup, filepath.Dir(preSetup)); err != nil {
		t.Fatal(err)
	}
	if v, err := database.GetSetting(ctx, db.SetupCompletedKey); err != nil || v != db.SetupOpen {
		t.Fatalf("the pre-setup flag = %q, %v; want it open", v, err)
	}

	// Setup, a second administrator, and an erasure that leaves a marker.
	owner, err := database.CreateOwnerIfEmpty(ctx, "the-owner", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	second, err := database.CreateUser(ctx, "second-admin", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	markers := newTestMarkers(t)
	svc := NewErasureService(database)
	svc.SetMarkers(markers)
	if err := svc.Erase(ctx, second); err != nil {
		t.Fatalf("Erase(second admin): %v", err)
	}
	_ = owner

	// The restore of that pre-setup backup: no users, and the flag back to
	// open, both from inside the database.
	restored := restoreBackupOver(t, database, dbPath, preSetup)
	if n, err := restored.UserCount(ctx); err != nil || n != 0 {
		t.Fatalf("users after the restore = %d, %v; want 0", n, err)
	}
	if v, _ := restored.GetSetting(ctx, db.SetupCompletedKey); v != db.SetupOpen {
		t.Fatalf("the flag after the restore = %q; want the restore to have reopened it", v)
	}

	fresh := NewErasureService(restored)
	fresh.SetMarkers(markers)
	rep, err := fresh.ReplayMarkers(ctx)
	if err != nil {
		t.Fatalf("ReplayMarkers: %v", err)
	}
	if rep.Erased != 0 {
		t.Fatalf("report = %+v; the marked account is absent from the restore, so nothing is erased", rep)
	}

	// The marker closed the gate even though the replay erased nothing.
	if v, err := restored.GetSetting(ctx, db.SetupCompletedKey); err != nil || v != db.SetupClosed {
		t.Errorf("the flag after the replay = %q, %v; want it closed by the marker", v, err)
	}
	if _, err := restored.CreateOwnerIfEmpty(ctx, "takeover", "hash", 1); !errors.Is(err, db.ErrConflict) {
		t.Errorf("CreateOwnerIfEmpty after the replay = %v, want ErrConflict", err)
	}
	setup := NewSetupService(restored)
	if needs, err := setup.NeedsSetup(ctx); err != nil || needs {
		t.Errorf("NeedsSetup after the replay = %v, %v; want false", needs, err)
	}

	// A marker file with no account markers leaves a genuinely fresh server
	// alone: retention markers are not evidence that anyone was set up.
	freshPath := filepath.Join(t.TempDir(), "fresh.sqlite")
	freshDB := openFileDB(t, freshPath)
	t.Cleanup(func() { _ = freshDB.Close() })
	empty := newTestMarkers(t)
	if err := empty.RecordMessagesSweep(ctx, 1, "2026-01-01 00:00:00", 0); err != nil {
		t.Fatal(err)
	}
	bare := NewErasureService(freshDB)
	bare.SetMarkers(empty)
	if _, err := bare.ReplayMarkers(ctx); err != nil {
		t.Fatal(err)
	}
	if v, err := freshDB.GetSetting(ctx, db.SetupCompletedKey); err != nil || v != db.SetupOpen {
		t.Errorf("a fresh server's flag after a replay with no account markers = %q, %v; want it still open", v, err)
	}
}
