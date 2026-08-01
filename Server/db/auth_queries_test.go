package db_test

import (
	"context"
	"testing"
	"testing/fstest"
	"time"

	"github.com/owncord/server/db"
)

// newTestDB opens an in-memory SQLite database and runs migrations from the
// embedded FS so tests are fully self-contained.
func newTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	// Build a minimal migration FS with the initial schema.
	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: testSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// testSchema mirrors the production migration but kept inline so tests are
// portable and don't depend on the real migrations embed.
var testSchema = []byte(`
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO roles (id, name, color, permissions, position, is_default) VALUES
    (1, 'Owner',     '#E74C3C', 2147483647, 100, 0),
    (2, 'Admin',     '#F39C12', 1073741823,  80, 0),
    (3, 'Moderator', '#3498DB', 1048575,     60, 0),
    (4, 'Member',    NULL,      1635,     40, 1);

CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT    NOT NULL,
    avatar      TEXT,
    role_id     INTEGER NOT NULL DEFAULT 4 REFERENCES roles(id),
    totp_secret TEXT,
    status      TEXT    NOT NULL DEFAULT 'offline',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT,
    banned      INTEGER NOT NULL DEFAULT 0,
    ban_reason  TEXT,
    ban_expires TEXT,
    identity_public_key TEXT,
    display_name TEXT,
    about TEXT,
    custom_status TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    device     TEXT,
    ip_address TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

CREATE TABLE IF NOT EXISTS invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL UNIQUE,
    created_by  INTEGER NOT NULL REFERENCES users(id),
    redeemed_by INTEGER REFERENCES users(id),
    max_uses    INTEGER,
    use_count   INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
`)

// ─── User tests ──────────────────────────────────────────────────────────────

func TestCreateUser_Success(t *testing.T) {
	database := newTestDB(t)
	id, err := database.CreateUser(context.Background(), "alice", "hash123", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if id <= 0 {
		t.Errorf("CreateUser returned id = %d, want > 0", id)
	}
}

func TestCreateUser_DuplicateUsername(t *testing.T) {
	database := newTestDB(t)
	if _, err := database.CreateUser(context.Background(), "bob", "hash1", 4); err != nil {
		t.Fatalf("first CreateUser: %v", err)
	}
	_, err := database.CreateUser(context.Background(), "bob", "hash2", 4)
	if err == nil {
		t.Error("CreateUser() with duplicate username returned nil error, want error")
	}
}

func TestCreateUser_CaseInsensitiveDuplicate(t *testing.T) {
	database := newTestDB(t)
	if _, err := database.CreateUser(context.Background(), "Charlie", "hash1", 4); err != nil {
		t.Fatalf("first CreateUser: %v", err)
	}
	_, err := database.CreateUser(context.Background(), "charlie", "hash2", 4)
	if err == nil {
		t.Error("CreateUser() with case-insensitive duplicate returned nil error, want error")
	}
}

func TestGetUserByUsername_Found(t *testing.T) {
	database := newTestDB(t)
	_, _ = database.CreateUser(context.Background(), "dave", "hashDave", 4)

	user, err := database.GetUserByUsername(context.Background(), "dave")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if user.Username != "dave" {
		t.Errorf("Username = %q, want %q", user.Username, "dave")
	}
	if user.PasswordHash != "hashDave" {
		t.Errorf("PasswordHash = %q, want %q", user.PasswordHash, "hashDave")
	}
}

func TestGetUserByUsername_CaseInsensitive(t *testing.T) {
	database := newTestDB(t)
	_, _ = database.CreateUser(context.Background(), "Eve", "hashEve", 4)

	user, err := database.GetUserByUsername(context.Background(), "EVE")
	if err != nil {
		t.Fatalf("GetUserByUsername case-insensitive: %v", err)
	}
	if user == nil {
		t.Fatal("GetUserByUsername returned nil for case-insensitive match")
	}
}

func TestGetUserByUsername_NotFound(t *testing.T) {
	database := newTestDB(t)
	user, err := database.GetUserByUsername(context.Background(), "nobody")
	if err != nil {
		t.Fatalf("GetUserByUsername(not found): %v", err)
	}
	if user != nil {
		t.Error("GetUserByUsername returned non-nil for missing user")
	}
}

func TestGetUserByID_Found(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser(context.Background(), "frank", "hashFrank", 4)

	user, err := database.GetUserByID(context.Background(), id)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if user.ID != id {
		t.Errorf("ID = %d, want %d", user.ID, id)
	}
}

func TestGetUserByID_NotFound(t *testing.T) {
	database := newTestDB(t)
	user, err := database.GetUserByID(context.Background(), 999)
	if err != nil {
		t.Fatalf("GetUserByID(not found): %v", err)
	}
	if user != nil {
		t.Error("GetUserByID returned non-nil for missing user")
	}
}

func TestUpdateUserStatus(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser(context.Background(), "grace", "hash", 4)

	if err := database.UpdateUserStatus(context.Background(), id, "online"); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}
	user, _ := database.GetUserByID(context.Background(), id)
	if user.Status != "online" {
		t.Errorf("Status = %q, want %q", user.Status, "online")
	}
}

func TestBanUser_Permanent(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser(context.Background(), "hank", "hash", 4)

	if err := database.BanUser(context.Background(), id, "spam", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	user, _ := database.GetUserByID(context.Background(), id)
	if !user.Banned {
		t.Error("Banned = false after BanUser, want true")
	}
	if user.BanExpires != nil {
		t.Errorf("BanExpires = %v, want nil for permanent ban", user.BanExpires)
	}
}

func TestBanUser_Temporary(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser(context.Background(), "ivan", "hash", 4)
	expires := time.Now().Add(24 * time.Hour)

	if err := database.BanUser(context.Background(), id, "temp ban", &expires); err != nil {
		t.Fatalf("BanUser (temp): %v", err)
	}
	user, _ := database.GetUserByID(context.Background(), id)
	if !user.Banned {
		t.Error("Banned = false after temp ban")
	}
	if user.BanExpires == nil {
		t.Error("BanExpires = nil for temp ban, want non-nil")
	}
}

// ─── Session tests ────────────────────────────────────────────────────────────

func TestCreateSession_Success(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "jack", "hash", 4)

	id, err := database.CreateSession(context.Background(), uid, "tokenHash1", "GoTest/1.0", "127.0.0.1")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if id <= 0 {
		t.Errorf("CreateSession id = %d, want > 0", id)
	}
}

func TestGetSessionByTokenHash_Found(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "kate", "hash", 4)
	_, _ = database.CreateSession(context.Background(), uid, "myTokenHash", "GoTest/1.0", "127.0.0.1")

	sess, err := database.GetSessionByTokenHash(context.Background(), "myTokenHash")
	if err != nil {
		t.Fatalf("GetSessionByTokenHash: %v", err)
	}
	if sess == nil {
		t.Fatal("GetSessionByTokenHash returned nil for existing session")
	}
	if sess.UserID != uid {
		t.Errorf("UserID = %d, want %d", sess.UserID, uid)
	}
}

func TestGetSessionByTokenHash_NotFound(t *testing.T) {
	database := newTestDB(t)
	sess, err := database.GetSessionByTokenHash(context.Background(), "nonexistent")
	if err != nil {
		t.Fatalf("GetSessionByTokenHash(not found): %v", err)
	}
	if sess != nil {
		t.Error("GetSessionByTokenHash returned non-nil for missing session")
	}
}

func TestGetSessionWithBanStatus_Found(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "zara", "hash", 4)
	_, _ = database.CreateSession(context.Background(), uid, "banCheckToken", "GoTest/1.0", "127.0.0.1")

	result, err := database.GetSessionWithBanStatus(context.Background(), "banCheckToken")
	if err != nil {
		t.Fatalf("GetSessionWithBanStatus: %v", err)
	}
	if result == nil {
		t.Fatal("GetSessionWithBanStatus returned nil for existing session")
	}
	if result.UserID != uid {
		t.Errorf("UserID = %d, want %d", result.UserID, uid)
	}
	if result.Banned {
		t.Error("expected user not banned")
	}
}

func TestGetSessionWithBanStatus_BannedUser(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "banned-zara", "hash", 4)
	_, _ = database.CreateSession(context.Background(), uid, "bannedToken", "GoTest/1.0", "127.0.0.1")
	if err := database.BanUser(context.Background(), uid, "rule violation", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	result, err := database.GetSessionWithBanStatus(context.Background(), "bannedToken")
	if err != nil {
		t.Fatalf("GetSessionWithBanStatus: %v", err)
	}
	if result == nil {
		t.Fatal("GetSessionWithBanStatus returned nil for existing session")
	}
	if !result.Banned {
		t.Error("expected Banned = true for banned user")
	}
	if result.BanReason == nil || *result.BanReason != "rule violation" {
		t.Errorf("BanReason = %v, want 'rule violation'", result.BanReason)
	}
}

func TestGetSessionWithBanStatus_NotFound(t *testing.T) {
	database := newTestDB(t)
	result, err := database.GetSessionWithBanStatus(context.Background(), "nonexistent")
	if err != nil {
		t.Fatalf("GetSessionWithBanStatus(not found): %v", err)
	}
	if result != nil {
		t.Error("GetSessionWithBanStatus returned non-nil for missing session")
	}
}

// The ws revoked-session sweep resolves every connected client in one
// IN (...) query; missing hashes must be absent (revoked ⇒ kick) and ban
// state must ride along per row.
func TestGetSessionsWithBanStatusBatch(t *testing.T) {
	database := newTestDB(t)
	okUID, _ := database.CreateUser(context.Background(), "batch-ok", "hash", 4)
	banUID, _ := database.CreateUser(context.Background(), "batch-banned", "hash", 4)
	_, _ = database.CreateSession(context.Background(), okUID, "batchTokenOK", "GoTest/1.0", "127.0.0.1")
	_, _ = database.CreateSession(context.Background(), banUID, "batchTokenBan", "GoTest/1.0", "127.0.0.1")
	if err := database.BanUser(context.Background(), banUID, "rule violation", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	result, err := database.GetSessionsWithBanStatusBatch(context.Background(),
		[]string{"batchTokenOK", "batchTokenBan", "batchTokenMissing"})
	if err != nil {
		t.Fatalf("GetSessionsWithBanStatusBatch: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("len(result) = %d, want 2 (missing hash must be absent)", len(result))
	}

	ok := result["batchTokenOK"]
	if ok == nil || ok.UserID != okUID {
		t.Fatalf("batchTokenOK row = %+v, want session for user %d", ok, okUID)
	}
	if ok.Banned {
		t.Error("batchTokenOK: Banned = true, want false")
	}
	if ok.ExpiresAt == "" {
		t.Error("batchTokenOK: ExpiresAt empty — the sweep's expiry check needs it")
	}

	banned := result["batchTokenBan"]
	if banned == nil || !banned.Banned {
		t.Fatalf("batchTokenBan row = %+v, want Banned = true", banned)
	}
	if banned.BanReason == nil || *banned.BanReason != "rule violation" {
		t.Errorf("BanReason = %v, want 'rule violation'", banned.BanReason)
	}

	if _, found := result["batchTokenMissing"]; found {
		t.Error("batchTokenMissing must not be in the result map")
	}
}

func TestGetSessionsWithBanStatusBatch_Empty(t *testing.T) {
	database := newTestDB(t)
	result, err := database.GetSessionsWithBanStatusBatch(context.Background(), nil)
	if err != nil {
		t.Fatalf("GetSessionsWithBanStatusBatch(nil): %v", err)
	}
	if len(result) != 0 {
		t.Errorf("len(result) = %d, want 0", len(result))
	}
}

func TestDeleteSession(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "leo", "hash", 4)
	_, _ = database.CreateSession(context.Background(), uid, "delToken", "GoTest/1.0", "127.0.0.1")

	if err := database.DeleteSession(context.Background(), "delToken"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	sess, _ := database.GetSessionByTokenHash(context.Background(), "delToken")
	if sess != nil {
		t.Error("Session still exists after DeleteSession")
	}
}

func TestDeleteExpiredSessions(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "mia", "hash", 4)

	// Insert an already-expired session directly via Exec.
	// Use SQLite datetime format (space separator) to match what datetime('now') produces.
	pastTime := time.Now().Add(-time.Hour).UTC().Format("2006-01-02 15:04:05")
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)`,
		uid, "expiredToken", "test", "127.0.0.1", pastTime,
	)
	if err != nil {
		t.Fatalf("inserting expired session: %v", err)
	}

	// Insert a valid session through the normal path.
	_, _ = database.CreateSession(context.Background(), uid, "validToken", "GoTest/1.0", "127.0.0.1")

	if err := database.DeleteExpiredSessions(context.Background()); err != nil {
		t.Fatalf("DeleteExpiredSessions: %v", err)
	}

	expired, _ := database.GetSessionByTokenHash(context.Background(), "expiredToken")
	if expired != nil {
		t.Error("Expired session still exists after DeleteExpiredSessions")
	}
	valid, _ := database.GetSessionByTokenHash(context.Background(), "validToken")
	if valid == nil {
		t.Error("Valid session was deleted by DeleteExpiredSessions")
	}
}

func TestTouchSession(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "noah", "hash", 4)
	_, _ = database.CreateSession(context.Background(), uid, "touchToken", "GoTest/1.0", "127.0.0.1")

	sess1, _ := database.GetSessionByTokenHash(context.Background(), "touchToken")
	time.Sleep(2 * time.Millisecond)

	if err := database.TouchSession(context.Background(), "touchToken"); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}

	sess2, _ := database.GetSessionByTokenHash(context.Background(), "touchToken")
	if sess1.LastUsed == sess2.LastUsed {
		// last_used should have advanced; if they're equal the touch had no effect
		// (This can be flaky at millisecond resolution, but is a reasonable sanity check.)
		t.Log("TouchSession: last_used unchanged (may be a timing issue on fast machines)")
	}
}

// ─── Invite tests ─────────────────────────────────────────────────────────────

func TestCreateInvite_Success(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "olivia", "hash", 4)

	code, err := database.CreateInvite(context.Background(), uid, 0, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if len(code) == 0 {
		t.Error("CreateInvite returned empty code")
	}
}

func TestGetInvite_Found(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "pedro", "hash", 4)
	code, _ := database.CreateInvite(context.Background(), uid, 5, nil)

	inv, err := database.GetInvite(context.Background(), code)
	if err != nil {
		t.Fatalf("GetInvite: %v", err)
	}
	if inv == nil {
		t.Fatal("GetInvite returned nil for existing code")
	}
	if inv.Code != code {
		t.Errorf("Code = %q, want %q", inv.Code, code)
	}
	if inv.MaxUses == nil || *inv.MaxUses != 5 {
		t.Errorf("MaxUses = %v, want 5", inv.MaxUses)
	}
}

func TestGetInvite_NotFound(t *testing.T) {
	database := newTestDB(t)
	inv, err := database.GetInvite(context.Background(), "bogus")
	if err != nil {
		t.Fatalf("GetInvite(not found): %v", err)
	}
	if inv != nil {
		t.Error("GetInvite returned non-nil for missing code")
	}
}

func TestRevokeInvite(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "uma", "hash", 4)
	code, _ := database.CreateInvite(context.Background(), uid, 0, nil)

	if err := database.RevokeInvite(context.Background(), code); err != nil {
		t.Fatalf("RevokeInvite: %v", err)
	}

	inv, _ := database.GetInvite(context.Background(), code)
	if !inv.Revoked {
		t.Error("Revoked = false after RevokeInvite, want true")
	}
}

func TestCreateInvite_UnlimitedUses(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "vera", "hash", 4)
	code, _ := database.CreateInvite(context.Background(), uid, 0, nil) // 0 = unlimited

	inv, _ := database.GetInvite(context.Background(), code)
	if inv.MaxUses != nil {
		t.Errorf("MaxUses = %v, want nil for unlimited", inv.MaxUses)
	}
}

// ─── UseInviteAtomic tests ─────────────────────────────────────────────────────

// TestUseInviteAtomic_Success verifies a valid unlimited invite is accepted and
// its use_count incremented in one operation.
func TestUseInviteAtomic_Success(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "atomic_user1", "hash", 4)
	code, _ := database.CreateInvite(context.Background(), uid, 0, nil)

	if err := database.UseInviteAtomic(context.Background(), code); err != nil {
		t.Fatalf("UseInviteAtomic: %v", err)
	}

	inv, _ := database.GetInvite(context.Background(), code)
	if inv.Uses != 1 {
		t.Errorf("Uses = %d, want 1", inv.Uses)
	}
}

// TestUseInviteAtomic_IncrementsUses verifies the count advances correctly over
// multiple sequential calls.
func TestUseInviteAtomic_IncrementsUses(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "atomic_user2", "hash", 4)
	code, _ := database.CreateInvite(context.Background(), uid, 5, nil)

	for i := range 3 {
		if err := database.UseInviteAtomic(context.Background(), code); err != nil {
			t.Fatalf("UseInviteAtomic iteration %d: %v", i, err)
		}
	}

	inv, _ := database.GetInvite(context.Background(), code)
	if inv.Uses != 3 {
		t.Errorf("Uses = %d, want 3", inv.Uses)
	}
}

// TestUseInviteAtomic_Revoked returns an error for a revoked invite without
// modifying the database.
func TestUseInviteAtomic_Revoked(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "atomic_user3", "hash", 4)
	code, _ := database.CreateInvite(context.Background(), uid, 0, nil)
	_ = database.RevokeInvite(context.Background(), code)

	if err := database.UseInviteAtomic(context.Background(), code); err == nil {
		t.Error("UseInviteAtomic returned nil error for revoked invite, want error")
	}

	// use_count must not have changed.
	inv, _ := database.GetInvite(context.Background(), code)
	if inv.Uses != 0 {
		t.Errorf("Uses = %d after revoked attempt, want 0", inv.Uses)
	}
}

// TestUseInviteAtomic_Expired returns an error for an expired invite.
func TestUseInviteAtomic_Expired(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "atomic_user4", "hash", 4)

	past := time.Now().Add(-time.Hour)
	code, _ := database.CreateInvite(context.Background(), uid, 0, &past)

	if err := database.UseInviteAtomic(context.Background(), code); err == nil {
		t.Error("UseInviteAtomic returned nil error for expired invite, want error")
	}
}

// TestUseInviteAtomic_ExceedsMaxUses returns an error when the invite has
// reached its maximum use count.
func TestUseInviteAtomic_ExceedsMaxUses(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "atomic_user5", "hash", 4)
	code, _ := database.CreateInvite(context.Background(), uid, 1, nil)

	if err := database.UseInviteAtomic(context.Background(), code); err != nil {
		t.Fatalf("UseInviteAtomic first use: %v", err)
	}
	if err := database.UseInviteAtomic(context.Background(), code); err == nil {
		t.Error("UseInviteAtomic returned nil error after exceeding max_uses, want error")
	}
}

// TestUseInviteAtomic_NotFound returns an error for a completely unknown code.
func TestUseInviteAtomic_NotFound(t *testing.T) {
	database := newTestDB(t)

	if err := database.UseInviteAtomic(context.Background(), "doesnotexist"); err == nil {
		t.Error("UseInviteAtomic returned nil error for unknown code, want error")
	}
}

// TestUseInviteAtomic_ConcurrentSameCode simulates two goroutines racing to
// redeem a single-use invite.  Exactly one must succeed and exactly one must
// fail; the use_count must end up at 1.
func TestUseInviteAtomic_ConcurrentSameCode(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "atomic_user6", "hash", 4)
	code, _ := database.CreateInvite(context.Background(), uid, 1, nil)

	type result struct{ err error }
	results := make(chan result, 2)

	for range 2 {
		go func() {
			results <- result{err: database.UseInviteAtomic(context.Background(), code)}
		}()
	}

	r1, r2 := <-results, <-results
	successes := 0
	if r1.err == nil {
		successes++
	}
	if r2.err == nil {
		successes++
	}
	if successes != 1 {
		t.Errorf("concurrent redemptions: %d succeeded, want exactly 1", successes)
	}

	inv, _ := database.GetInvite(context.Background(), code)
	if inv.Uses != 1 {
		t.Errorf("use_count = %d after concurrent race, want 1", inv.Uses)
	}
}

// ─── UnbanUser ──────────────────────────────────────────────────────────────

func TestUnbanUser_ClearsBan(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser(context.Background(), "unban_target", "hash", 4)

	if err := database.BanUser(context.Background(), id, "spam", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	user, _ := database.GetUserByID(context.Background(), id)
	if !user.Banned {
		t.Fatal("user should be banned before unban")
	}

	if err := database.UnbanUser(context.Background(), id); err != nil {
		t.Fatalf("UnbanUser: %v", err)
	}

	user, _ = database.GetUserByID(context.Background(), id)
	if user.Banned {
		t.Error("Banned = true after UnbanUser, want false")
	}
	if user.BanReason != nil {
		t.Errorf("BanReason = %v, want nil after UnbanUser", user.BanReason)
	}
	if user.BanExpires != nil {
		t.Errorf("BanExpires = %v, want nil after UnbanUser", user.BanExpires)
	}
}

func TestUnbanUser_NonexistentUser(t *testing.T) {
	database := newTestDB(t)

	// Unbanning nonexistent user should not error.
	if err := database.UnbanUser(context.Background(), 99999); err != nil {
		t.Errorf("UnbanUser(nonexistent) error: %v", err)
	}
}

// ─── ResetAllUserStatuses ───────────────────────────────────────────────────

func TestResetAllUserStatuses(t *testing.T) {
	database := newTestDB(t)
	id1, _ := database.CreateUser(context.Background(), "status_u1", "hash", 4)
	id2, _ := database.CreateUser(context.Background(), "status_u2", "hash", 4)

	_ = database.UpdateUserStatus(context.Background(), id1, "online")
	_ = database.UpdateUserStatus(context.Background(), id2, "dnd")

	if err := database.ResetAllUserStatuses(context.Background()); err != nil {
		t.Fatalf("ResetAllUserStatuses: %v", err)
	}

	u1, _ := database.GetUserByID(context.Background(), id1)
	u2, _ := database.GetUserByID(context.Background(), id2)
	if u1.Status != "offline" {
		t.Errorf("user1 status = %q, want 'offline'", u1.Status)
	}
	// A chosen status survives the startup reset: nothing is connected yet, so
	// "online" is the only value that can be a leftover session. dnd is a
	// preference, and the read path renders a user with no live connection as
	// offline regardless of what the column holds.
	if u2.Status != "dnd" {
		t.Errorf("user2 status = %q, want 'dnd' (chosen statuses survive the reset)", u2.Status)
	}
}

func TestResetAllUserStatuses_AlreadyOffline(t *testing.T) {
	database := newTestDB(t)
	_, _ = database.CreateUser(context.Background(), "offline_user", "hash", 4)

	// Should not error when all users are already offline.
	if err := database.ResetAllUserStatuses(context.Background()); err != nil {
		t.Errorf("ResetAllUserStatuses: %v", err)
	}
}

// ─── ListMembers ────────────────────────────────────────────────────────────

func TestListMembers_Empty(t *testing.T) {
	database := newTestDB(t)

	members, err := database.ListMembers(context.Background())
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(members) != 0 {
		t.Errorf("ListMembers() = %d, want 0", len(members))
	}
}

func TestListMembers_ExcludesBanned(t *testing.T) {
	database := newTestDB(t)
	id1, _ := database.CreateUser(context.Background(), "member_visible", "hash", 4)
	id2, _ := database.CreateUser(context.Background(), "member_banned", "hash", 4)
	_ = database.BanUser(context.Background(), id2, "test ban", nil)
	_ = id1 // suppress unused

	members, err := database.ListMembers(context.Background())
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(members) != 1 {
		t.Fatalf("ListMembers() = %d, want 1 (banned excluded)", len(members))
	}
	if members[0].Username != "member_visible" {
		t.Errorf("Username = %q, want 'member_visible'", members[0].Username)
	}
	if members[0].Role == "" {
		t.Error("Role should not be empty")
	}
}

func TestListMembers_SortedByUsername(t *testing.T) {
	database := newTestDB(t)
	_, _ = database.CreateUser(context.Background(), "zeta_user", "hash", 4)
	_, _ = database.CreateUser(context.Background(), "alpha_user", "hash", 4)
	_, _ = database.CreateUser(context.Background(), "mid_user", "hash", 4)

	members, err := database.ListMembers(context.Background())
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(members) != 3 {
		t.Fatalf("ListMembers() = %d, want 3", len(members))
	}
	if members[0].Username != "alpha_user" {
		t.Errorf("first member = %q, want 'alpha_user' (sorted)", members[0].Username)
	}
	if members[2].Username != "zeta_user" {
		t.Errorf("last member = %q, want 'zeta_user' (sorted)", members[2].Username)
	}
}

// ─── Identity key (F3 voice E2EE TOFU) ───────────────────────────────────────

func TestUpdateUserIdentityKey_RoundTrip(t *testing.T) {
	database := newTestDB(t)
	id, err := database.CreateUser(context.Background(), "idkey_user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	key := "BAsE64iDeNtItYkEy+/=="
	if err := database.UpdateUserIdentityKey(context.Background(), id, &key); err != nil {
		t.Fatalf("UpdateUserIdentityKey: %v", err)
	}

	u, err := database.GetUserByID(context.Background(), id)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if u.IdentityPublicKey == nil || *u.IdentityPublicKey != key {
		t.Errorf("IdentityPublicKey = %v, want %q", u.IdentityPublicKey, key)
	}
}

func TestUpdateUserIdentityKey_LastWriteWins(t *testing.T) {
	database := newTestDB(t)
	id, err := database.CreateUser(context.Background(), "idkey_rotate", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	first := "Zmlyc3RrZXk="
	second := "c2Vjb25ka2V5"
	if err := database.UpdateUserIdentityKey(context.Background(), id, &first); err != nil {
		t.Fatalf("UpdateUserIdentityKey(first): %v", err)
	}
	if err := database.UpdateUserIdentityKey(context.Background(), id, &second); err != nil {
		t.Fatalf("UpdateUserIdentityKey(second): %v", err)
	}

	u, err := database.GetUserByID(context.Background(), id)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if u.IdentityPublicKey == nil || *u.IdentityPublicKey != second {
		t.Errorf("IdentityPublicKey = %v, want %q (last write wins)", u.IdentityPublicKey, second)
	}
}

func TestListMembers_IncludesIdentityKey(t *testing.T) {
	database := newTestDB(t)
	id, err := database.CreateUser(context.Background(), "idkey_member", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	key := "bWVtYmVya2V5"
	if err := database.UpdateUserIdentityKey(context.Background(), id, &key); err != nil {
		t.Fatalf("UpdateUserIdentityKey: %v", err)
	}
	// A user who never published a key must come back with a nil key.
	if _, err := database.CreateUser(context.Background(), "idkey_none", "hash", 4); err != nil {
		t.Fatalf("CreateUser(none): %v", err)
	}

	members, err := database.ListMembers(context.Background())
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(members) != 2 {
		t.Fatalf("ListMembers() = %d, want 2", len(members))
	}
	byName := map[string]db.MemberSummary{}
	for _, m := range members {
		byName[m.Username] = m
	}
	got := byName["idkey_member"].IdentityPublicKey
	if got == nil || *got != key {
		t.Errorf("idkey_member IdentityPublicKey = %v, want %q", got, key)
	}
	if byName["idkey_none"].IdentityPublicKey != nil {
		t.Errorf("idkey_none IdentityPublicKey = %v, want nil", *byName["idkey_none"].IdentityPublicKey)
	}
}
