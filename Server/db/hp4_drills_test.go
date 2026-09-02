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
// protocol"): today's destructive operations exercised on a private copy of
// the alpha snapshot before any of B4-9..B4-11's new ones exist, each with
// its before/after subject inventory. Run with -v to read the inventories
// the scorecard pastes:
//
//	go test -count=1 -v -run 'TestHP4' ./db/
//
// The tracked snapshot is never opened: alphasnap.Copy hands each drill a
// byte copy in a directory the test owns.

// inventoryClass is one row of the appendix's subject-inventory queries.
type inventoryClass struct {
	key   string
	query string
	args  func(uid int64, uname string) []any
}

func byUID(uid int64, _ string) []any     { return []any{uid} }
func byUname(_ int64, uname string) []any { return []any{uname} }

var subjectInventory = []inventoryClass{
	{"1 identity row (not anonymised)", `SELECT COUNT(*) FROM users WHERE id = ? AND username NOT LIKE '[deleted-%'`, byUID},
	{"2 sessions", `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, byUID},
	{"3 api tokens", `SELECT COUNT(*) FROM api_tokens WHERE user_id = ?`, byUID},
	{"4 second factor", `SELECT COUNT(*) FROM users WHERE id = ? AND totp_secret IS NOT NULL`, byUID},
	{"6 rate-limit keys", `SELECT COUNT(*) FROM rate_lockouts WHERE key LIKE '%:' || ? OR key LIKE '%:' || ?`, func(uid int64, uname string) []any { return []any{uname, uid} }},
	{"7 login attempts", `SELECT COUNT(*) FROM login_attempts WHERE username = ?`, byUname},
	{"8a messages attributed", `SELECT COUNT(*) FROM messages WHERE user_id = ?`, byUID},
	{"8b messages with content", `SELECT COUNT(*) FROM messages WHERE user_id = ? AND content <> ''`, byUID},
	{"9 mentions naming the subject", `SELECT COUNT(*) FROM message_mentions WHERE mentioned_user_id = ?`, byUID},
	{"10 reactions", `SELECT COUNT(*) FROM reactions WHERE user_id = ?`, byUID},
	{"11 read states", `SELECT COUNT(*) FROM read_states WHERE user_id = ?`, byUID},
	{"12 attachment rows uploaded", `SELECT COUNT(*) FROM attachments WHERE uploader_id = ?`, byUID},
	{"14a dm participation", `SELECT COUNT(*) FROM dm_participants WHERE user_id = ?`, byUID},
	{"14b dm open state", `SELECT COUNT(*) FROM dm_open_state WHERE user_id = ?`, byUID},
	{"15 invites", `SELECT COUNT(*) FROM invites WHERE created_by = ? OR redeemed_by = ?`, func(uid int64, _ string) []any { return []any{uid, uid} }},
	{"16 emoji", `SELECT COUNT(*) FROM emoji WHERE uploaded_by = ?`, byUID},
	{"17 blocks", `SELECT COUNT(*) FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?`, func(uid int64, _ string) []any { return []any{uid, uid} }},
	{"18 channel user overrides", `SELECT COUNT(*) FROM channel_user_overrides WHERE user_id = ?`, byUID},
	{"19 voice state", `SELECT COUNT(*) FROM voice_states WHERE user_id = ?`, byUID},
	{"20 replay events", `SELECT COUNT(*) FROM events WHERE json_extract(payload, '$.user_id') = ? OR json_extract(payload, '$.user.id') = ?`, func(uid int64, _ string) []any { return []any{uid, uid} }},
	{"21 audit rows", `SELECT COUNT(*) FROM audit_log WHERE actor_id = ? OR (target_type = 'user' AND target_id = ?)`, func(uid int64, _ string) []any { return []any{uid, uid} }},
}

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
	out := map[string]int{}
	for _, c := range subjectInventory {
		out[c.key] = countQ(t, database, c.query, c.args(uid, uname)...)
	}
	return out
}

// logInventory prints the before/after table the scorecard pastes.
func logInventory(t *testing.T, title string, before, after map[string]int) {
	t.Helper()
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n| Class | Before | After |\n| --- | ---: | ---: |\n", title)
	for _, c := range subjectInventory {
		fmt.Fprintf(&b, "| %s | %d | %d |\n", c.key, before[c.key], after[c.key])
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

// The classes O1 leaves behind on purpose (rows that survive with the
// anonymised row as their anchor), keyed as in subjectInventory.
var o1Leftovers = map[string]bool{
	"8a messages attributed": true, "9 mentions naming the subject": true, "12 attachment rows uploaded": true,
	"15 invites": true, "16 emoji": true, "17 blocks": true, "18 channel user overrides": true,
	"20 replay events": true, "21 audit rows": true,
}

// runD1 performs O1 on the subject and checks exactly the predicted leftovers.
func runD1(t *testing.T, database *DB, uid int64, uname string, before map[string]int) map[string]int {
	t.Helper()
	if err := database.DeleteAccount(context.Background(), uid); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	after := takeInventory(t, database, uid, uname)
	for _, c := range subjectInventory {
		want := 0
		if o1Leftovers[c.key] {
			want = before[c.key]
		}
		if after[c.key] != want {
			t.Errorf("%s after O1 = %d, want %d", c.key, after[c.key], want)
		}
	}
	var username string
	_ = database.QueryRowContext(context.Background(), `SELECT username FROM users WHERE id = ?`, uid).Scan(&username)
	if !strings.HasPrefix(username, "[deleted-") {
		t.Errorf("username after O1 = %q, want anonymised", username)
	}
	return after
}

// D1 — O1 on a member with everything.
func TestHP4_D1_DeleteAccountLeavesExactlyThePredictedClasses(t *testing.T) {
	database, _ := drillCopy(t)
	uid, uname := pickSubject(t, database)
	before := takeInventory(t, database, uid, uname)
	if before["8a messages attributed"] == 0 || before["12 attachment rows uploaded"] == 0 || before["14a dm participation"] == 0 {
		t.Fatalf("subject %d (%s) is not a member with everything: %v", uid, uname, before)
	}
	after := runD1(t, database, uid, uname, before)
	logInventory(t, fmt.Sprintf("D1 — subject %d (%s)", uid, uname), before, after)
	// The FTS index dropped the subject's text with the content.
	if n := countQ(t, database, `SELECT COUNT(*) FROM messages WHERE user_id = ? AND deleted = 0`, uid); n != 0 {
		t.Errorf("%d of the subject's messages are not soft-deleted", n)
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
// O1 brings the account back in full, and nothing records the deletion.
func TestHP4_D2_RestoreResurrectsADeletedAccount(t *testing.T) {
	database, dbPath := drillCopy(t)
	uid, uname := pickSubject(t, database)
	before := takeInventory(t, database, uid, uname)
	backup := backupTo(t, database, "before-o1.db")
	runD1(t, database, uid, uname, before)

	restored := restoreOver(t, database, dbPath, backup)
	after := takeInventory(t, restored, uid, uname)
	logInventory(t, fmt.Sprintf("D2 — subject %d (%s), after restore", uid, uname), before, after)
	for _, c := range subjectInventory {
		if after[c.key] != before[c.key] {
			t.Errorf("%s after restore = %d, want %d (resurrected)", c.key, after[c.key], before[c.key])
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

// D4 — The replay window: O1 does not touch events; the pruner does.
func TestHP4_D4_ReplayEventsSurviveDeletionUntilPruned(t *testing.T) {
	database, _ := drillCopy(t)
	ctx := context.Background()
	uid, uname := pickSubject(t, database)
	payloads := []string{
		fmt.Sprintf(`{"type":"chat_message","channel_id":1,"user":{"id":%d,"username":%q},"content":"still in the window"}`, uid, uname),
		fmt.Sprintf(`{"type":"typing","channel_id":1,"user_id":%d}`, uid),
		fmt.Sprintf(`{"type":"chat_message","channel_id":1,"user":{"id":%d},"content":"and another"}`, uid),
	}
	for i, p := range payloads {
		if err := database.PersistEvent(ctx, int64(i+1), "chat_message", 1, []byte(p)); err != nil {
			t.Fatalf("PersistEvent: %v", err)
		}
	}
	before := takeInventory(t, database, uid, uname)
	after := runD1(t, database, uid, uname, before)
	logInventory(t, fmt.Sprintf("D4 — subject %d (%s), events seeded", uid, uname), before, after)
	if after["20 replay events"] != len(payloads) {
		t.Fatalf("replay events after O1 = %d, want %d (O1 leaves the window alone)", after["20 replay events"], len(payloads))
	}
	pruned, err := database.PruneEventsOlderThan(ctx, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatalf("PruneEventsOlderThan: %v", err)
	}
	left := countQ(t, database, subjectInventory[19].query, uid, uid)
	t.Logf("D4 — pruned %d rows with a cutoff after them; %d left naming the subject", pruned, left)
	if pruned != int64(len(payloads)) || left != 0 {
		t.Errorf("prune removed %d rows and left %d, want %d and 0", pruned, left, len(payloads))
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
