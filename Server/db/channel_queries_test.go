package db_test

import (
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

	channels, err := database.ListChannels()
	if err != nil {
		t.Fatalf("ListChannels() error: %v", err)
	}
	if len(channels) != 0 {
		t.Errorf("expected 0 channels, got %d", len(channels))
	}
}

func TestListChannels_ReturnsAll(t *testing.T) {
	database := openMigratedMemory(t)

	if _, err := database.CreateChannel("general", "text", "", "General chat", 0); err != nil {
		t.Fatalf("CreateChannel general: %v", err)
	}
	if _, err := database.CreateChannel("announcements", "text", "", "", 1); err != nil {
		t.Fatalf("CreateChannel announcements: %v", err)
	}

	channels, err := database.ListChannels()
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

	ch, err := database.GetChannel(9999)
	if err != nil {
		t.Fatalf("GetChannel() error: %v", err)
	}
	if ch != nil {
		t.Error("expected nil for non-existent channel")
	}
}

func TestGetChannel_Found(t *testing.T) {
	database := openMigratedMemory(t)

	id, err := database.CreateChannel("general", "text", "Public", "hello", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	ch, err := database.GetChannel(id)
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

	id, err := database.CreateChannel("test", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if id <= 0 {
		t.Errorf("expected positive ID, got %d", id)
	}
}

func TestCreateChannel_UniqueIDs(t *testing.T) {
	database := openMigratedMemory(t)

	id1, _ := database.CreateChannel("ch1", "text", "", "", 0)
	id2, _ := database.CreateChannel("ch2", "text", "", "", 1)
	if id1 == id2 {
		t.Error("expected different IDs for different channels")
	}
}

func TestCreateChannel_EmptyCategory(t *testing.T) {
	database := openMigratedMemory(t)

	id, err := database.CreateChannel("nocategory", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel with empty category: %v", err)
	}
	ch, _ := database.GetChannel(id)
	if ch.Category != "" {
		t.Errorf("Category = %q, want ''", ch.Category)
	}
}

// ─── UpdateChannel ────────────────────────────────────────────────────────────

func TestUpdateChannel_ChangesNameAndTopic(t *testing.T) {
	database := openMigratedMemory(t)

	id, _ := database.CreateChannel("old", "text", "", "old topic", 0)

	if err := database.UpdateChannel(id, "new", "new topic", 5); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}

	ch, _ := database.GetChannel(id)
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
	err := database.UpdateChannel(9999, "x", "y", 0)
	if err != nil {
		t.Errorf("UpdateChannel non-existent should not error: %v", err)
	}
}

// ─── DeleteChannel ────────────────────────────────────────────────────────────

func TestDeleteChannel_RemovesChannel(t *testing.T) {
	database := openMigratedMemory(t)

	id, _ := database.CreateChannel("todelete", "text", "", "", 0)

	if err := database.DeleteChannel(id); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}

	ch, err := database.GetChannel(id)
	if err != nil {
		t.Fatalf("GetChannel after delete: %v", err)
	}
	if ch != nil {
		t.Error("expected nil after deletion")
	}
}

func TestDeleteChannel_NonExistent(t *testing.T) {
	database := openMigratedMemory(t)
	err := database.DeleteChannel(9999)
	if err != nil {
		t.Errorf("DeleteChannel non-existent should not error: %v", err)
	}
}

// ─── GetChannelPermissions ────────────────────────────────────────────────────

func TestGetChannelPermissions_Default(t *testing.T) {
	database := openMigratedMemory(t)

	chID, _ := database.CreateChannel("perms", "text", "", "", 0)

	// No override set — should return 0, 0.
	allow, deny, err := database.GetChannelPermissions(chID, 4)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	if allow != 0 || deny != 0 {
		t.Errorf("expected (0, 0), got (%d, %d)", allow, deny)
	}
}

func TestGetChannelPermissions_WithOverride(t *testing.T) {
	database := openMigratedMemory(t)

	chID, _ := database.CreateChannel("perms2", "text", "", "", 0)
	// Insert an override directly.
	_, err := database.Exec(
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)`,
		chID, 4, int64(0x400), int64(0x200),
	)
	if err != nil {
		t.Fatalf("insert override: %v", err)
	}

	allow, deny, err := database.GetChannelPermissions(chID, 4)
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
