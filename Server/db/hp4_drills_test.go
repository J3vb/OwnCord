package db

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/internal/alphasnap"
)

// HP-4 baseline drills (docs/architecture/data-lifecycle.md, "Drill
// protocol"), on a private copy of the alpha snapshot, each with its
// before/after subject inventory. Written before B4-9 against the anonymising
// deletion; D1 and D4 now run the erasure that replaced it (D1 is the B4-9
// lineage checklist over SubjectInventory, D4 the replay-window purge HP-4
// decision 1 asked for) and D2 keeps its resurrection expectation, which
// B4-10's post-restore proof inverts. Run with -v to read the inventories:
//
//	go test -count=1 -v -run 'TestHP4' ./db/
//
// The tracked snapshot is never opened: alphasnap.Copy hands each drill a
// byte copy in a directory the test owns.

// drillCopy is a migrated private copy of the alpha snapshot and its path.
func drillCopy(t *testing.T) (*DB, string) {
	t.Helper()
	path, err := alphasnap.Copy(t.TempDir())
	if err != nil {
		t.Fatalf("alphasnap.Copy: %v", err)
	}
	database := openDrillDB(t, path)
	if err := Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return database, path
}

func openDrillDB(t *testing.T, path string) *DB {
	t.Helper()
	database, err := Open(path)
	if err != nil {
		t.Fatalf("db.Open(%s): %v", path, err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func countQ(t *testing.T, database *DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

// takeInventory runs the appendix queries for the subject.
func takeInventory(t *testing.T, database *DB, uid int64, uname string) map[string]int {
	t.Helper()
	out, err := database.TakeInventory(context.Background(), uid, uname)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	return out
}

// logInventory prints the before/after table the scorecard pastes.
func logInventory(t *testing.T, title string, before, after map[string]int) {
	t.Helper()
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n| Class | Before | After |\n| --- | ---: | ---: |\n", title)
	for _, c := range SubjectInventory {
		fmt.Fprintf(&b, "| %s | %d | %d |\n", c.Key, before[c.Key], after[c.Key])
	}
	t.Log(b.String())
}

// pickSubject is D1's member: the most messages, attachments, reactions and
// DM channels among the Member role.
func pickSubject(t *testing.T, database *DB) (int64, string) {
	t.Helper()
	var uid int64
	var uname string
	err := database.QueryRowContext(context.Background(), `
		SELECT u.id, u.username FROM users u
		WHERE u.role_id = 4
		ORDER BY (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id)
		       + 10 * (SELECT COUNT(*) FROM attachments a WHERE a.uploader_id = u.id)
		       + (SELECT COUNT(*) FROM reactions r WHERE r.user_id = u.id)
		       + 10 * (SELECT COUNT(*) FROM dm_participants d WHERE d.user_id = u.id) DESC
		LIMIT 1`).Scan(&uid, &uname)
	if err != nil {
		t.Fatalf("pickSubject: %v", err)
	}
	return uid, uname
}

// runD1 performs O1 — since B4-9 the erasure — on the subject and checks
// every inventory class is zero except the audit history B4-10 unlinks.
func runD1(t *testing.T, database *DB, uid int64, uname string, before map[string]int) map[string]int {
	t.Helper()
	job, err := database.EraseAccount(context.Background(), uid)
	if err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	after := takeInventory(t, database, uid, uname)
	for _, c := range SubjectInventory {
		want := 0
		if InventoryKeptByErasure[c.Key] {
			want = before[c.Key]
		}
		if after[c.Key] != want {
			t.Errorf("%s after erasure = %d, want %d", c.Key, after[c.Key], want)
		}
	}
	if len(job.Files) != before["12 attachment rows uploaded"] {
		t.Errorf("job lists %d files, want one per attachment row (%d)", len(job.Files), before["12 attachment rows uploaded"])
	}
	return after
}

// D1 — the B4-9 lineage checklist: erasure of a member with everything
// leaves zero in every class, and journals one file per attachment row.
func TestHP4_D1_ErasureLeavesNoClass(t *testing.T) {
	database, _ := drillCopy(t)
	uid, uname := pickSubject(t, database)
	before := takeInventory(t, database, uid, uname)
	if before["8a messages attributed"] == 0 || before["12 attachment rows uploaded"] == 0 || before["14a dm participation"] == 0 {
		t.Fatalf("subject %d is not a member with everything: %v", uid, before)
	}
	after := runD1(t, database, uid, uname, before)
	logInventory(t, fmt.Sprintf("D1 — subject %d", uid), before, after)
	if n := countQ(t, database, `SELECT COUNT(*) FROM users WHERE id = ?`, uid); n != 0 {
		t.Errorf("users row survived: %d", n)
	}
}

// restoreOver closes the database, copies the backup over its file and
// reopens it, as the admin restore does (the handler additionally takes a
// pre-restore safety backup and refuses a file that fails the integrity
// check).
func restoreOver(t *testing.T, database *DB, dbPath, backup string) *DB {
	t.Helper()
	if err := database.Close(); err != nil {
		t.Fatalf("Close before restore: %v", err)
	}
	data, err := os.ReadFile(backup)
	if err != nil {
		t.Fatalf("read backup: %v", err)
	}
	if err := os.WriteFile(dbPath, data, 0o600); err != nil {
		t.Fatalf("write restored database: %v", err)
	}
	reopened := openDrillDB(t, dbPath)
	if err := Migrate(reopened); err != nil {
		t.Fatalf("Migrate after restore: %v", err)
	}
	return reopened
}

func backupTo(t *testing.T, database *DB, name string) string {
	t.Helper()
	safe := t.TempDir()
	path := filepath.Join(safe, name)
	if err := database.BackupToSafe(context.Background(), path, safe); err != nil {
		t.Fatalf("BackupToSafe: %v", err)
	}
	return path
}

// D2 — Resurrection, the negative control for B4-10: a backup from before
// the erasure brings the account back in full, and nothing in the restored
// file records that it happened.
func TestHP4_D2_RestoreResurrectsADeletedAccount(t *testing.T) {
	database, dbPath := drillCopy(t)
	uid, uname := pickSubject(t, database)
	before := takeInventory(t, database, uid, uname)
	backup := backupTo(t, database, "before-o1.db")
	runD1(t, database, uid, uname, before)

	restored := restoreOver(t, database, dbPath, backup)
	after := takeInventory(t, restored, uid, uname)
	logInventory(t, fmt.Sprintf("D2 — subject %d (%s), after restore", uid, uname), before, after)
	for _, c := range SubjectInventory {
		if after[c.Key] != before[c.Key] {
			t.Errorf("%s after restore = %d, want %d (resurrected)", c.Key, after[c.Key], before[c.Key])
		}
	}
	var username string
	_ = restored.QueryRowContext(context.Background(), `SELECT username FROM users WHERE id = ?`, uid).Scan(&username)
	if username != uname {
		t.Errorf("username after restore = %q, want %q", username, uname)
	}
	if n := countQ(t, restored, `SELECT COUNT(*) FROM audit_log WHERE action = 'account_deleted' AND target_id = ?`, uid); n != 0 {
		t.Errorf("%d account_deleted rows survived the restore; the backup predates the deletion", n)
	}
}

// D3 — Restore over newer data: what arrived after the backup is gone, and
// the schema is HEAD's again on the next open.
func TestHP4_D3_RestoreDropsNewerData(t *testing.T) {
	database, dbPath := drillCopy(t)
	ctx := context.Background()
	schemaBefore := countQ(t, database, `SELECT COUNT(*) FROM schema_versions`)
	backup := backupTo(t, database, "before-newer.db")

	newcomer, err := database.CreateUser(ctx, "hp4-newcomer", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	for i := range 5 {
		if _, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content) VALUES (1, ?, ?)`, newcomer, fmt.Sprintf("after the backup %d", i)); err != nil {
			t.Fatalf("insert message: %v", err)
		}
	}
	if n := countQ(t, database, `SELECT COUNT(*) FROM messages`); n != 20005 {
		t.Fatalf("messages before restore = %d, want 20005", n)
	}

	restored := restoreOver(t, database, dbPath, backup)
	messages := countQ(t, restored, `SELECT COUNT(*) FROM messages`)
	users := countQ(t, restored, `SELECT COUNT(*) FROM users`)
	newcomers := countQ(t, restored, `SELECT COUNT(*) FROM users WHERE username = 'hp4-newcomer'`)
	schemaAfter := countQ(t, restored, `SELECT COUNT(*) FROM schema_versions`)
	t.Logf("D3 — messages %d (want 20000), users %d (want 100), newcomer rows %d (want 0), schema_versions %d → %d", messages, users, newcomers, schemaBefore, schemaAfter)
	if messages != 20000 || users != 100 || newcomers != 0 {
		t.Errorf("restore kept newer data: messages %d, users %d, newcomer %d", messages, users, newcomers)
	}
	if schemaAfter != schemaBefore {
		t.Errorf("schema_versions after restore = %d, want %d", schemaAfter, schemaBefore)
	}
}

// D4 — The replay window: the erasure purges the subject's events (HP-4
// decision 1) and leaves everyone else's for the pruner.
func TestHP4_D4_ErasurePurgesTheSubjectsReplayEvents(t *testing.T) {
	database, _ := drillCopy(t)
	ctx := context.Background()
	uid, uname := pickSubject(t, database)
	var other int64
	if err := database.QueryRowContext(ctx, `SELECT id FROM users WHERE id != ? ORDER BY id LIMIT 1`, uid).Scan(&other); err != nil {
		t.Fatalf("pick another user: %v", err)
	}
	// Persisted rows are the wire envelope the hub sends (ws.wrapWithSeq):
	// seq, type, then the payload object.
	payloads := []string{
		fmt.Sprintf(`{"seq":1,"type":"chat_message","payload":{"channel_id":1,"user":{"id":%d,"username":%q},"content":"still in the window"}}`, uid, uname),
		fmt.Sprintf(`{"seq":2,"type":"typing","payload":{"channel_id":1,"user_id":%d}}`, uid),
		fmt.Sprintf(`{"seq":3,"type":"chat_message","payload":{"channel_id":1,"user":{"id":%d},"content":"and another"}}`, uid),
		fmt.Sprintf(`{"seq":4,"type":"typing","payload":{"channel_id":1,"user_id":%d}}`, other),
	}
	for i, p := range payloads {
		if err := database.PersistEvent(ctx, int64(i+1), "chat_message", 1, []byte(p)); err != nil {
			t.Fatalf("PersistEvent: %v", err)
		}
	}
	before := takeInventory(t, database, uid, uname)
	if before["20 replay events"] != 3 {
		t.Fatalf("seeded events naming the subject = %d, want 3", before["20 replay events"])
	}
	after := runD1(t, database, uid, uname, before)
	logInventory(t, fmt.Sprintf("D4 — subject %d, events seeded", uid), before, after)
	total := countQ(t, database, `SELECT COUNT(*) FROM events`)
	t.Logf("D4 — events naming the subject %d → %d; other users' events kept: %d", before["20 replay events"], after["20 replay events"], total)
	if after["20 replay events"] != 0 || total != 1 {
		t.Errorf("erasure left %d events naming the subject and %d in total, want 0 and 1", after["20 replay events"], total)
	}
}

// D5 — Stranded files: the sweep deletes rows first and removes files
// after, so a stop between the two leaves a file with no row.
func TestHP4_D5_OrphanSweepCanStrandAFile(t *testing.T) {
	database, _ := drillCopy(t)
	ctx := context.Background()
	rows, err := database.QueryContext(ctx, `
		SELECT a.id, a.stored_as, a.size, a.message_id FROM attachments a
		WHERE a.message_id IS NOT NULL
		  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar = a.id OR u.avatar = a.stored_as)
		ORDER BY a.id LIMIT 2`)
	if err != nil {
		t.Fatalf("select attachments: %v", err)
	}
	type att struct {
		id, storedAs string
		size         int64
		messageID    int64
	}
	var picked []att
	for rows.Next() {
		var a att
		if err := rows.Scan(&a.id, &a.storedAs, &a.size, &a.messageID); err != nil {
			t.Fatalf("scan: %v", err)
		}
		picked = append(picked, a)
	}
	_ = rows.Close()
	if len(picked) != 2 {
		t.Fatalf("need two linked attachments, found %d", len(picked))
	}

	// Their messages are soft-deleted and the rows are older than the
	// sweep's grace period; the files exist on disk, size per the row.
	storageDir := t.TempDir()
	old := time.Now().Add(-2 * time.Hour).UTC().Format(sqliteTimeLayout)
	for _, a := range picked {
		if _, err := database.ExecContext(ctx, `UPDATE messages SET deleted = 1, content = '' WHERE id = ?`, a.messageID); err != nil {
			t.Fatalf("soft-delete message: %v", err)
		}
		if _, err := database.ExecContext(ctx, `UPDATE attachments SET uploaded_at = ? WHERE id = ?`, old, a.id); err != nil {
			t.Fatalf("age attachment: %v", err)
		}
		if err := os.WriteFile(filepath.Join(storageDir, a.storedAs), make([]byte, a.size), 0o600); err != nil {
			t.Fatalf("seed file: %v", err)
		}
	}
	filesBefore := countFiles(t, storageDir)

	swept, err := database.DeleteOrphanedAttachments(ctx, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatalf("DeleteOrphanedAttachments: %v", err)
	}
	if len(swept) != 2 {
		t.Fatalf("sweep returned %d files, want the 2 seeded: %v", len(swept), swept)
	}
	// The maintenance tick would now remove every returned file; it stops
	// after the first — the process was killed, or the unlink failed.
	if err := os.Remove(filepath.Join(storageDir, swept[0])); err != nil {
		t.Fatalf("remove first file: %v", err)
	}
	rowsLeft := countQ(t, database, `SELECT COUNT(*) FROM attachments WHERE stored_as IN (?, ?)`, swept[0], swept[1])
	filesAfter := countFiles(t, storageDir)
	stranded := 0
	for _, name := range swept[1:] {
		if _, err := os.Stat(filepath.Join(storageDir, name)); err == nil {
			stranded++
		}
	}
	t.Logf("D5 — rows for the swept files: 2 → %d; files on disk: %d → %d; stranded (file, no row): %d", rowsLeft, filesBefore, filesAfter, stranded)
	if rowsLeft != 0 || filesAfter != 1 || stranded != 1 {
		t.Errorf("stranded-file fixture wrong: rows %d, files %d, stranded %d", rowsLeft, filesAfter, stranded)
	}
}

func countFiles(t *testing.T, dir string) int {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	return len(entries)
}
