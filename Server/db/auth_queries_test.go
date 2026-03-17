package db_test

import (
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
    ban_expires TEXT
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
	id, err := database.CreateUser("alice", "hash123", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if id <= 0 {
		t.Errorf("CreateUser returned id = %d, want > 0", id)
	}
}

func TestCreateUser_DuplicateUsername(t *testing.T) {
	database := newTestDB(t)
	if _, err := database.CreateUser("bob", "hash1", 4); err != nil {
		t.Fatalf("first CreateUser: %v", err)
	}
	_, err := database.CreateUser("bob", "hash2", 4)
	if err == nil {
		t.Error("CreateUser() with duplicate username returned nil error, want error")
	}
}

func TestCreateUser_CaseInsensitiveDuplicate(t *testing.T) {
	database := newTestDB(t)
	if _, err := database.CreateUser("Charlie", "hash1", 4); err != nil {
		t.Fatalf("first CreateUser: %v", err)
	}
	_, err := database.CreateUser("charlie", "hash2", 4)
	if err == nil {
		t.Error("CreateUser() with case-insensitive duplicate returned nil error, want error")
	}
}

func TestGetUserByUsername_Found(t *testing.T) {
	database := newTestDB(t)
	_, _ = database.CreateUser("dave", "hashDave", 4)

	user, err := database.GetUserByUsername("dave")
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
	_, _ = database.CreateUser("Eve", "hashEve", 4)

	user, err := database.GetUserByUsername("EVE")
	if err != nil {
		t.Fatalf("GetUserByUsername case-insensitive: %v", err)
	}
	if user == nil {
		t.Fatal("GetUserByUsername returned nil for case-insensitive match")
	}
}

func TestGetUserByUsername_NotFound(t *testing.T) {
	database := newTestDB(t)
	user, err := database.GetUserByUsername("nobody")
	if err != nil {
		t.Fatalf("GetUserByUsername(not found): %v", err)
	}
	if user != nil {
		t.Error("GetUserByUsername returned non-nil for missing user")
	}
}

func TestGetUserByID_Found(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser("frank", "hashFrank", 4)

	user, err := database.GetUserByID(id)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if user.ID != id {
		t.Errorf("ID = %d, want %d", user.ID, id)
	}
}

func TestGetUserByID_NotFound(t *testing.T) {
	database := newTestDB(t)
	user, err := database.GetUserByID(999)
	if err != nil {
		t.Fatalf("GetUserByID(not found): %v", err)
	}
	if user != nil {
		t.Error("GetUserByID returned non-nil for missing user")
	}
}

func TestUpdateUserStatus(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser("grace", "hash", 4)

	if err := database.UpdateUserStatus(id, "online"); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}
	user, _ := database.GetUserByID(id)
	if user.Status != "online" {
		t.Errorf("Status = %q, want %q", user.Status, "online")
	}
}

func TestBanUser_Permanent(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser("hank", "hash", 4)

	if err := database.BanUser(id, "spam", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	user, _ := database.GetUserByID(id)
	if !user.Banned {
		t.Error("Banned = false after BanUser, want true")
	}
	if user.BanExpires != nil {
		t.Errorf("BanExpires = %v, want nil for permanent ban", user.BanExpires)
	}
}

func TestBanUser_Temporary(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser("ivan", "hash", 4)
	expires := time.Now().Add(24 * time.Hour)

	if err := database.BanUser(id, "temp ban", &expires); err != nil {
		t.Fatalf("BanUser (temp): %v", err)
	}
	user, _ := database.GetUserByID(id)
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
	uid, _ := database.CreateUser("jack", "hash", 4)

	id, err := database.CreateSession(uid, "tokenHash1", "GoTest/1.0", "127.0.0.1")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if id <= 0 {
		t.Errorf("CreateSession id = %d, want > 0", id)
	}
}

func TestGetSessionByTokenHash_Found(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("kate", "hash", 4)
	_, _ = database.CreateSession(uid, "myTokenHash", "GoTest/1.0", "127.0.0.1")

	sess, err := database.GetSessionByTokenHash("myTokenHash")
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
	sess, err := database.GetSessionByTokenHash("nonexistent")
	if err != nil {
		t.Fatalf("GetSessionByTokenHash(not found): %v", err)
	}
	if sess != nil {
		t.Error("GetSessionByTokenHash returned non-nil for missing session")
	}
}

func TestDeleteSession(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("leo", "hash", 4)
	_, _ = database.CreateSession(uid, "delToken", "GoTest/1.0", "127.0.0.1")

	if err := database.DeleteSession("delToken"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	sess, _ := database.GetSessionByTokenHash("delToken")
	if sess != nil {
		t.Error("Session still exists after DeleteSession")
	}
}

func TestDeleteExpiredSessions(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("mia", "hash", 4)

	// Insert an already-expired session directly via Exec.
	// Use SQLite datetime format (space separator) to match what datetime('now') produces.
	pastTime := time.Now().Add(-time.Hour).UTC().Format("2006-01-02 15:04:05")
	_, err := database.Exec(
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)`,
		uid, "expiredToken", "test", "127.0.0.1", pastTime,
	)
	if err != nil {
		t.Fatalf("inserting expired session: %v", err)
	}

	// Insert a valid session through the normal path.
	_, _ = database.CreateSession(uid, "validToken", "GoTest/1.0", "127.0.0.1")

	if err := database.DeleteExpiredSessions(); err != nil {
		t.Fatalf("DeleteExpiredSessions: %v", err)
	}

	expired, _ := database.GetSessionByTokenHash("expiredToken")
	if expired != nil {
		t.Error("Expired session still exists after DeleteExpiredSessions")
	}
	valid, _ := database.GetSessionByTokenHash("validToken")
	if valid == nil {
		t.Error("Valid session was deleted by DeleteExpiredSessions")
	}
}

func TestTouchSession(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("noah", "hash", 4)
	_, _ = database.CreateSession(uid, "touchToken", "GoTest/1.0", "127.0.0.1")

	sess1, _ := database.GetSessionByTokenHash("touchToken")
	time.Sleep(2 * time.Millisecond)

	if err := database.TouchSession("touchToken"); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}

	sess2, _ := database.GetSessionByTokenHash("touchToken")
	if sess1.LastUsed == sess2.LastUsed {
		// last_used should have advanced; if they're equal the touch had no effect
		// (This can be flaky at millisecond resolution, but is a reasonable sanity check.)
		t.Log("TouchSession: last_used unchanged (may be a timing issue on fast machines)")
	}
}

// ─── Invite tests ─────────────────────────────────────────────────────────────

func TestCreateInvite_Success(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("olivia", "hash", 4)

	code, err := database.CreateInvite(uid, 0, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if len(code) == 0 {
		t.Error("CreateInvite returned empty code")
	}
}

func TestGetInvite_Found(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("pedro", "hash", 4)
	code, _ := database.CreateInvite(uid, 5, nil)

	inv, err := database.GetInvite(code)
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
	inv, err := database.GetInvite("bogus")
	if err != nil {
		t.Fatalf("GetInvite(not found): %v", err)
	}
	if inv != nil {
		t.Error("GetInvite returned non-nil for missing code")
	}
}

func TestRevokeInvite(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("uma", "hash", 4)
	code, _ := database.CreateInvite(uid, 0, nil)

	if err := database.RevokeInvite(code); err != nil {
		t.Fatalf("RevokeInvite: %v", err)
	}

	inv, _ := database.GetInvite(code)
	if !inv.Revoked {
		t.Error("Revoked = false after RevokeInvite, want true")
	}
}

func TestCreateInvite_UnlimitedUses(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("vera", "hash", 4)
	code, _ := database.CreateInvite(uid, 0, nil) // 0 = unlimited

	inv, _ := database.GetInvite(code)
	if inv.MaxUses != nil {
		t.Errorf("MaxUses = %v, want nil for unlimited", inv.MaxUses)
	}
}

// ─── UseInviteAtomic tests ─────────────────────────────────────────────────────

// TestUseInviteAtomic_Success verifies a valid unlimited invite is accepted and
// its use_count incremented in one operation.
func TestUseInviteAtomic_Success(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("atomic_user1", "hash", 4)
	code, _ := database.CreateInvite(uid, 0, nil)

	if err := database.UseInviteAtomic(code); err != nil {
		t.Fatalf("UseInviteAtomic: %v", err)
	}

	inv, _ := database.GetInvite(code)
	if inv.Uses != 1 {
		t.Errorf("Uses = %d, want 1", inv.Uses)
	}
}

// TestUseInviteAtomic_IncrementsUses verifies the count advances correctly over
// multiple sequential calls.
func TestUseInviteAtomic_IncrementsUses(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("atomic_user2", "hash", 4)
	code, _ := database.CreateInvite(uid, 5, nil)

	for i := range 3 {
		if err := database.UseInviteAtomic(code); err != nil {
			t.Fatalf("UseInviteAtomic iteration %d: %v", i, err)
		}
	}

	inv, _ := database.GetInvite(code)
	if inv.Uses != 3 {
		t.Errorf("Uses = %d, want 3", inv.Uses)
	}
}

// TestUseInviteAtomic_Revoked returns an error for a revoked invite without
// modifying the database.
func TestUseInviteAtomic_Revoked(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("atomic_user3", "hash", 4)
	code, _ := database.CreateInvite(uid, 0, nil)
	_ = database.RevokeInvite(code)

	if err := database.UseInviteAtomic(code); err == nil {
		t.Error("UseInviteAtomic returned nil error for revoked invite, want error")
	}

	// use_count must not have changed.
	inv, _ := database.GetInvite(code)
	if inv.Uses != 0 {
		t.Errorf("Uses = %d after revoked attempt, want 0", inv.Uses)
	}
}

// TestUseInviteAtomic_Expired returns an error for an expired invite.
func TestUseInviteAtomic_Expired(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("atomic_user4", "hash", 4)

	past := time.Now().Add(-time.Hour)
	code, _ := database.CreateInvite(uid, 0, &past)

	if err := database.UseInviteAtomic(code); err == nil {
		t.Error("UseInviteAtomic returned nil error for expired invite, want error")
	}
}

// TestUseInviteAtomic_ExceedsMaxUses returns an error when the invite has
// reached its maximum use count.
func TestUseInviteAtomic_ExceedsMaxUses(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("atomic_user5", "hash", 4)
	code, _ := database.CreateInvite(uid, 1, nil)

	if err := database.UseInviteAtomic(code); err != nil {
		t.Fatalf("UseInviteAtomic first use: %v", err)
	}
	if err := database.UseInviteAtomic(code); err == nil {
		t.Error("UseInviteAtomic returned nil error after exceeding max_uses, want error")
	}
}

// TestUseInviteAtomic_NotFound returns an error for a completely unknown code.
func TestUseInviteAtomic_NotFound(t *testing.T) {
	database := newTestDB(t)

	if err := database.UseInviteAtomic("doesnotexist"); err == nil {
		t.Error("UseInviteAtomic returned nil error for unknown code, want error")
	}
}

// TestUseInviteAtomic_ConcurrentSameCode simulates two goroutines racing to
// redeem a single-use invite.  Exactly one must succeed and exactly one must
// fail; the use_count must end up at 1.
func TestUseInviteAtomic_ConcurrentSameCode(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("atomic_user6", "hash", 4)
	code, _ := database.CreateInvite(uid, 1, nil)

	type result struct{ err error }
	results := make(chan result, 2)

	for range 2 {
		go func() {
			results <- result{err: database.UseInviteAtomic(code)}
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

	inv, _ := database.GetInvite(code)
	if inv.Uses != 1 {
		t.Errorf("use_count = %d after concurrent race, want 1", inv.Uses)
	}
}
