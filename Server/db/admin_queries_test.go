package db_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/owncord/server/db"
)

// adminTestSchema extends testSchema with tables needed for admin queries.
var adminTestSchema = append(testSchema, []byte(`
CREATE TABLE IF NOT EXISTS channels (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    type             TEXT    NOT NULL DEFAULT 'text',
    category         TEXT,
    topic            TEXT,
    position         INTEGER NOT NULL DEFAULT 0,
    slow_mode        INTEGER NOT NULL DEFAULT 0,
    archived         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    voice_max_users  INTEGER NOT NULL DEFAULT 0,
    voice_quality    TEXT,
    mixing_threshold INTEGER,
    voice_max_video  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    content    TEXT    NOT NULL,
    reply_to   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    edited_at  TEXT,
    deleted    INTEGER NOT NULL DEFAULT 0,
    pinned     INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL REFERENCES users(id),
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
    ('server_name', 'OwnCord Server'),
    ('motd', 'Welcome!');
`)...)

// newAdminTestDB opens an in-memory database with the admin-extended schema.
func newAdminTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: adminTestSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// ─── GetServerStats ────────────────────────────────────────────────────────────

func TestGetServerStats_EmptyDB(t *testing.T) {
	database := newAdminTestDB(t)

	stats, err := database.GetServerStats()
	if err != nil {
		t.Fatalf("GetServerStats() error: %v", err)
	}
	if stats == nil {
		t.Fatal("GetServerStats() returned nil")
	}
	if stats.UserCount != 0 {
		t.Errorf("UserCount = %d, want 0", stats.UserCount)
	}
	if stats.MessageCount != 0 {
		t.Errorf("MessageCount = %d, want 0", stats.MessageCount)
	}
	if stats.ChannelCount != 0 {
		t.Errorf("ChannelCount = %d, want 0", stats.ChannelCount)
	}
	if stats.InviteCount != 0 {
		t.Errorf("InviteCount = %d, want 0", stats.InviteCount)
	}
	if stats.DBSizeBytes < 0 {
		t.Errorf("DBSizeBytes = %d, want >= 0", stats.DBSizeBytes)
	}
}

func TestGetServerStats_WithData(t *testing.T) {
	database := newAdminTestDB(t)

	_, err := database.CreateUser("statuser", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser error: %v", err)
	}

	_, err = database.CreateChannel("general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel error: %v", err)
	}

	stats, err := database.GetServerStats()
	if err != nil {
		t.Fatalf("GetServerStats() error: %v", err)
	}
	if stats.UserCount != 1 {
		t.Errorf("UserCount = %d, want 1", stats.UserCount)
	}
	if stats.ChannelCount != 1 {
		t.Errorf("ChannelCount = %d, want 1", stats.ChannelCount)
	}
}

// ─── ListAllUsers ──────────────────────────────────────────────────────────────

func TestListAllUsers_Empty(t *testing.T) {
	database := newAdminTestDB(t)

	users, err := database.ListAllUsers(50, 0)
	if err != nil {
		t.Fatalf("ListAllUsers() error: %v", err)
	}
	if len(users) != 0 {
		t.Errorf("ListAllUsers() = %d users, want 0", len(users))
	}
}

func TestListAllUsers_WithRoleName(t *testing.T) {
	database := newAdminTestDB(t)

	_, err := database.CreateUser("alice", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser error: %v", err)
	}

	users, err := database.ListAllUsers(50, 0)
	if err != nil {
		t.Fatalf("ListAllUsers() error: %v", err)
	}
	if len(users) != 1 {
		t.Fatalf("ListAllUsers() = %d users, want 1", len(users))
	}
	if users[0].Username != "alice" {
		t.Errorf("Username = %q, want 'alice'", users[0].Username)
	}
	// RoleName comes from JOIN with roles table
	if users[0].RoleName == "" {
		t.Error("RoleName should not be empty — JOIN with roles table failed")
	}
}

func TestListAllUsers_Pagination(t *testing.T) {
	database := newAdminTestDB(t)

	for i := range 5 {
		_, err := database.CreateUser(
			strings.Repeat("u", i+1),
			"hash",
			4,
		)
		if err != nil {
			t.Fatalf("CreateUser[%d] error: %v", i, err)
		}
	}

	page1, err := database.ListAllUsers(3, 0)
	if err != nil {
		t.Fatalf("ListAllUsers page1 error: %v", err)
	}
	if len(page1) != 3 {
		t.Errorf("page1 len = %d, want 3", len(page1))
	}

	page2, err := database.ListAllUsers(3, 3)
	if err != nil {
		t.Fatalf("ListAllUsers page2 error: %v", err)
	}
	if len(page2) != 2 {
		t.Errorf("page2 len = %d, want 2", len(page2))
	}
}

func TestListAllUsers_ZeroLimit(t *testing.T) {
	database := newAdminTestDB(t)
	_, _ = database.CreateUser("zerotest", "hash", 4)

	users, err := database.ListAllUsers(0, 0)
	if err != nil {
		t.Fatalf("ListAllUsers(0, 0) error: %v", err)
	}
	// limit=0 should return nothing
	if len(users) != 0 {
		t.Errorf("ListAllUsers(0, 0) = %d users, want 0", len(users))
	}
}

// ─── UpdateUserRole ────────────────────────────────────────────────────────────

func TestUpdateUserRole(t *testing.T) {
	database := newAdminTestDB(t)

	uid, err := database.CreateUser("roleuser", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser error: %v", err)
	}

	if err := database.UpdateUserRole(uid, 2); err != nil {
		t.Fatalf("UpdateUserRole() error: %v", err)
	}

	user, err := database.GetUserByID(uid)
	if err != nil {
		t.Fatalf("GetUserByID error: %v", err)
	}
	if user.RoleID != 2 {
		t.Errorf("RoleID = %d, want 2", user.RoleID)
	}
}

func TestUpdateUserRole_NonexistentUser(t *testing.T) {
	database := newAdminTestDB(t)

	// UPDATE with no matching rows is not an error
	err := database.UpdateUserRole(99999, 2)
	if err != nil {
		t.Errorf("UpdateUserRole() for nonexistent user returned unexpected error: %v", err)
	}
}

// ─── ForceLogoutUser ───────────────────────────────────────────────────────────

func TestForceLogoutUser_DeletesSessions(t *testing.T) {
	database := newAdminTestDB(t)

	uid, err := database.CreateUser("logoutuser", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser error: %v", err)
	}

	_, _ = database.CreateSession(uid, "token1hash", "device1", "127.0.0.1")
	_, _ = database.CreateSession(uid, "token2hash", "device2", "127.0.0.1")

	sessions, err := database.GetUserSessions(uid)
	if err != nil {
		t.Fatalf("GetUserSessions error: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions before logout, got %d", len(sessions))
	}

	if err := database.ForceLogoutUser(uid); err != nil {
		t.Fatalf("ForceLogoutUser() error: %v", err)
	}

	sessions, err = database.GetUserSessions(uid)
	if err != nil {
		t.Fatalf("GetUserSessions after logout error: %v", err)
	}
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after ForceLogoutUser, got %d", len(sessions))
	}
}

func TestForceLogoutUser_NoSessions(t *testing.T) {
	database := newAdminTestDB(t)

	uid, err := database.CreateUser("nosessions", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser error: %v", err)
	}

	if err := database.ForceLogoutUser(uid); err != nil {
		t.Errorf("ForceLogoutUser() on user with no sessions returned error: %v", err)
	}
}

// ─── GetUserSessions ──────────────────────────────────────────────────────────

func TestGetUserSessions_Empty(t *testing.T) {
	database := newAdminTestDB(t)

	uid, err := database.CreateUser("sessionuser", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser error: %v", err)
	}

	sessions, err := database.GetUserSessions(uid)
	if err != nil {
		t.Fatalf("GetUserSessions() error: %v", err)
	}
	if len(sessions) != 0 {
		t.Errorf("GetUserSessions() = %d, want 0", len(sessions))
	}
}

func TestGetUserSessions_IsolatedByUser(t *testing.T) {
	database := newAdminTestDB(t)

	uid1, _ := database.CreateUser("user1sess", "hash", 4)
	uid2, _ := database.CreateUser("user2sess", "hash", 4)

	_, _ = database.CreateSession(uid1, "u1t1", "web", "1.2.3.4")
	_, _ = database.CreateSession(uid1, "u1t2", "mobile", "1.2.3.5")
	_, _ = database.CreateSession(uid2, "u2t1", "web", "1.2.3.6")

	sessions, err := database.GetUserSessions(uid1)
	if err != nil {
		t.Fatalf("GetUserSessions() error: %v", err)
	}
	if len(sessions) != 2 {
		t.Errorf("GetUserSessions(uid1) = %d sessions, want 2", len(sessions))
	}
	for _, s := range sessions {
		if s.UserID != uid1 {
			t.Errorf("session UserID = %d, want %d", s.UserID, uid1)
		}
	}
}

// ─── AdminCreateChannel ────────────────────────────────────────────────────────

func TestAdminCreateChannel(t *testing.T) {
	database := newAdminTestDB(t)

	id, err := database.AdminCreateChannel("announce", "text", "General", "Announcements", 1)
	if err != nil {
		t.Fatalf("AdminCreateChannel() error: %v", err)
	}
	if id <= 0 {
		t.Errorf("AdminCreateChannel() id = %d, want > 0", id)
	}

	ch, err := database.GetChannel(id)
	if err != nil {
		t.Fatalf("GetChannel() error: %v", err)
	}
	if ch == nil {
		t.Fatal("GetChannel() returned nil after AdminCreateChannel")
	}
	if ch.Name != "announce" {
		t.Errorf("Name = %q, want 'announce'", ch.Name)
	}
	if ch.Type != "text" {
		t.Errorf("Type = %q, want 'text'", ch.Type)
	}
	if ch.Category != "General" {
		t.Errorf("Category = %q, want 'General'", ch.Category)
	}
	if ch.Topic != "Announcements" {
		t.Errorf("Topic = %q, want 'Announcements'", ch.Topic)
	}
	if ch.Position != 1 {
		t.Errorf("Position = %d, want 1", ch.Position)
	}
}

func TestAdminCreateChannel_EmptyOptionals(t *testing.T) {
	database := newAdminTestDB(t)

	id, err := database.AdminCreateChannel("simple", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("AdminCreateChannel() error: %v", err)
	}

	ch, err := database.GetChannel(id)
	if err != nil {
		t.Fatalf("GetChannel() error: %v", err)
	}
	if ch.Category != "" {
		t.Errorf("Category = %q, want ''", ch.Category)
	}
	if ch.Topic != "" {
		t.Errorf("Topic = %q, want ''", ch.Topic)
	}
}

// ─── AdminUpdateChannel ────────────────────────────────────────────────────────

func TestAdminUpdateChannel(t *testing.T) {
	database := newAdminTestDB(t)

	id, err := database.AdminCreateChannel("old-name", "text", "", "", 0)
	if err != nil {
		t.Fatalf("AdminCreateChannel() error: %v", err)
	}

	if err := database.AdminUpdateChannel(id, "new-name", "new topic", 5, 2, true); err != nil {
		t.Fatalf("AdminUpdateChannel() error: %v", err)
	}

	ch, err := database.GetChannel(id)
	if err != nil {
		t.Fatalf("GetChannel() error: %v", err)
	}
	if ch.Name != "new-name" {
		t.Errorf("Name = %q, want 'new-name'", ch.Name)
	}
	if ch.Topic != "new topic" {
		t.Errorf("Topic = %q, want 'new topic'", ch.Topic)
	}
	if ch.SlowMode != 5 {
		t.Errorf("SlowMode = %d, want 5", ch.SlowMode)
	}
	if ch.Position != 2 {
		t.Errorf("Position = %d, want 2", ch.Position)
	}
	if !ch.Archived {
		t.Error("Archived = false, want true")
	}
}

func TestAdminUpdateChannel_Unarchive(t *testing.T) {
	database := newAdminTestDB(t)

	id, _ := database.AdminCreateChannel("arch-ch", "text", "", "", 0)
	_ = database.AdminUpdateChannel(id, "arch-ch", "", 0, 0, true)

	ch, _ := database.GetChannel(id)
	if !ch.Archived {
		t.Fatal("channel should be archived")
	}

	// Unarchive
	_ = database.AdminUpdateChannel(id, "arch-ch", "", 0, 0, false)
	ch, _ = database.GetChannel(id)
	if ch.Archived {
		t.Error("Archived = true after unarchiving, want false")
	}
}

// ─── AdminDeleteChannel ────────────────────────────────────────────────────────

func TestAdminDeleteChannel(t *testing.T) {
	database := newAdminTestDB(t)

	id, err := database.AdminCreateChannel("to-delete", "text", "", "", 0)
	if err != nil {
		t.Fatalf("AdminCreateChannel() error: %v", err)
	}

	if err := database.AdminDeleteChannel(id); err != nil {
		t.Fatalf("AdminDeleteChannel() error: %v", err)
	}

	ch, err := database.GetChannel(id)
	if err != nil {
		t.Fatalf("GetChannel() after delete error: %v", err)
	}
	if ch != nil {
		t.Error("channel should not exist after AdminDeleteChannel")
	}
}

func TestAdminDeleteChannel_NonExistent(t *testing.T) {
	database := newAdminTestDB(t)

	// Deleting nonexistent channel should not error
	if err := database.AdminDeleteChannel(99999); err != nil {
		t.Errorf("AdminDeleteChannel(nonexistent) error: %v", err)
	}
}

// ─── LogAudit / GetAuditLog ────────────────────────────────────────────────────

func TestLogAudit_AndRetrieve(t *testing.T) {
	database := newAdminTestDB(t)

	uid, err := database.CreateUser("auditor", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser error: %v", err)
	}

	if err := database.LogAudit(uid, "USER_BANNED", "user", 42, "banned for spam"); err != nil {
		t.Fatalf("LogAudit() error: %v", err)
	}

	entries, err := database.GetAuditLog(10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog() error: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("GetAuditLog() = %d entries, want 1", len(entries))
	}

	e := entries[0]
	if e.ActorID != uid {
		t.Errorf("ActorID = %d, want %d", e.ActorID, uid)
	}
	if e.Action != "USER_BANNED" {
		t.Errorf("Action = %q, want 'USER_BANNED'", e.Action)
	}
	if e.TargetType != "user" {
		t.Errorf("TargetType = %q, want 'user'", e.TargetType)
	}
	if e.TargetID != 42 {
		t.Errorf("TargetID = %d, want 42", e.TargetID)
	}
	if e.Detail != "banned for spam" {
		t.Errorf("Detail = %q, want 'banned for spam'", e.Detail)
	}
	if e.ActorName != "auditor" {
		t.Errorf("ActorName = %q, want 'auditor'", e.ActorName)
	}
	if e.CreatedAt == "" {
		t.Error("CreatedAt should not be empty")
	}
}

func TestGetAuditLog_Empty(t *testing.T) {
	database := newAdminTestDB(t)

	entries, err := database.GetAuditLog(10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog() error: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("GetAuditLog() = %d entries, want 0", len(entries))
	}
}

func TestGetAuditLog_Pagination(t *testing.T) {
	database := newAdminTestDB(t)

	uid, _ := database.CreateUser("auditpager", "hash", 1)
	for i := range 5 {
		_ = database.LogAudit(uid, "ACTION", "target", int64(i), "detail")
	}

	page1, err := database.GetAuditLog(3, 0)
	if err != nil {
		t.Fatalf("GetAuditLog page1 error: %v", err)
	}
	if len(page1) != 3 {
		t.Errorf("page1 len = %d, want 3", len(page1))
	}

	page2, err := database.GetAuditLog(3, 3)
	if err != nil {
		t.Fatalf("GetAuditLog page2 error: %v", err)
	}
	if len(page2) != 2 {
		t.Errorf("page2 len = %d, want 2", len(page2))
	}
}

func TestGetAuditLog_NewestFirst(t *testing.T) {
	database := newAdminTestDB(t)

	uid, _ := database.CreateUser("auditorder", "hash", 1)
	_ = database.LogAudit(uid, "FIRST", "", 0, "")
	_ = database.LogAudit(uid, "SECOND", "", 0, "")

	entries, err := database.GetAuditLog(10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog() error: %v", err)
	}
	if len(entries) < 2 {
		t.Fatalf("expected at least 2 entries, got %d", len(entries))
	}
	if entries[0].ID <= entries[1].ID {
		t.Error("GetAuditLog should return newest entries first (highest ID first)")
	}
}

// ─── GetSetting / SetSetting / GetAllSettings ──────────────────────────────────

func TestGetSetting_Exists(t *testing.T) {
	database := newAdminTestDB(t)

	val, err := database.GetSetting("server_name")
	if err != nil {
		t.Fatalf("GetSetting() error: %v", err)
	}
	if val == "" {
		t.Error("server_name should not be empty")
	}
}

func TestGetSetting_NotFound(t *testing.T) {
	database := newAdminTestDB(t)

	_, err := database.GetSetting("nonexistent_key_xyz")
	if err == nil {
		t.Error("GetSetting() for nonexistent key should return error")
	}
}

func TestSetSetting_NewKey(t *testing.T) {
	database := newAdminTestDB(t)

	if err := database.SetSetting("custom_key", "custom_val"); err != nil {
		t.Fatalf("SetSetting() error: %v", err)
	}

	val, err := database.GetSetting("custom_key")
	if err != nil {
		t.Fatalf("GetSetting() after SetSetting error: %v", err)
	}
	if val != "custom_val" {
		t.Errorf("val = %q, want 'custom_val'", val)
	}
}

func TestSetSetting_UpdateExisting(t *testing.T) {
	database := newAdminTestDB(t)

	if err := database.SetSetting("server_name", "My Custom Server"); err != nil {
		t.Fatalf("SetSetting() update error: %v", err)
	}

	val, err := database.GetSetting("server_name")
	if err != nil {
		t.Fatalf("GetSetting() error: %v", err)
	}
	if val != "My Custom Server" {
		t.Errorf("val = %q, want 'My Custom Server'", val)
	}
}

func TestGetAllSettings_ReturnsMap(t *testing.T) {
	database := newAdminTestDB(t)

	settings, err := database.GetAllSettings()
	if err != nil {
		t.Fatalf("GetAllSettings() error: %v", err)
	}
	if len(settings) == 0 {
		t.Error("GetAllSettings() should return default settings")
	}
	if _, ok := settings["server_name"]; !ok {
		t.Error("GetAllSettings() missing 'server_name'")
	}
}

func TestGetAllSettings_AfterClearing(t *testing.T) {
	database := newAdminTestDB(t)

	_, _ = database.Exec("DELETE FROM settings")

	settings, err := database.GetAllSettings()
	if err != nil {
		t.Fatalf("GetAllSettings() after clearing error: %v", err)
	}
	if len(settings) != 0 {
		t.Errorf("GetAllSettings() after clearing = %d entries, want 0", len(settings))
	}
}

// ─── BackupToSafe ────────────────────────────────────────────────────────────

func TestBackupToSafe_AdminQueries(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "source.db")

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: adminTestSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}

	backupDir := filepath.Join(tmpDir, "backups")
	_ = os.MkdirAll(backupDir, 0o755)
	backupPath := filepath.Join(backupDir, "backup.db")
	if err := database.BackupToSafe(backupPath, backupDir); err != nil {
		t.Fatalf("BackupToSafe() error: %v", err)
	}

	info, err := os.Stat(backupPath)
	if err != nil {
		t.Fatalf("backup file does not exist: %v", err)
	}
	if info.Size() == 0 {
		t.Error("backup file is empty")
	}
}

func TestBackupToSafe_CreatesDirectoryFile(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "src.db")

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: adminTestSchema},
	}
	_ = db.MigrateFS(database, migrFS)

	backupDir := filepath.Join(tmpDir, "backups")
	_ = os.MkdirAll(backupDir, 0o755)
	backupPath := filepath.Join(backupDir, "chatserver_20260314_120000.db")

	if err := database.BackupToSafe(backupPath, backupDir); err != nil {
		t.Fatalf("BackupToSafe() error: %v", err)
	}

	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		t.Error("backup file was not created")
	}
}
