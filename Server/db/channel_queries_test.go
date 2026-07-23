package db_test

import (
	"context"
	"testing"

	"github.com/owncord/server/db"
)

// openMigratedMemory opens an in-memory DB and runs the full migration.
func openMigratedMemory(t *testing.T) *db.DB {
	t.Helper()
	database := openMemory(t)
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}
	return database
}

// ─── ListChannels ─────────────────────────────────────────────────────────────

func TestListChannels_Empty(t *testing.T) {
	database := openMigratedMemory(t)

	channels, err := database.ListChannels(context.Background())
	if err != nil {
		t.Fatalf("ListChannels() error: %v", err)
	}
	if len(channels) != 0 {
		t.Errorf("expected 0 channels, got %d", len(channels))
	}
}

func TestListChannels_ReturnsAll(t *testing.T) {
	database := openMigratedMemory(t)

	if _, err := database.CreateChannel(context.Background(), "general", "text", "", "General chat", 0); err != nil {
		t.Fatalf("CreateChannel general: %v", err)
	}
	if _, err := database.CreateChannel(context.Background(), "announcements", "text", "", "", 1); err != nil {
		t.Fatalf("CreateChannel announcements: %v", err)
	}

	channels, err := database.ListChannels(context.Background())
	if err != nil {
		t.Fatalf("ListChannels() error: %v", err)
	}
	if len(channels) != 2 {
		t.Errorf("expected 2 channels, got %d", len(channels))
	}
}

// ─── GetChannel ───────────────────────────────────────────────────────────────

func TestGetChannel_NotFound(t *testing.T) {
	database := openMigratedMemory(t)

	ch, err := database.GetChannel(context.Background(), 9999)
	if err != nil {
		t.Fatalf("GetChannel() error: %v", err)
	}
	if ch != nil {
		t.Error("expected nil for non-existent channel")
	}
}

func TestGetChannel_Found(t *testing.T) {
	database := openMigratedMemory(t)

	id, err := database.CreateChannel(context.Background(), "general", "text", "Public", "hello", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	ch, err := database.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if ch == nil {
		t.Fatal("expected channel, got nil")
	}
	if ch.Name != "general" {
		t.Errorf("Name = %q, want 'general'", ch.Name)
	}
	if ch.Type != "text" {
		t.Errorf("Type = %q, want 'text'", ch.Type)
	}
	if ch.Category != "Public" {
		t.Errorf("Category = %q, want 'Public'", ch.Category)
	}
	if ch.Topic != "hello" {
		t.Errorf("Topic = %q, want 'hello'", ch.Topic)
	}
	if ch.Position != 0 {
		t.Errorf("Position = %d, want 0", ch.Position)
	}
}

// ─── CreateChannel ────────────────────────────────────────────────────────────

func TestCreateChannel_ReturnsID(t *testing.T) {
	database := openMigratedMemory(t)

	id, err := database.CreateChannel(context.Background(), "test", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if id <= 0 {
		t.Errorf("expected positive ID, got %d", id)
	}
}

func TestCreateChannel_UniqueIDs(t *testing.T) {
	database := openMigratedMemory(t)

	id1, _ := database.CreateChannel(context.Background(), "ch1", "text", "", "", 0)
	id2, _ := database.CreateChannel(context.Background(), "ch2", "text", "", "", 1)
	if id1 == id2 {
		t.Error("expected different IDs for different channels")
	}
}

func TestCreateChannel_EmptyCategory(t *testing.T) {
	database := openMigratedMemory(t)

	id, err := database.CreateChannel(context.Background(), "nocategory", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel with empty category: %v", err)
	}
	ch, _ := database.GetChannel(context.Background(), id)
	if ch.Category != "" {
		t.Errorf("Category = %q, want ''", ch.Category)
	}
}

// ─── UpdateChannel ────────────────────────────────────────────────────────────

func TestUpdateChannel_ChangesNameAndTopic(t *testing.T) {
	database := openMigratedMemory(t)

	id, _ := database.CreateChannel(context.Background(), "old", "text", "", "old topic", 0)

	if err := database.UpdateChannel(context.Background(), id, "new", "new topic", 5); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}

	ch, _ := database.GetChannel(context.Background(), id)
	if ch.Name != "new" {
		t.Errorf("Name = %q, want 'new'", ch.Name)
	}
	if ch.Topic != "new topic" {
		t.Errorf("Topic = %q, want 'new topic'", ch.Topic)
	}
	if ch.SlowMode != 5 {
		t.Errorf("SlowMode = %d, want 5", ch.SlowMode)
	}
}

func TestUpdateChannel_NonExistent(t *testing.T) {
	database := openMigratedMemory(t)
	// Should not error even for non-existent row (0 rows affected is still ok).
	err := database.UpdateChannel(context.Background(), 9999, "x", "y", 0)
	if err != nil {
		t.Errorf("UpdateChannel non-existent should not error: %v", err)
	}
}

// ─── DeleteChannel ────────────────────────────────────────────────────────────

func TestDeleteChannel_RemovesChannel(t *testing.T) {
	database := openMigratedMemory(t)

	id, _ := database.CreateChannel(context.Background(), "todelete", "text", "", "", 0)

	if err := database.DeleteChannel(context.Background(), id); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}

	ch, err := database.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatalf("GetChannel after delete: %v", err)
	}
	if ch != nil {
		t.Error("expected nil after deletion")
	}
}

func TestDeleteChannel_NonExistent(t *testing.T) {
	database := openMigratedMemory(t)
	err := database.DeleteChannel(context.Background(), 9999)
	if err != nil {
		t.Errorf("DeleteChannel non-existent should not error: %v", err)
	}
}

// ─── GetChannelPermissions ────────────────────────────────────────────────────

func TestGetChannelPermissions_Default(t *testing.T) {
	database := openMigratedMemory(t)

	chID, _ := database.CreateChannel(context.Background(), "perms", "text", "", "", 0)

	// No override set — should return 0, 0.
	allow, deny, err := database.GetChannelPermissions(context.Background(), chID, 4)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	if allow != 0 || deny != 0 {
		t.Errorf("expected (0, 0), got (%d, %d)", allow, deny)
	}
}

func TestGetChannelPermissions_WithOverride(t *testing.T) {
	database := openMigratedMemory(t)

	chID, _ := database.CreateChannel(context.Background(), "perms2", "text", "", "", 0)
	// Insert an override directly.
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)`,
		chID, 4, int64(0x400), int64(0x200),
	)
	if err != nil {
		t.Fatalf("insert override: %v", err)
	}

	allow, deny, err := database.GetChannelPermissions(context.Background(), chID, 4)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	if allow != 0x400 {
		t.Errorf("allow = %d, want 0x400", allow)
	}
	if deny != 0x200 {
		t.Errorf("deny = %d, want 0x200", deny)
	}
}

// ─── Channel override write path ─────────────────────────────────────────────

func TestUpsertChannelOverride_InsertAndUpdate(t *testing.T) {
	database := openMigratedMemory(t)
	chID, _ := database.CreateChannel(context.Background(), "private", "text", "", "", 0)

	if err := database.UpsertChannelOverride(context.Background(), chID, 4, 0, 0x202); err != nil {
		t.Fatalf("UpsertChannelOverride insert: %v", err)
	}
	allow, deny, err := database.GetChannelPermissions(context.Background(), chID, 4)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	if allow != 0 || deny != 0x202 {
		t.Errorf("after insert: got (%#x, %#x), want (0, 0x202)", allow, deny)
	}

	// Upsert again with different bits — must update, not duplicate.
	if err := database.UpsertChannelOverride(context.Background(), chID, 4, 0x2, 0x200); err != nil {
		t.Fatalf("UpsertChannelOverride update: %v", err)
	}
	allow, deny, err = database.GetChannelPermissions(context.Background(), chID, 4)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	if allow != 0x2 || deny != 0x200 {
		t.Errorf("after update: got (%#x, %#x), want (0x2, 0x200)", allow, deny)
	}
}

func TestDeleteChannelOverride(t *testing.T) {
	database := openMigratedMemory(t)
	chID, _ := database.CreateChannel(context.Background(), "private2", "text", "", "", 0)

	if err := database.UpsertChannelOverride(context.Background(), chID, 4, 0, 0x202); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	if err := database.DeleteChannelOverride(context.Background(), chID, 4); err != nil {
		t.Fatalf("DeleteChannelOverride: %v", err)
	}
	allow, deny, err := database.GetChannelPermissions(context.Background(), chID, 4)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	if allow != 0 || deny != 0 {
		t.Errorf("after delete: got (%#x, %#x), want (0, 0)", allow, deny)
	}

	// Deleting again is a no-op.
	if err := database.DeleteChannelOverride(context.Background(), chID, 4); err != nil {
		t.Errorf("DeleteChannelOverride non-existent should not error: %v", err)
	}
}

func TestListChannelRoleOverrides(t *testing.T) {
	database := openMigratedMemory(t)
	chID, _ := database.CreateChannel(context.Background(), "private3", "text", "", "", 0)

	if err := database.UpsertChannelOverride(context.Background(), chID, 4, 0, 0x202); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	overrides, err := database.ListChannelRoleOverrides(context.Background(), chID)
	if err != nil {
		t.Fatalf("ListChannelRoleOverrides: %v", err)
	}
	// All four seeded roles must be present, position descending (Owner first).
	if len(overrides) != 4 {
		t.Fatalf("expected 4 roles, got %d", len(overrides))
	}
	if overrides[0].RoleID != 1 || overrides[0].RoleName != "Owner" {
		t.Errorf("first role = (%d, %q), want (1, Owner)", overrides[0].RoleID, overrides[0].RoleName)
	}
	for _, o := range overrides {
		switch o.RoleID {
		case 4:
			if o.Deny != 0x202 || o.Allow != 0 {
				t.Errorf("member override = (%#x, %#x), want (0, 0x202)", o.Allow, o.Deny)
			}
		default:
			if o.Allow != 0 || o.Deny != 0 {
				t.Errorf("role %d override = (%#x, %#x), want zeros", o.RoleID, o.Allow, o.Deny)
			}
		}
		if o.Permissions == 0 {
			t.Errorf("role %d permissions should be non-zero", o.RoleID)
		}
	}
}

// ─── SetChannelSlowMode ─────────────────────────────────────────────────────

func TestSetChannelSlowMode(t *testing.T) {
	database := openMigratedMemory(t)
	chID, _ := database.CreateChannel(context.Background(), "slowch", "text", "", "", 0)

	if err := database.SetChannelSlowMode(context.Background(), chID, 10); err != nil {
		t.Fatalf("SetChannelSlowMode: %v", err)
	}

	ch, _ := database.GetChannel(context.Background(), chID)
	if ch.SlowMode != 10 {
		t.Errorf("SlowMode = %d, want 10", ch.SlowMode)
	}
}

func TestSetChannelSlowMode_Zero(t *testing.T) {
	database := openMigratedMemory(t)
	chID, _ := database.CreateChannel(context.Background(), "slowch2", "text", "", "", 0)

	_ = database.SetChannelSlowMode(context.Background(), chID, 30)
	_ = database.SetChannelSlowMode(context.Background(), chID, 0)

	ch, _ := database.GetChannel(context.Background(), chID)
	if ch.SlowMode != 0 {
		t.Errorf("SlowMode = %d, want 0 (disabled)", ch.SlowMode)
	}
}

// ─── SetChannelVoiceMaxUsers ────────────────────────────────────────────────

func TestSetChannelVoiceMaxUsers(t *testing.T) {
	database := openMigratedMemory(t)
	chID, _ := database.CreateChannel(context.Background(), "voicech", "voice", "", "", 0)

	if err := database.SetChannelVoiceMaxUsers(context.Background(), chID, 25); err != nil {
		t.Fatalf("SetChannelVoiceMaxUsers: %v", err)
	}

	ch, _ := database.GetChannel(context.Background(), chID)
	if ch.VoiceMaxUsers != 25 {
		t.Errorf("VoiceMaxUsers = %d, want 25", ch.VoiceMaxUsers)
	}
}

func TestSetChannelVoiceMaxUsers_Unlimited(t *testing.T) {
	database := openMigratedMemory(t)
	chID, _ := database.CreateChannel(context.Background(), "voicech2", "voice", "", "", 0)

	_ = database.SetChannelVoiceMaxUsers(context.Background(), chID, 10)
	_ = database.SetChannelVoiceMaxUsers(context.Background(), chID, 0)

	ch, _ := database.GetChannel(context.Background(), chID)
	if ch.VoiceMaxUsers != 0 {
		t.Errorf("VoiceMaxUsers = %d, want 0 (unlimited)", ch.VoiceMaxUsers)
	}
}
