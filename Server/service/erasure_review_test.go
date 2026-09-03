package service

import (
	"context"
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
// under its unlinking rule, and the rule outlives the barrier for a
// producer that enqueues after it (B4-10).
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
	if n := countAudit(t, database, `action = 'message_delete' AND actor_id = 0 AND detail = '' AND subject_token = ?`, tok); n != 1 {
		t.Errorf("queued message_delete rows written unlinked = %d, want 1", n)
	}

	// A producer that read its rows before the commit and enqueues after
	// the erasure.
	db.WriteAudit(ctx, database, uid, "user_login", "user", uid, "203.0.113.9")
	if err := w.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countAudit(t, database, `action = 'user_login' AND actor_id = 0 AND target_id = 0 AND detail = '' AND subject_token = ?`, tok); n != 1 {
		t.Errorf("late entry rows written unlinked = %d, want 1", n)
	}
	if n := countAudit(t, database, `actor_id = ? OR (target_type = 'user' AND target_id = ?)`, uid, uid); n != 0 {
		t.Errorf("%d audit rows name the subject by id after the late entry", n)
	}

	// A refused erasure withdraws the rule it installed: the sole owner
	// keeps their id. Without a marker store there is no preflight, so the
	// transaction itself refuses, after the barrier.
	bare := NewErasureService(database)
	if err := bare.Erase(ctx, owner.ID); !errors.Is(err, db.ErrLastAdmin) {
		t.Fatalf("Erase(sole owner) = %v, want ErrLastAdmin", err)
	}
	db.WriteAudit(ctx, database, owner.ID, "settings_change", "settings", 0, "retention")
	if err := w.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countAudit(t, database, `action = 'settings_change' AND actor_id = ? AND detail = 'retention' AND subject_token IS NULL`, owner.ID); n != 1 {
		t.Errorf("the owner's entry after the refused erasure = %d rows with their id, want 1", n)
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
