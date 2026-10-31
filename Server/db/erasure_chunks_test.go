package db_test

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// openErasureFile opens a migrated, file-backed (WAL) database: the chunked
// erasure is about connection hand-over and reopening, which :memory: cannot
// show.
func openErasureFile(tb testing.TB, path string) *db.DB {
	tb.Helper()
	if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
		db.WriteMigratedFileForTest(tb, path)
	}
	database, err := db.Open(path)
	if err != nil {
		tb.Fatalf("db.Open: %v", err)
	}
	tb.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		tb.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// seedBulkErasure adds n messages written by subject to channel, plus the
// rows that hang off them and off the subject elsewhere: mentions of other,
// an attachment (uploaded by other, so only the message drain finds it) on
// every tenth, reactions by the subject on n/3 messages other wrote, replay
// events naming the subject, and a session. Set-based SQL, so 100k rows cost
// a second or so.
func seedBulkErasure(tb testing.TB, database *db.DB, subject, other, channel int64, n int) {
	tb.Helper()
	ctx := context.Background()
	exec := func(query string, args ...any) {
		tb.Helper()
		if _, err := database.ExecContext(ctx, query, args...); err != nil {
			tb.Fatalf("%s: %v", query, err)
		}
	}
	const series = `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?) `
	exec(series+`INSERT INTO messages (channel_id, user_id, content) SELECT ?, ?, 'bulk message ' || i FROM s`, n, channel, subject)
	exec(series+`INSERT INTO messages (channel_id, user_id, content) SELECT ?, ?, 'reply ' || i FROM s`, n/3, channel, other)
	exec(`INSERT OR IGNORE INTO message_mentions (message_id, mentioned_user_id) SELECT id, ? FROM messages WHERE user_id = ? AND id % 7 = 0`, other, subject)
	exec(`INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploader_id)
	      SELECT 'bulk-att-' || id, id, 'f.png', 'bulk-stored-' || id, 'image/png', 1, ? FROM messages WHERE user_id = ? AND id % 10 = 0`, other, subject)
	exec(`INSERT INTO reactions (message_id, user_id, emoji) SELECT id, ?, 'bulk' FROM messages WHERE user_id = ?`, subject, other)
	exec(series+`INSERT INTO events (event_type, payload, channel_id, created_at)
	      SELECT 'typing', printf('{"seq":%d,"type":"typing","payload":{"user_id":%d}}', i, ?), ?, datetime('now', '-1 hour') FROM s`, n/3, subject, channel)
	exec(series+`INSERT INTO events (event_type, payload, channel_id, created_at)
	      SELECT 'typing', printf('{"seq":%d,"type":"typing","payload":{"user_id":%d}}', i, ?), ?, datetime('now', '-1 hour') FROM s`, n/3, other, channel)
}

func jobRows(t *testing.T, database *db.DB, userID int64) (n int, state string) {
	t.Helper()
	rows, err := database.QueryContext(context.Background(), `SELECT state FROM erasure_jobs WHERE user_id = ?`, userID)
	if err != nil {
		t.Fatalf("erasure_jobs: %v", err)
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		n++
		if err := rows.Scan(&state); err != nil {
			t.Fatalf("scan: %v", err)
		}
	}
	return n, state
}

func countRows(t *testing.T, database *db.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

func assertInventoryZero(t *testing.T, database *db.DB, sub eraseSubject) {
	t.Helper()
	after, err := database.TakeInventory(context.Background(), sub.id, sub.username)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	for _, c := range db.SubjectInventory {
		if after[c.Key] != 0 && !db.InventoryKeptByErasure[c.Key] {
			t.Errorf("%s: %d rows left after the erasure", c.Key, after[c.Key])
		}
	}
}

// A kill after the lock and part of the drain leaves a locked, partly erased
// account and a queued job holding the committed chunks' file names. The next
// start (the pending marker's replay) finishes it with exactly one job row
// and no lost file name (edge case 1).
func TestEraseAccount_CrashMidDrainResumesOnReopen(t *testing.T) {
	defer db.SetErasureChunkSizesForTest(500, 700)()
	ctx := context.Background()
	const n = 3000

	// The control: the same seed, erased without interruption.
	controlDB := openErasureFile(t, filepath.Join(t.TempDir(), "control.sqlite"))
	cs := seedEraseSubject(t, controlDB)
	seedBulkErasure(t, controlDB, cs.id, cs.other, cs.channel, n)
	control, err := controlDB.EraseAccount(ctx, cs.id, "")
	if err != nil {
		t.Fatalf("control EraseAccount: %v", err)
	}
	if len(control.Files) < n/10 {
		t.Fatalf("control job lists %d files, want at least %d", len(control.Files), n/10)
	}

	path := filepath.Join(t.TempDir(), "main.sqlite")
	database := openErasureFile(t, path)
	sub := seedEraseSubject(t, database)
	seedBulkErasure(t, database, sub.id, sub.other, sub.channel, n)

	// Chunks 1-4 are the small tables and the uploaded attachments; the
	// messages follow in 500s, so chunk 7 is the third of them.
	db.SetErasureChunkHookForTest(database, func(stage string, chunk int) error {
		if stage == "chunk" && chunk == 7 {
			return errors.New("killed mid-drain")
		}
		return nil
	})
	if _, err := database.EraseAccount(ctx, sub.id, "tok"); err == nil {
		t.Fatal("EraseAccount succeeded through the injected kill")
	}
	if got := countRows(t, database, `SELECT COUNT(*) FROM users WHERE id = ?`, sub.id); got != 1 {
		t.Fatalf("users rows after the kill = %d, want the locked account still present", got)
	}
	if got := countRows(t, database, `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, sub.id); got != 0 {
		t.Errorf("sessions after the lock = %d, want 0", got)
	}
	left := countRows(t, database, `SELECT COUNT(*) FROM messages WHERE user_id = ?`, sub.id)
	if left <= 0 || left >= n {
		t.Errorf("messages left after the kill = %d, want a partly drained account (0 < n < %d)", left, n)
	}
	if rows, state := jobRows(t, database, sub.id); rows != 1 || state != db.ErasureStateQueued {
		t.Fatalf("erasure_jobs after the kill = %d rows in state %q, want one queued", rows, state)
	}
	var journaled string
	if err := database.QueryRowContext(ctx, `SELECT files FROM erasure_jobs WHERE user_id = ?`, sub.id).Scan(&journaled); err != nil || journaled == "[]" {
		t.Fatalf("queued job files = %q (%v), want the committed chunks' names", journaled, err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened := openErasureFile(t, path)
	job, err := reopened.ReplayEraseAccount(ctx, sub.id, "tok")
	if err != nil {
		t.Fatalf("ReplayEraseAccount after reopen: %v", err)
	}
	assertInventoryZero(t, reopened, sub)
	if rows, state := jobRows(t, reopened, sub.id); rows != 1 || state != db.ErasureStateDBDone {
		t.Errorf("erasure_jobs after the replay = %d rows in state %q, want one db_done", rows, state)
	}
	if !slices.Equal(job.Files, control.Files) {
		t.Errorf("job files = %d names, control = %d; want the same set", len(job.Files), len(control.Files))
	}
}

// Two administrators erased at once, the last two admin-class accounts: the
// second lock sees the first's queued job and is refused (edge case 2).
func TestEraseAccount_GuardExcludesAccountsUnderErasure(t *testing.T) {
	database := openErasureFile(t, filepath.Join(t.TempDir(), "guard.sqlite"))
	ctx := context.Background()
	first := seedUser(t, database, "admin-first")
	second := seedUser(t, database, "admin-second")
	setRole(t, database, first, permissions.OwnerRoleID)
	setRole(t, database, second, permissions.AdminRoleID)

	var secondErr error
	var counted int
	var ran atomic.Bool
	db.SetErasureChunkHookForTest(database, func(stage string, _ int) error {
		if stage != "lock" || !ran.CompareAndSwap(false, true) {
			return nil
		}
		// The first erasure holds its lock and has not drained: the pause.
		_, secondErr = database.EraseAccount(ctx, second, "")
		counted, _ = database.CountAdminClassAccounts(ctx)
		return nil
	})
	if _, err := database.EraseAccount(ctx, first, ""); err != nil {
		t.Fatalf("first EraseAccount: %v", err)
	}
	if !errors.Is(secondErr, db.ErrLastAdmin) {
		t.Errorf("second EraseAccount while the first is queued = %v, want ErrLastAdmin", secondErr)
	}
	if counted != 1 {
		t.Errorf("CountAdminClassAccounts during the first erasure = %d, want 1 (the queued account no longer counts)", counted)
	}
	if got := countRows(t, database, `SELECT COUNT(*) FROM users WHERE id = ?`, second); got != 1 {
		t.Errorf("the refused account was erased anyway (%d rows)", got)
	}
}

// The writer is handed back after every chunk: an unrelated insert issued
// while a 1,000-message erasure is under way returns before the erasure does.
// Chunks are a tenth of production size, so the drain still takes about twenty
// of them. The ordering is what is asserted, never a duration.
func TestEraseAccount_WriterInterleavesBetweenChunks(t *testing.T) {
	defer db.SetErasureChunkSizesForTest(50, 500)()
	database := openErasureFile(t, filepath.Join(t.TempDir(), "interleave.sqlite"))
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	seedBulkErasure(t, database, sub.id, sub.other, sub.channel, 1000)
	bystander := seedUser(t, database, "bystander")

	inserted := make(chan error, 1)
	var started atomic.Bool
	db.SetErasureChunkHookForTest(database, func(stage string, chunk int) error {
		if stage != "chunk" || chunk < 6 || !started.CompareAndSwap(false, true) {
			return nil
		}
		go func() {
			_, err := database.CreateMessage(ctx, sub.channel, bystander, "while the erasure runs", nil)
			inserted <- err
		}()
		select {
		case err := <-inserted:
			if err != nil {
				t.Errorf("concurrent CreateMessage: %v", err)
			}
		case <-time.After(20 * time.Second):
			t.Error("a concurrent insert did not return while the erasure was between chunks: the writer is not released per chunk")
		}
		return nil
	})
	if _, err := database.EraseAccount(ctx, sub.id, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	if !started.Load() {
		t.Fatal("the drain finished before the concurrent insert was attempted")
	}
	if got := countRows(t, database, `SELECT COUNT(*) FROM messages WHERE user_id = ?`, bystander); got != 1 {
		t.Errorf("the bystander's message is gone (%d rows)", got)
	}
}

// A fault after the first committed chunk leaves the account locked with its
// queued job, restores secure_delete, and a retry completes the erasure with
// the one job row (the all-or-nothing test above stays for a fault at the
// lock).
func TestEraseAccount_FaultAfterFirstChunkLeavesQueuedJob(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	db.SetErasureChunkHookForTest(database, func(stage string, chunk int) error {
		if stage == "chunk" && chunk == 1 {
			return errors.New("database or disk is full")
		}
		return nil
	})
	if _, err := database.EraseAccount(ctx, sub.id, ""); err == nil {
		t.Fatal("EraseAccount succeeded through the fault")
	}
	if got := countRows(t, database, `SELECT COUNT(*) FROM users WHERE id = ?`, sub.id); got != 1 {
		t.Errorf("users rows = %d, want the account kept", got)
	}
	if got := countRows(t, database, `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, sub.id); got != 0 {
		t.Errorf("sessions = %d, want revoked at the lock", got)
	}
	if rows, state := jobRows(t, database, sub.id); rows != 1 || state != db.ErasureStateQueued {
		t.Errorf("erasure_jobs = %d rows in state %q, want one queued", rows, state)
	}
	if got := countRows(t, database, `PRAGMA secure_delete`); got != 0 {
		t.Errorf("secure_delete after the fault = %d, want restored to 0", got)
	}

	db.SetErasureChunkHookForTest(database, nil)
	if _, err := database.EraseAccount(ctx, sub.id, ""); err != nil {
		t.Fatalf("retry after the fault cleared: %v", err)
	}
	assertInventoryZero(t, database, sub)
	if rows, state := jobRows(t, database, sub.id); rows != 1 || state != db.ErasureStateDBDone {
		t.Errorf("erasure_jobs after the retry = %d rows in state %q, want one db_done", rows, state)
	}
}

// A drain stopped by its deadline reports it and loses nothing; the next call
// finishes. A queued job is not a finished one.
func TestEraseAccountDrain_DeadlineStopsBetweenChunks(t *testing.T) {
	defer db.SetErasureChunkSizesForTest(2, 10)()
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	if _, err := database.EraseAccountLock(ctx, sub.id, true); err != nil {
		t.Fatalf("EraseAccountLock: %v", err)
	}
	done, err := database.EraseAccountDrain(ctx, sub.id, time.Now().Add(-time.Second))
	if err != nil || done {
		t.Fatalf("Drain past its deadline = %v, %v; want not done", done, err)
	}
	if done, err = database.EraseAccountDrain(ctx, sub.id, time.Time{}); err != nil || !done {
		t.Fatalf("Drain without a deadline = %v, %v; want done", done, err)
	}
	if _, err := database.EraseAccountFinish(ctx, sub.id, ""); err != nil {
		t.Fatalf("EraseAccountFinish: %v", err)
	}
	assertInventoryZero(t, database, sub)
	// Finish without a queued job has nothing to close.
	if _, err := database.EraseAccountFinish(ctx, sub.id, ""); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("second EraseAccountFinish = %v, want ErrNotFound", err)
	}
	if _, err := database.EraseAccountLock(ctx, 424242, true); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("EraseAccountLock for a missing user = %v, want ErrNotFound", err)
	}
}

// A replay event naming the subject written after the drain passed it (a send
// that was in flight at the lock) is swept by the finish stage, which looks
// only at rows written since the lock.
func TestEraseAccountFinish_SweepsEventsWrittenSinceTheLock(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	if _, err := database.EraseAccountLock(ctx, sub.id, true); err != nil {
		t.Fatalf("EraseAccountLock: %v", err)
	}
	if done, err := database.EraseAccountDrain(ctx, sub.id, time.Time{}); err != nil || !done {
		t.Fatalf("Drain = %v, %v", done, err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO events (event_type, payload, channel_id) VALUES ('typing', ?, ?)`,
		fmt.Sprintf(`{"seq":900,"type":"typing","payload":{"user_id":%d}}`, sub.id), sub.channel); err != nil {
		t.Fatalf("seed straggler: %v", err)
	}
	if _, err := database.EraseAccountFinish(ctx, sub.id, ""); err != nil {
		t.Fatalf("EraseAccountFinish: %v", err)
	}
	assertInventoryZero(t, database, sub)
}

// A send that reaches the writer after the lock writes nothing: the drain
// may already be past it, and its mention would then be reversed before it
// was ever counted.
func TestEraseAccountLock_RefusesLaterMessages(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	if _, err := database.EraseAccountLock(ctx, sub.id, true); err != nil {
		t.Fatalf("EraseAccountLock: %v", err)
	}
	count := func() int {
		var n int
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE user_id = ? AND content = 'late'`, sub.id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if _, err := database.CreateMessageWithMentions(ctx, sub.channel, sub.id, "late", nil, nil, 0, false, nil); !errors.Is(err, db.ErrAccountErasing) {
		t.Errorf("CreateMessageWithMentions = %v, want ErrAccountErasing", err)
	}
	now := time.Now().UnixMilli()
	if _, err := database.CreateMessageDelivery(ctx, db.MessageDeliveryParams{
		UserID: sub.id, ChannelID: sub.channel, ClientMessageID: "late-1", PayloadHash: []byte("h"),
		ExpiresAtMS: now + 60_000, CreatedAtMS: now, Content: "late",
	}); !errors.Is(err, db.ErrAccountErasing) {
		t.Errorf("CreateMessageDelivery = %v, want ErrAccountErasing", err)
	}
	if n := count(); n != 0 {
		t.Errorf("late messages written = %d, want 0", n)
	}
}
