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
	// The wire envelope shape (ws.wrapWithSeq): the ids live under payload.
	exec(`INSERT INTO events (seq, event_type, payload, channel_id) VALUES (1, 'typing', ?, ?)`, fmt.Sprintf(`{"seq":1,"type":"typing","payload":{"user_id":%d}}`, uid), chID)
	exec(`INSERT INTO events (seq, event_type, payload, channel_id) VALUES (2, 'chat_message', ?, ?)`, fmt.Sprintf(`{"seq":2,"type":"chat_message","payload":{"user":{"id":%d}}}`, uid), chID)
	exec(`INSERT INTO events (seq, event_type, payload, channel_id) VALUES (3, 'typing', ?, ?)`, fmt.Sprintf(`{"seq":3,"type":"typing","payload":{"user_id":%d}}`, other), chID)
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
	// Files done, purge still outstanding: listed until it is recorded.
	if jobs, err := database.ListUnfinishedErasureJobs(ctx); err != nil || len(jobs) != 1 {
		t.Errorf("unfinished jobs with the purge outstanding = %v, %v; want the job", jobs, err)
	}
	if err := database.MarkErasureJobReplayPurged(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	jobs, err = database.ListUnfinishedErasureJobs(ctx)
	if err != nil || len(jobs) != 0 {
		t.Errorf("unfinished jobs after completion and purge = %v, %v; want none", jobs, err)
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

// The predicate reads the envelope the hub persists — the ids sit under
// payload — in each shape a frame can name a user; a flattened payload,
// which no production path writes, must not match, or the checklist would
// pass on a shape the store never holds.
func TestDeleteEventsForUser_MatchesEveryEnvelopeShape(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	const uid, other = 42, 43
	rows := []struct {
		payload string
		names   bool
	}{
		{fmt.Sprintf(`{"seq":1,"type":"presence","payload":{"user_id":%d,"status":"online"}}`, uid), true},
		{fmt.Sprintf(`{"seq":2,"type":"chat_message","payload":{"id":9,"user":{"id":%d,"username":"x"},"content":"hi","mentions":[]}}`, uid), true},
		{fmt.Sprintf(`{"seq":3,"type":"chat_message","payload":{"id":10,"user":{"id":%d},"content":"@you","mentions":[%d,%d]}}`, other, other, uid), true},
		{fmt.Sprintf(`{"seq":4,"type":"voice_e2ee_offer","payload":{"from_user_id":%d,"encrypted_key":"k"}}`, uid), true},
		{fmt.Sprintf(`{"seq":5,"type":"member_ban","payload":{"user_id":%d}}`, uid), true},
		{fmt.Sprintf(`{"seq":6,"type":"typing","payload":{"user_id":%d}}`, other), false},
		{fmt.Sprintf(`{"seq":7,"type":"chat_message","payload":{"user":{"id":%d},"mentions":[%d]}}`, other, other), false},
		{fmt.Sprintf(`{"seq":8,"type":"typing","user_id":%d}`, uid), false}, // flattened: not a persisted shape
		{`{"seq":9,"type":"roles_update","payload":{"roles":[]}}`, false},
	}
	for i, r := range rows {
		if _, err := database.ExecContext(ctx, `INSERT INTO events (seq, event_type, payload, channel_id) VALUES (?, 'x', ?, 0)`, i+1, r.payload); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	var before int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE `+db.EventNamesUserPredicate, uid).Scan(&before); err != nil {
		t.Fatalf("count: %v", err)
	}
	if before != 5 {
		t.Errorf("predicate matched %d rows, want 5", before)
	}
	n, err := database.DeleteEventsForUser(ctx, uid)
	if err != nil {
		t.Fatalf("DeleteEventsForUser: %v", err)
	}
	if n != 5 {
		t.Errorf("deleted %d rows, want 5", n)
	}
	var left int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM events`).Scan(&left); err != nil || left != 4 {
		t.Errorf("rows left = %d (%v), want the 4 naming nobody or someone else", left, err)
	}
}

// Migration 040: a job is listed until its replay purge is recorded, even
// once its files are gone; rows from before the column count as purged.
func TestErasureJob_ListedUntilReplayPurged(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	job, err := database.EraseAccount(ctx, sub.id)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.CompleteErasureJob(ctx, job.ID, len(job.Files)); err != nil {
		t.Fatal(err)
	}
	jobs, err := database.ListUnfinishedErasureJobs(ctx)
	if err != nil || len(jobs) != 1 || jobs[0].ReplayPurged || jobs[0].State != db.ErasureStateDone {
		t.Fatalf("a done but unpurged job is not listed: %+v, %v", jobs, err)
	}
	if err := database.MarkErasureJobReplayPurged(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	if jobs, _ := database.ListUnfinishedErasureJobs(ctx); len(jobs) != 0 {
		t.Errorf("a purged, done job is still listed: %+v", jobs)
	}
	got, err := database.GetErasureJob(ctx, job.ID)
	if err != nil || !got.ReplayPurged {
		t.Errorf("GetErasureJob = %+v, %v; want purged", got, err)
	}
	// A pre-040 row: inserted with the column's default.
	if _, err := database.ExecContext(ctx, `INSERT INTO erasure_jobs (user_id, state, files) VALUES (12345, 'db_done', '[]')`); err != nil {
		t.Fatal(err)
	}
	jobs, _ = database.ListUnfinishedErasureJobs(ctx)
	if len(jobs) != 1 || !jobs[0].ReplayPurged {
		t.Errorf("a legacy row = %+v, want listed for its files with the purge counted as done", jobs)
	}
	var idx int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_reply_to'`).Scan(&idx); err != nil || idx != 1 {
		t.Errorf("idx_messages_reply_to present = %d (%v), want 1", idx, err)
	}
}
