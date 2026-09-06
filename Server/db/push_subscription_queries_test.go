package db_test

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// Migration 045 and the wrapper methods themselves (B5-4). Validation and the
// service-level Subscribe/Sweep flow are proved in service/push_test.go and
// api/push_handler_test.go; these pin the DB layer directly: what a row
// looks like on disk, the transactional trim's atomicity, and the sweep's
// two clauses.

func seedPushUser(t *testing.T, database *db.DB, id int64) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO users (id, username, password, role_id) VALUES (?, ?, 'x', 4)`,
		id, "push-user-"+strconv.FormatInt(id, 10),
	); err != nil {
		t.Fatalf("seedPushUser(%d): %v", id, err)
	}
}

// ─── UpsertPushSubscription ─────────────────────────────────────────────────

func TestUpsertPushSubscription_InsertsARow(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)

	id, err := database.UpsertPushSubscription(ctx, 1, "https://push.example/a", "p256", "auth1", "laptop", "key1", 10)
	if err != nil || id == 0 {
		t.Fatalf("UpsertPushSubscription: id=%d err=%v", id, err)
	}

	var endpoint, p256dh, auth, deviceName, keyID string
	if err := database.QueryRowContext(ctx,
		`SELECT endpoint, p256dh, auth, device_name, vapid_key_id FROM push_subscriptions WHERE id = ?`, id,
	).Scan(&endpoint, &p256dh, &auth, &deviceName, &keyID); err != nil {
		t.Fatalf("reading the row: %v", err)
	}
	if endpoint != "https://push.example/a" || p256dh != "p256" || auth != "auth1" || deviceName != "laptop" || keyID != "key1" {
		t.Errorf("row = %q %q %q %q %q, want the inserted values", endpoint, p256dh, auth, deviceName, keyID)
	}
}

// TestUpsertPushSubscription_RefreshBumpsLastSeenAtSameRow: re-subscribing
// the same (user, endpoint) is an upsert, not a second row, and its
// credential/device_name/last_seen_at are replaced.
func TestUpsertPushSubscription_RefreshBumpsLastSeenAtSameRow(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)

	first, err := database.UpsertPushSubscription(ctx, 1, "https://push.example/a", "p256-old", "auth-old", "old-name", "key1", 10)
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE push_subscriptions SET last_seen_at = datetime('now', '-1 day') WHERE id = ?`, first); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := database.QueryRowContext(ctx, `SELECT last_seen_at FROM push_subscriptions WHERE id = ?`, first).Scan(&before); err != nil {
		t.Fatal(err)
	}

	second, err := database.UpsertPushSubscription(ctx, 1, "https://push.example/a", "p256-new", "auth-new", "new-name", "key2", 10)
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if second != first {
		t.Fatalf("refresh id = %d, want the same row %d", second, first)
	}

	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = 1`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("rows for user 1 = %d, %v; want exactly 1", n, err)
	}
	var p256dh, auth, deviceName, keyID, after string
	if err := database.QueryRowContext(ctx,
		`SELECT p256dh, auth, device_name, vapid_key_id, last_seen_at FROM push_subscriptions WHERE id = ?`, first,
	).Scan(&p256dh, &auth, &deviceName, &keyID, &after); err != nil {
		t.Fatal(err)
	}
	if p256dh != "p256-new" || auth != "auth-new" || deviceName != "new-name" || keyID != "key2" {
		t.Errorf("refreshed row = %q %q %q %q, want the second call's values", p256dh, auth, deviceName, keyID)
	}
	beforeTime, _ := time.Parse("2006-01-02 15:04:05", before)
	afterTime, _ := time.Parse("2006-01-02 15:04:05", after)
	if !afterTime.After(beforeTime) {
		t.Errorf("last_seen_at after refresh = %q, before (backdated) = %q; want it strictly later", after, before)
	}
}

// TestUpsertPushSubscription_TrimEvictsPastKeep: the transactional trim
// keeps the newest `keep` rows by last_seen_at and evicts the rest, in the
// same call that performs the upsert.
func TestUpsertPushSubscription_TrimEvictsPastKeep(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)

	// Three pre-existing rows, oldest to newest.
	for i, minutesAgo := range []int{30, 20, 10} {
		endpoint := "https://push.example/existing-" + string(rune('a'+i))
		if _, err := database.ExecContext(ctx,
			`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, vapid_key_id, last_seen_at)
			 VALUES (1, ?, 'p', 'a', 'k', datetime('now', ?))`,
			endpoint, "-"+strconv.Itoa(minutesAgo)+" minutes",
		); err != nil {
			t.Fatal(err)
		}
	}

	// Upserting a fourth, newest row with keep=2 must evict the two oldest
	// (30 and 20 minutes ago), leaving the 10-minutes-ago row and the new one.
	if _, err := database.UpsertPushSubscription(ctx, 1, "https://push.example/new", "p", "a", "d", "k", 2); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}

	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = 1`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("rows after trim = %d, %v; want 2", n, err)
	}
	var oldestSurvives int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE endpoint = 'https://push.example/existing-a'`).Scan(&oldestSurvives); err != nil {
		t.Fatal(err)
	}
	if oldestSurvives != 0 {
		t.Error("the oldest (30-minutes-ago) row survived the trim")
	}
	var newestSurvives int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE endpoint IN ('https://push.example/existing-c', 'https://push.example/new')`).Scan(&newestSurvives); err != nil {
		t.Fatal(err)
	}
	if newestSurvives != 2 {
		t.Errorf("survivors = %d, want the newest existing row and the new one", newestSurvives)
	}
}

// TestUpsertPushSubscription_NegativeKeepClampsToZero: keep < 0 clamps to 0,
// which evicts every row for the user, including the one just written.
func TestUpsertPushSubscription_NegativeKeepClampsToZero(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)
	if _, err := database.ExecContext(ctx,
		`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, vapid_key_id) VALUES (1, 'https://push.example/old', 'p', 'a', 'k')`,
	); err != nil {
		t.Fatal(err)
	}

	if _, err := database.UpsertPushSubscription(ctx, 1, "https://push.example/new", "p", "a", "d", "k", -1); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}

	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = 1`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("rows after keep=-1 = %d, want 0 (clamped to keep=0, evicting everything)", n)
	}
}

// TestUpsertPushSubscription_CancelledContextFailsAtomically: a context that
// is already done makes BeginTx refuse, so the call reports an error and
// writes nothing — the atomicity property the transaction exists for.
func TestUpsertPushSubscription_CancelledContextFailsAtomically(t *testing.T) {
	database := openMigratedMemory(t)
	seedPushUser(t, database, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := database.UpsertPushSubscription(ctx, 1, "https://push.example/a", "p", "a", "d", "k", 10); err == nil {
		t.Fatal("want an error from an already-cancelled context")
	}

	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = 1`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("rows after the failed call = %d, want 0", n)
	}
}

// TestUpsertPushSubscription_InsertFailureIsReported covers the upsert
// statement's own error-wrap branch (distinct from the trim loop's, proved
// above) via a trigger that blocks the write outright.
func TestUpsertPushSubscription_InsertFailureIsReported(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)
	if _, err := database.ExecContext(ctx, `
		CREATE TRIGGER push_subscriptions_block_insert
		BEFORE INSERT ON push_subscriptions
		WHEN NEW.endpoint = 'insert-blocked'
		BEGIN SELECT RAISE(ABORT, 'blocked insert'); END`,
	); err != nil {
		t.Fatalf("creating the blocking trigger: %v", err)
	}

	if _, err := database.UpsertPushSubscription(ctx, 1, "insert-blocked", "p", "a", "d", "k", 10); err == nil {
		t.Fatal("want an error when the insert itself is blocked")
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = 1`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows after the blocked insert = %d, %v; want 0", n, err)
	}
}

// TestUpsertPushSubscription_CommitFailureIsReported covers the commit
// error-wrap branch specifically: PRAGMA defer_foreign_keys defers the
// user_id foreign key check to COMMIT, so the insert itself succeeds and
// only the commit fails (user 999 does not exist) — proving the insert is
// rolled back with it.
func TestUpsertPushSubscription_CommitFailureIsReported(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `PRAGMA defer_foreign_keys = ON`); err != nil {
		t.Fatal(err)
	}

	if _, err := database.UpsertPushSubscription(ctx, 999, "https://push.example/a", "p", "a", "d", "k", 10); err == nil {
		t.Fatal("want an error when the deferred foreign key fails at commit")
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = 999`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows after the failed commit = %d, %v; want 0 (rolled back)", n, err)
	}
}

// TestUpsertPushSubscription_RollbackOnFailingTrimDelete proves the whole
// call is one transaction, not three statements: a trigger makes the trim's
// delete of one specific row fail after the upsert has already written its
// new row and the loop has already deleted another eviction victim, and all
// of that is undone together — not just the failing statement.
func TestUpsertPushSubscription_RollbackOnFailingTrimDelete(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)

	if _, err := database.ExecContext(ctx, `
		CREATE TRIGGER push_subscriptions_block_delete
		BEFORE DELETE ON push_subscriptions
		WHEN OLD.endpoint = 'blocked'
		BEGIN SELECT RAISE(ABORT, 'blocked delete'); END`,
	); err != nil {
		t.Fatalf("creating the blocking trigger: %v", err)
	}
	// The oldest row (evicted first out of the loop's newest-first order is
	// the new one; this one, being oldest, is evicted last) is the one the
	// trigger blocks.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, vapid_key_id, last_seen_at)
		 VALUES (1, 'blocked', 'p', 'a', 'k', datetime('now', '-1 hour'))`,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, vapid_key_id, last_seen_at)
		 VALUES (1, 'https://push.example/middle', 'p', 'a', 'k', datetime('now', '-30 minutes'))`,
	); err != nil {
		t.Fatal(err)
	}

	// keep=0: the trim tries to evict every row, including the brand new one
	// this call writes and the 'middle' row (both delete cleanly) before it
	// reaches 'blocked' (oldest, deleted last) and fails.
	_, err := database.UpsertPushSubscription(ctx, 1, "https://push.example/new", "p", "a", "d", "k", 0)
	if err == nil {
		t.Fatal("want an error when the trim's delete is blocked")
	}

	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = 1`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("rows after the failed trim = %d, want 2 (the pre-existing 'blocked' and 'middle' rows, untouched)", n)
	}
	var newRowExists int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE endpoint = 'https://push.example/new'`).Scan(&newRowExists); err != nil {
		t.Fatal(err)
	}
	if newRowExists != 0 {
		t.Error("the new row survived even though the transaction failed — the upsert was not rolled back")
	}
	var middleRowExists int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE endpoint = 'https://push.example/middle'`).Scan(&middleRowExists); err != nil {
		t.Fatal(err)
	}
	if middleRowExists != 1 {
		t.Error("the 'middle' row's successful delete was not rolled back with the rest of the transaction")
	}
}

// ─── ListPushSubscriptions ───────────────────────────────────────────────────

func TestListPushSubscriptions_KeyScopedNoCredentialsOrdering(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)

	exec := func(endpoint, keyID string, minutesAgo int) {
		t.Helper()
		if _, err := database.ExecContext(ctx,
			`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_name, vapid_key_id, last_seen_at)
			 VALUES (1, ?, 'secret-p256dh', 'secret-auth', 'dev', ?, datetime('now', ?))`,
			endpoint, keyID, "-"+strconv.Itoa(minutesAgo)+" minutes",
		); err != nil {
			t.Fatal(err)
		}
	}
	exec("https://push.example/old-key", "key-old", 5) // wrong key
	exec("https://push.example/newer", "key-new", 5)   // right key, older
	exec("https://push.example/newest", "key-new", 1)  // right key, newest

	rows, err := database.ListPushSubscriptions(ctx, 1, "key-new")
	if err != nil {
		t.Fatalf("ListPushSubscriptions: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2 (the wrong-key row excluded)", len(rows))
	}
	if rows[0].Endpoint != "https://push.example/newest" || rows[1].Endpoint != "https://push.example/newer" {
		t.Errorf("order = %q, %q; want newest first", rows[0].Endpoint, rows[1].Endpoint)
	}
	for _, r := range rows {
		if r.UserID != 1 || r.DeviceName != "dev" || r.CreatedAt.IsZero() || r.LastSeenAt.IsZero() {
			t.Errorf("row %+v missing expected fields", r)
		}
	}
	// PushSubscription has no P256dh/Auth fields at all: the type itself is
	// the credential exclusion, so there is nothing further to assert here
	// beyond the struct compiling — this comment documents that on purpose.
}

func TestListPushSubscriptions_EmptyForUnknownUser(t *testing.T) {
	database := openMigratedMemory(t)
	rows, err := database.ListPushSubscriptions(context.Background(), 999, "any-key")
	if err != nil || len(rows) != 0 {
		t.Fatalf("ListPushSubscriptions(unknown user) = %v, %v; want none, no error", rows, err)
	}
}

// ─── DeletePushSubscription ──────────────────────────────────────────────────

func TestDeletePushSubscription_ScopedAndReportsRows(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)
	seedPushUser(t, database, 2)
	id, err := database.UpsertPushSubscription(ctx, 1, "https://push.example/a", "p", "a", "d", "k", 10)
	if err != nil {
		t.Fatal(err)
	}

	if ok, err := database.DeletePushSubscription(ctx, 2, id); err != nil || ok {
		t.Fatalf("user 2 deleting user 1's row: ok=%v err=%v, want ok=false", ok, err)
	}
	if ok, err := database.DeletePushSubscription(ctx, 1, id); err != nil || !ok {
		t.Fatalf("owner deleting their own row: ok=%v err=%v, want ok=true", ok, err)
	}
	if ok, err := database.DeletePushSubscription(ctx, 1, id); err != nil || ok {
		t.Fatalf("deleting an already-gone row: ok=%v err=%v, want ok=false", ok, err)
	}
}

// ─── SweepPushSubscriptions ──────────────────────────────────────────────────

func TestSweepPushSubscriptions_CutoffFormatting(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)
	exec := func(endpoint string, when time.Time, keyID string) {
		t.Helper()
		if _, err := database.ExecContext(ctx,
			`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, vapid_key_id, last_seen_at)
			 VALUES (1, ?, 'p', 'a', ?, ?)`,
			endpoint, keyID, when.UTC().Format("2006-01-02 15:04:05"),
		); err != nil {
			t.Fatal(err)
		}
	}
	cutoff := time.Now().Add(-24 * time.Hour)
	exec("https://push.example/stale", cutoff.Add(-time.Minute), "key1")
	exec("https://push.example/fresh", cutoff.Add(time.Minute), "key1")

	n, err := database.SweepPushSubscriptions(ctx, cutoff, "")
	if err != nil {
		t.Fatalf("SweepPushSubscriptions: %v", err)
	}
	if n != 1 {
		t.Fatalf("swept %d rows, want 1", n)
	}
	var survivor string
	if err := database.QueryRowContext(ctx, `SELECT endpoint FROM push_subscriptions WHERE user_id = 1`).Scan(&survivor); err != nil {
		t.Fatal(err)
	}
	if survivor != "https://push.example/fresh" {
		t.Errorf("survivor = %q, want the fresh row", survivor)
	}
}

// TestSweepPushSubscriptions_EmptyKeyIsTimeOnly: with keyID == "" a
// vapid_key_id mismatch alone must not sweep a fresh row — decision 2's
// rotation clause is skipped when no key is installed.
func TestSweepPushSubscriptions_EmptyKeyIsTimeOnly(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)
	if _, err := database.ExecContext(ctx,
		`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, vapid_key_id) VALUES (1, 'https://push.example/a', 'p', 'a', 'some-other-key')`,
	); err != nil {
		t.Fatal(err)
	}

	n, err := database.SweepPushSubscriptions(ctx, time.Now().Add(-90*24*time.Hour), "")
	if err != nil {
		t.Fatalf("SweepPushSubscriptions: %v", err)
	}
	if n != 0 {
		t.Fatalf("swept %d rows, want 0 (fresh, and no key installed to compare against)", n)
	}
}

// ─── CountPushSubscriptions ──────────────────────────────────────────────────

func TestCountPushSubscriptions(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	if n, err := database.CountPushSubscriptions(ctx); err != nil || n != 0 {
		t.Fatalf("empty count = %d, %v; want 0", n, err)
	}
	seedPushUser(t, database, 1)
	seedPushUser(t, database, 2)
	if _, err := database.UpsertPushSubscription(ctx, 1, "https://push.example/a", "p", "a", "d", "k", 10); err != nil {
		t.Fatal(err)
	}
	if _, err := database.UpsertPushSubscription(ctx, 2, "https://push.example/b", "p", "a", "d", "k", 10); err != nil {
		t.Fatal(err)
	}
	if n, err := database.CountPushSubscriptions(ctx); err != nil || n != 2 {
		t.Fatalf("count = %d, %v; want 2 (every user)", n, err)
	}
}

// TestPushSubscriptionWrappers_ReportClosedDatabaseErrors covers each
// wrapper's error-wrapping branch: once the underlying handle is closed,
// every one of the remaining query methods must return the driver's error
// rather than panic or silently succeed.
func TestPushSubscriptionWrappers_ReportClosedDatabaseErrors(t *testing.T) {
	database := openMigratedMemory(t)
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	if _, err := database.ListPushSubscriptions(ctx, 1, "k"); err == nil {
		t.Error("ListPushSubscriptions on a closed database: want an error")
	}
	if _, err := database.DeletePushSubscription(ctx, 1, 1); err == nil {
		t.Error("DeletePushSubscription on a closed database: want an error")
	}
	if _, err := database.SweepPushSubscriptions(ctx, time.Now(), "k"); err == nil {
		t.Error("SweepPushSubscriptions on a closed database: want an error")
	}
	if _, err := database.CountPushSubscriptions(ctx); err == nil {
		t.Error("CountPushSubscriptions on a closed database: want an error")
	}
	if _, err := database.ListPushSubscriptionsForDispatch(ctx, []int64{1}, "k"); err == nil {
		t.Error("ListPushSubscriptionsForDispatch on a closed database: want an error")
	}
	if _, err := database.DeletePushSubscriptionByID(ctx, 1); err == nil {
		t.Error("DeletePushSubscriptionByID on a closed database: want an error")
	}
}

// ─── ListPushSubscriptionsForDispatch (B5-11) ───────────────────────────────

// TestListPushSubscriptionsForDispatch_ScopesToTheGivenUsersAndKey proves the
// three axes dispatch relies on: only the caller-named users come back
// (someone else's subscription is invisible even though it exists), the
// credential fields are present (unlike ListPushSubscriptions), and a row
// under a different VAPID key is excluded.
func TestListPushSubscriptionsForDispatch_ScopesToTheGivenUsersAndKey(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)
	seedPushUser(t, database, 2)
	seedPushUser(t, database, 3)

	idA, err := database.UpsertPushSubscription(ctx, 1, "https://push.example/a", "p256-a", "auth-a", "d1", "key1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.UpsertPushSubscription(ctx, 2, "https://push.example/b", "p256-b", "auth-b", "d2", "key1", 10); err != nil {
		t.Fatal(err)
	}
	// user 3 is under the OLD key -- must not come back even though 3 is in
	// the requested set.
	if _, err := database.UpsertPushSubscription(ctx, 3, "https://push.example/c", "p256-c", "auth-c", "d3", "old-key", 10); err != nil {
		t.Fatal(err)
	}

	rows, err := database.ListPushSubscriptionsForDispatch(ctx, []int64{1, 3}, "key1")
	if err != nil {
		t.Fatalf("ListPushSubscriptionsForDispatch: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1 (user 2 was not requested, user 3 is under a stale key)", len(rows))
	}
	if rows[0].ID != idA || rows[0].UserID != 1 || rows[0].Endpoint != "https://push.example/a" ||
		rows[0].P256dh != "p256-a" || rows[0].Auth != "auth-a" {
		t.Errorf("row = %+v, want user 1's credential", rows[0])
	}
}

// TestListPushSubscriptionsForDispatch_EmptyUserIDsReturnsNothing proves the
// short-circuit: no query round-trip, no rows, no error.
func TestListPushSubscriptionsForDispatch_EmptyUserIDsReturnsNothing(t *testing.T) {
	database := openMigratedMemory(t)
	rows, err := database.ListPushSubscriptionsForDispatch(context.Background(), nil, "key1")
	if err != nil || len(rows) != 0 {
		t.Fatalf("rows = %v, err = %v; want no rows and no error", rows, err)
	}
}

// ─── DeletePushSubscriptionByID (B5-11) ─────────────────────────────────────

// TestDeletePushSubscriptionByID_UnscopedDeletesRegardlessOfOwner proves the
// deliberate difference from the user-scoped DeletePushSubscription: an id
// alone is enough, because a push service's 404/410 never names the owner.
func TestDeletePushSubscriptionByID_UnscopedDeletesRegardlessOfOwner(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	seedPushUser(t, database, 1)
	id, err := database.UpsertPushSubscription(ctx, 1, "https://push.example/a", "p", "a", "d", "k", 10)
	if err != nil {
		t.Fatal(err)
	}

	ok, err := database.DeletePushSubscriptionByID(ctx, id)
	if err != nil || !ok {
		t.Fatalf("DeletePushSubscriptionByID(%d) = %v, %v; want true, nil", id, ok, err)
	}
	rows, err := database.ListPushSubscriptionsForDispatch(ctx, []int64{1}, "k")
	if err != nil || len(rows) != 0 {
		t.Fatalf("row still present after DeletePushSubscriptionByID: rows=%v err=%v", rows, err)
	}
}

// TestDeletePushSubscriptionByID_UnknownIDIsAFalseNotAnError mirrors
// DeletePushSubscription's contract for an id that does not exist.
func TestDeletePushSubscriptionByID_UnknownIDIsAFalseNotAnError(t *testing.T) {
	database := openMigratedMemory(t)
	ok, err := database.DeletePushSubscriptionByID(context.Background(), 999)
	if err != nil || ok {
		t.Fatalf("DeletePushSubscriptionByID(999) = %v, %v; want false, nil", ok, err)
	}
}
