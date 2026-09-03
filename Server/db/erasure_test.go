package db_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// eraseSubject is a member with a row in every class the erasure touches
// that a unit test can seed directly.
type eraseSubject struct {
	id, other, channel int64
	username           string
}

func seedEraseSubject(t *testing.T, database *db.DB) eraseSubject {
	t.Helper()
	ctx := context.Background()
	other := seedUser(t, database, "other-user")
	setRole(t, database, other, 2)
	uid := seedUser(t, database, "Subject_User")
	chID := seedChannel(t, database, "general-erase")
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := database.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	msg, err := database.CreateMessageWithMentions(ctx, chID, uid, "hello @other-user needleword", nil, []int64{other}, false)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	otherMsg, err := database.CreateMessageWithMentions(ctx, chID, other, "hi @Subject_User", nil, []int64{uid}, false)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions(other): %v", err)
	}
	dm, _, err := database.GetOrCreateDMChannel(ctx, uid, other)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	exec(`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`, uid, dm.ID)
	exec(`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`, other, dm.ID)
	exec(`INSERT INTO sessions (user_id, token, expires_at) VALUES (?, 'tok-subject', datetime('now', '+1 day'))`, uid)
	exec(`INSERT INTO api_tokens (user_id, token_hash, label) VALUES (?, 'hash-subject', 'ci')`, uid)
	exec(`UPDATE users SET totp_secret = 'SECRET', avatar = '/api/v1/files/avatar-subject' WHERE id = ?`, uid)
	exec(`INSERT INTO totp_recovery_codes (user_id, code_hash, created_at) VALUES (?, 'h', datetime('now'))`, uid)
	exec(`INSERT INTO totp_used_codes (user_id, code_hash, expires_at) VALUES (?, 'h', datetime('now', '+1 minute'))`, uid)
	exec(`INSERT INTO recovery_kits (user_id, verifier, created_at) VALUES (?, 'v', datetime('now'))`, uid)
	exec(`INSERT INTO recovery_assists (user_id, verifier, issued_by, verification, created_at, expires_at) VALUES (?, 'v', ?, 'voice_call', datetime('now'), datetime('now', '+15 minutes'))`, other, uid)
	exec(`INSERT INTO rate_lockouts (key, expires_at) VALUES ('delete_lock:' || ?, datetime('now', '+15 minutes'))`, uid)
	exec(`INSERT INTO rate_lockouts (key, expires_at) VALUES ('login_user_lock:subject_user', datetime('now', '+15 minutes'))`)
	exec(`INSERT INTO rate_lockouts (key, expires_at) VALUES ('login_user_lock:other-user', datetime('now', '+15 minutes'))`)
	exec(`INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, 'x')`, otherMsg.ID, uid)
	exec(`INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, 'y')`, msg.ID, other)
	exec(`INSERT INTO read_states (user_id, channel_id, last_message_id) VALUES (?, ?, 0)`, uid, chID)
	exec(`INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploader_id) VALUES ('att-1', ?, 'a.png', 'stored-a.png', 'image/png', 1, ?)`, msg.ID, uid)
	exec(`INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id) VALUES ('avatar-subject', 'me.png', 'stored-avatar.png', 'image/png', 1, ?)`, uid)
	exec(`INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploader_id) VALUES ('att-other', ?, 'o.png', 'stored-other.png', 'image/png', 1, ?)`, otherMsg.ID, other)
	exec(`INSERT INTO invites (code, created_by) VALUES ('subject-invite', ?)`, uid)
	exec(`INSERT INTO invites (code, created_by, redeemed_by) VALUES ('other-invite', ?, ?)`, other, uid)
	exec(`INSERT INTO emoji (shortcode, filename, uploaded_by) VALUES ('wave', 'emoji-wave', ?)`, uid)
	exec(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)`, uid, other)
	exec(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)`, other, uid)
	exec(`INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, 1, 0)`, chID, uid)
	exec(`INSERT INTO voice_states (user_id, channel_id, joined_at) VALUES (?, ?, datetime('now'))`, uid, chID)
	exec(`INSERT INTO events (seq, event_type, payload, channel_id) VALUES (1, 'typing', ?, ?)`, fmt.Sprintf(`{"type":"typing","user_id":%d}`, uid), chID)
	exec(`INSERT INTO events (seq, event_type, payload, channel_id) VALUES (2, 'chat_message', ?, ?)`, fmt.Sprintf(`{"type":"chat_message","user":{"id":%d}}`, uid), chID)
	exec(`INSERT INTO events (seq, event_type, payload, channel_id) VALUES (3, 'typing', ?, ?)`, fmt.Sprintf(`{"type":"typing","user_id":%d}`, other), chID)
	return eraseSubject{id: uid, other: other, channel: chID, username: "Subject_User"}
}

func TestEraseAccount_EveryInventoryClassIsZero(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	before, err := database.TakeInventory(ctx, sub.id, sub.username)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	for _, c := range db.SubjectInventory {
		if c.Key == "7 login attempts" || c.Key == "21 audit rows" {
			continue
		}
		if before[c.Key] == 0 {
			t.Errorf("fixture holds nothing in class %q; the checklist would prove nothing there", c.Key)
		}
	}

	job, err := database.EraseAccount(ctx, sub.id)
	if err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	after, err := database.TakeInventory(ctx, sub.id, sub.username)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	for _, c := range db.SubjectInventory {
		if after[c.Key] != 0 {
			t.Errorf("%s after erasure = %d, want 0", c.Key, after[c.Key])
		}
	}
	wantFiles := map[string]bool{"stored-a.png": true, "stored-avatar.png": true}
	if len(job.Files) != len(wantFiles) {
		t.Errorf("job files = %v, want the subject's two", job.Files)
	}
	for _, f := range job.Files {
		if !wantFiles[f] {
			t.Errorf("job lists %q, which is not the subject's", f)
		}
	}

	// What must survive: the other user's message, reaction, attachment,
	// lockout key and event; the redeemed invite with its link cleared; the
	// assets, now the admin's; the assisted credential, issuer unlinked.
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := database.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
	if n := count(`SELECT COUNT(*) FROM messages WHERE user_id = ?`, sub.other); n != 1 {
		t.Errorf("other user's messages = %d, want 1", n)
	}
	if n := count(`SELECT COUNT(*) FROM attachments WHERE id = 'att-other' AND message_id IS NOT NULL`); n != 1 {
		t.Errorf("other user's attachment rows = %d, want 1 still linked", n)
	}
	if n := count(`SELECT COUNT(*) FROM rate_lockouts`); n != 1 {
		t.Errorf("lockout keys left = %d, want 1 (the other user's)", n)
	}
	if n := count(`SELECT COUNT(*) FROM events`); n != 1 {
		t.Errorf("events left = %d, want 1 (the other user's)", n)
	}
	if n := count(`SELECT COUNT(*) FROM invites WHERE code = 'other-invite' AND redeemed_by IS NULL`); n != 1 {
		t.Errorf("redeemed invite: want the row kept with redeemed_by cleared")
	}
	if n := count(`SELECT COUNT(*) FROM invites WHERE code = 'subject-invite'`); n != 0 {
		t.Errorf("the subject's invite survived")
	}
	if n := count(`SELECT COUNT(*) FROM emoji WHERE shortcode = 'wave' AND uploaded_by = ?`, sub.other); n != 1 {
		t.Errorf("emoji not reassigned to the remaining admin")
	}
	if n := count(`SELECT COUNT(*) FROM recovery_assists WHERE user_id = ? AND issued_by = 0`, sub.other); n != 1 {
		t.Errorf("assisted credential issued by the subject: want kept with issued_by = 0")
	}
	if n := count(`SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'needleword'`); n != 0 {
		t.Errorf("FTS still finds the subject's text")
	}
	// The other user's reaction on the subject's message cascaded with it.
	if n := count(`SELECT COUNT(*) FROM reactions`); n != 0 {
		t.Errorf("reactions left = %d, want 0", n)
	}
}

func TestEraseAccount_JobIsListedUntilCompleted(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	job, err := database.EraseAccount(ctx, sub.id)
	if err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}

	jobs, err := database.ListUnfinishedErasureJobs(ctx)
	if err != nil {
		t.Fatalf("ListUnfinishedErasureJobs: %v", err)
	}
	if len(jobs) != 1 || jobs[0].ID != job.ID || jobs[0].State != db.ErasureStateDBDone || len(jobs[0].Files) != 2 {
		t.Fatalf("unfinished jobs = %+v, want the one just written with 2 files", jobs)
	}

	if err := database.RecordErasureJobAttempt(ctx, job.ID, 1, "remove stored-a.png: EIO"); err != nil {
		t.Fatalf("RecordErasureJobAttempt: %v", err)
	}
	got, err := database.GetErasureJob(ctx, job.ID)
	if err != nil {
		t.Fatalf("GetErasureJob: %v", err)
	}
	if got.Attempts != 1 || got.FilesRemoved != 1 || got.LastError == "" || got.State != db.ErasureStateDBDone {
		t.Errorf("after a failed attempt: %+v", got)
	}

	if err := database.CompleteErasureJob(ctx, job.ID, 2); err != nil {
		t.Fatalf("CompleteErasureJob: %v", err)
	}
	got, err = database.GetErasureJob(ctx, job.ID)
	if err != nil {
		t.Fatalf("GetErasureJob: %v", err)
	}
	if got.State != db.ErasureStateDone || got.FilesRemoved != 2 || got.LastError != "" || got.Attempts != 2 {
		t.Errorf("after completion: %+v", got)
	}
	jobs, err = database.ListUnfinishedErasureJobs(ctx)
	if err != nil || len(jobs) != 0 {
		t.Errorf("unfinished jobs after completion = %v, %v; want none", jobs, err)
	}
	if _, err := database.GetErasureJob(ctx, job.ID+100); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("GetErasureJob(missing) = %v, want ErrNotFound", err)
	}
}

// A statement failing late in the transaction — the shape a full disk takes
// (data-lifecycle O1 A2) — rolls everything back: the account, its rows and
// its files' journal are exactly as before, and the erasure is retryable.
func TestEraseAccount_FailingStatementRollsBackEverything(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	before, err := database.TakeInventory(ctx, sub.id, sub.username)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`CREATE TRIGGER fault_full BEFORE INSERT ON erasure_jobs BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END`); err != nil {
		t.Fatalf("install fault: %v", err)
	}

	_, err = database.EraseAccount(ctx, sub.id)
	if err == nil {
		t.Fatal("EraseAccount succeeded through the fault")
	}
	if errors.Is(err, db.ErrLastAdmin) || errors.Is(err, db.ErrNotFound) {
		t.Fatalf("EraseAccount error = %v, want the store fault", err)
	}

	after, err := database.TakeInventory(ctx, sub.id, sub.username)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	for _, c := range db.SubjectInventory {
		if after[c.Key] != before[c.Key] {
			t.Errorf("%s: %d before, %d after the rolled-back erasure", c.Key, before[c.Key], after[c.Key])
		}
	}
	var jobs int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM erasure_jobs`).Scan(&jobs); err != nil || jobs != 0 {
		t.Errorf("erasure_jobs rows = %d (%v), want 0", jobs, err)
	}
	var secureDelete int
	if err := database.QueryRowContext(ctx, `PRAGMA secure_delete`).Scan(&secureDelete); err != nil || secureDelete != 0 {
		t.Errorf("secure_delete after the failed erasure = %d (%v), want restored to 0", secureDelete, err)
	}

	if _, err := database.ExecContext(ctx, `DROP TRIGGER fault_full`); err != nil {
		t.Fatalf("drop fault: %v", err)
	}
	if _, err := database.EraseAccount(ctx, sub.id); err != nil {
		t.Fatalf("retry after the fault cleared: %v", err)
	}
}

// With nobody left to own them, the sole account's emoji are deleted and
// their files join the job. (The last-admin guard blocks the
// last admin-class account, so the sole survivor here is a Member on a
// server whose admin roles hold nobody — the guard skips that case.)
func TestEraseAccount_SoleAccountAssetsAreDeleted(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "lonely")
	if _, err := database.ExecContext(ctx, `INSERT INTO emoji (shortcode, filename, uploaded_by) VALUES ('solo', 'emoji-solo', ?)`, uid); err != nil {
		t.Fatalf("seed emoji: %v", err)
	}
	job, err := database.EraseAccount(ctx, uid)
	if err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	var left int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM emoji`).Scan(&left); err != nil || left != 0 {
		t.Errorf("assets left = %d (%v), want 0", left, err)
	}
	if len(job.Files) != 1 || job.Files[0] != "emoji-solo" {
		t.Errorf("job files = %v, want the emoji file", job.Files)
	}
}

func TestEraseAccount_LockoutSuffixIsExact(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "ab")
	// A key whose value merely ends with the id or the name must survive:
	// user 1 vs "…:11", "ab" vs "…:cab".
	for _, k := range []string{"login_user_lock:cab", fmt.Sprintf("delete_lock:1%d", uid), fmt.Sprintf("delete_lock:%d", uid), "login_user_lock:AB"} {
		if _, err := database.ExecContext(ctx, `INSERT INTO rate_lockouts (key, expires_at) VALUES (?, datetime('now', '+15 minutes'))`, k); err != nil {
			t.Fatalf("seed %s: %v", k, err)
		}
	}
	if _, err := database.EraseAccount(ctx, uid); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	rows, err := database.QueryContext(ctx, `SELECT key FROM rate_lockouts ORDER BY key`)
	if err != nil {
		t.Fatalf("list lockouts: %v", err)
	}
	defer rows.Close()
	var left []string
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		left = append(left, k)
	}
	want := fmt.Sprintf("[delete_lock:1%d login_user_lock:cab]", uid)
	if got := fmt.Sprint(left); got != want {
		t.Errorf("lockout keys left = %s, want %s", got, want)
	}
}

func TestReferencedStoredFiles(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "ref")
	if _, err := database.ExecContext(ctx, `INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id) VALUES ('a', 'a', 'stored-att', 'image/png', 1, ?)`, uid); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO emoji (shortcode, filename, uploaded_by) VALUES ('e', 'stored-emoji', ?)`, uid); err != nil {
		t.Fatalf("seed emoji: %v", err)
	}
	names := make([]string, 0, 453)
	names = append(names, "stored-att", "stored-emoji", "stranded")
	// Past one chunk, so the batching runs more than once.
	for i := range 450 {
		names = append(names, fmt.Sprintf("unknown-%d", i))
	}
	got, err := database.ReferencedStoredFiles(ctx, names)
	if err != nil {
		t.Fatalf("ReferencedStoredFiles: %v", err)
	}
	if len(got) != 2 || !got["stored-att"] || !got["stored-emoji"] {
		t.Errorf("referenced = %v, want the two named by rows", got)
	}
	if empty, err := database.ReferencedStoredFiles(ctx, nil); err != nil || len(empty) != 0 {
		t.Errorf("ReferencedStoredFiles(nil) = %v, %v", empty, err)
	}
}
