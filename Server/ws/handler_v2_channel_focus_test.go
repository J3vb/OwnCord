package ws

import (
	"context"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// newFocusTestDeps creates an in-memory DB with a user (role=Owner, id=1) and
// a text channel, returning deps and the IDs needed for assertions.
func newFocusTestDeps(t *testing.T) (PresenceDeps, int64, int64) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	userID, err := database.CreateUser("focuser", "hash", 1) // Owner role
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel("focus-chan", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	perms := permissions.NewChecker(database)
	deps := PresenceDeps{DB: database, Limiter: nil, Permissions: perms}
	return deps, userID, chID
}

func TestChannelFocusV2_HappyPath_SetsChannelID(t *testing.T) {
	deps, userID, chID := newFocusTestDeps(t)
	cmd := ChannelFocusCmd{userID: userID, channelID: chID}
	info := ClientInfo{UserID: userID, Username: "focuser"}

	result := handleChannelFocusV2(context.Background(), cmd, info, deps)

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	if result.SetChannelID == nil {
		t.Fatal("expected SetChannelID to be set")
	}
	if *result.SetChannelID != chID {
		t.Errorf("SetChannelID = %d, want %d", *result.SetChannelID, chID)
	}
}

func TestChannelFocusV2_InvalidChannelID_SilentDrop(t *testing.T) {
	deps, userID, _ := newFocusTestDeps(t)
	cmd := ChannelFocusCmd{userID: userID, channelID: 0}
	info := ClientInfo{UserID: userID}

	result := handleChannelFocusV2(context.Background(), cmd, info, deps)

	// channelID <= 0 → silently dropped (no error, no SetChannelID).
	if result.Error != nil {
		t.Errorf("expected nil error for invalid channel_id, got %v", result.Error)
	}
	if result.SetChannelID != nil {
		t.Errorf("expected nil SetChannelID for invalid channel_id, got %d", *result.SetChannelID)
	}
}

func TestChannelFocusV2_ChannelNotFound_SilentDrop(t *testing.T) {
	deps, userID, _ := newFocusTestDeps(t)
	cmd := ChannelFocusCmd{userID: userID, channelID: 99999}
	info := ClientInfo{UserID: userID}

	result := handleChannelFocusV2(context.Background(), cmd, info, deps)

	if result.Error != nil {
		t.Errorf("expected nil error for missing channel, got %v", result.Error)
	}
	if result.SetChannelID != nil {
		t.Errorf("expected nil SetChannelID for missing channel, got %d", *result.SetChannelID)
	}
}

func TestChannelFocusV2_NoPermission_ReturnsForbidden(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	// Use Member role (id=4) and create a channel with a deny override.
	userID, _ := database.CreateUser("noperm", "hash", 4)
	chID, _ := database.CreateChannel("restricted", "text", "", "", 0)

	// Deny READ_MESSAGES for Member role on this channel via raw SQL.
	_, err = database.Exec(
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, ?)`,
		chID, permissions.ReadMessages,
	)
	if err != nil {
		t.Fatalf("INSERT channel_overrides: %v", err)
	}

	perms := permissions.NewChecker(database)
	deps := PresenceDeps{DB: database, Limiter: nil, Permissions: perms}

	cmd := ChannelFocusCmd{userID: userID, channelID: chID}
	info := ClientInfo{UserID: userID, Username: "noperm"}

	result := handleChannelFocusV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected FORBIDDEN error for denied permission")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeForbidden {
		t.Errorf("expected code %q, got %q", ErrCodeForbidden, ce.Code)
	}
}

func TestChannelFocusV2_NoEvents(t *testing.T) {
	deps, userID, chID := newFocusTestDeps(t)
	cmd := ChannelFocusCmd{userID: userID, channelID: chID}
	info := ClientInfo{UserID: userID, Username: "focuser"}

	result := handleChannelFocusV2(context.Background(), cmd, info, deps)

	if len(result.Events) != 0 {
		t.Errorf("expected no events, got %d", len(result.Events))
	}
}
