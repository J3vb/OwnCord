package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// ─── Authorization tests for channel read access (REST) ─────────────────────
// These tests verify that permission checks (READ_MESSAGES) are enforced on
// GET /api/v1/channels, GET /api/v1/channels/{id}/messages, and GET /api/v1/search.

// denyReadMessages inserts a channel_override that denies READ_MESSAGES for the
// given role on the given channel.
func denyReadMessages(t *testing.T, database *db.DB, channelID, roleID int64) {
	t.Helper()
	_, err := database.Exec(
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, 0, ?)`,
		channelID, roleID, permissions.ReadMessages,
	)
	if err != nil {
		t.Fatalf("denyReadMessages: %v", err)
	}
}

// ─── GET /api/v1/channels: permission filtering ─────────────────────────────

func TestChannelList_FiltersOutDeniedChannels(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	// Create member user (roleID=4, has READ_MESSAGES by default).
	token := chTestCreateToken(t, database, "authz-member1", 4)

	chVisible, _ := database.CreateChannel("visible", "text", "", "", 0)
	chHidden, _ := database.CreateChannel("hidden", "text", "", "", 1)
	_ = chVisible // used implicitly in response

	// Deny READ_MESSAGES on the hidden channel for the Member role.
	denyReadMessages(t, database, chHidden, permissions.MemberRoleID)

	rr := chGet(t, router, "/api/v1/channels", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var channels []map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&channels); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(channels) != 1 {
		t.Errorf("expected 1 visible channel, got %d", len(channels))
	}
	if len(channels) > 0 {
		name, _ := channels[0]["name"].(string)
		if name != "visible" {
			t.Errorf("visible channel name = %q, want %q", name, "visible")
		}
	}
}

func TestChannelList_AdminSeesAllChannels(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	// Owner (roleID=1) has Administrator bit — bypasses all checks.
	token := chTestCreateToken(t, database, "authz-owner1", 1)

	chA, _ := database.CreateChannel("a", "text", "", "", 0)
	chB, _ := database.CreateChannel("b", "text", "", "", 1)

	// Deny READ_MESSAGES on both channels for all roles.
	denyReadMessages(t, database, chA, permissions.MemberRoleID)
	denyReadMessages(t, database, chB, permissions.MemberRoleID)

	rr := chGet(t, router, "/api/v1/channels", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}

	var channels []any
	_ = json.NewDecoder(rr.Body).Decode(&channels)
	if len(channels) != 2 {
		t.Errorf("admin should see all 2 channels, got %d", len(channels))
	}
}

// ─── GET /api/v1/channels/{id}/messages: permission check ───────────────────

func TestChannelMessages_DeniedByPermission(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	token := chTestCreateToken(t, database, "authz-member2", 4)
	chID, _ := database.CreateChannel("restricted", "text", "", "", 0)

	// Deny READ_MESSAGES for Member role on this channel.
	denyReadMessages(t, database, chID, permissions.MemberRoleID)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", chID), token)
	if rr.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body: %s", rr.Code, rr.Body.String())
	}
}

func TestChannelMessages_AdminBypassesDeny(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	token := chTestCreateToken(t, database, "authz-owner2", 1)
	chID, _ := database.CreateChannel("restricted", "text", "", "", 0)

	// Deny READ_MESSAGES for Member role — should not affect Owner.
	denyReadMessages(t, database, chID, permissions.MemberRoleID)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", chID), token)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; admin should bypass deny", rr.Code)
	}
}

// ─── GET /api/v1/search: permission filtering ───────────────────────────────

func TestSearch_FiltersResultsByPermission(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	// Create an owner to insert messages (owner can write anywhere).
	_ = chTestCreateToken(t, database, "authz-owner3", 1)
	owner, _ := database.GetUserByUsername("authz-owner3")

	// Member user for search.
	memberToken := chTestCreateToken(t, database, "authz-member3", 4)

	chVisible, _ := database.CreateChannel("pub", "text", "", "", 0)
	chHidden, _ := database.CreateChannel("priv", "text", "", "", 1)

	// Insert messages in both channels with a common keyword.
	_, _ = database.CreateMessage(chVisible, owner.ID, "searchable keyword public", nil)
	_, _ = database.CreateMessage(chHidden, owner.ID, "searchable keyword private", nil)

	// Deny READ_MESSAGES on the hidden channel for members.
	denyReadMessages(t, database, chHidden, permissions.MemberRoleID)

	rr := chGet(t, router, "/api/v1/search?q=searchable", memberToken)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	results, ok := resp["results"].([]any)
	if !ok {
		t.Fatalf("results is not an array: %v", resp)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 search result (public only), got %d", len(results))
	}
}

func TestSearch_AdminSeesAllResults(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	token := chTestCreateToken(t, database, "authz-owner4", 1)
	owner, _ := database.GetUserByUsername("authz-owner4")

	chA, _ := database.CreateChannel("a", "text", "", "", 0)
	chB, _ := database.CreateChannel("b", "text", "", "", 1)

	_, _ = database.CreateMessage(chA, owner.ID, "findme alpha", nil)
	_, _ = database.CreateMessage(chB, owner.ID, "findme beta", nil)

	// Deny READ_MESSAGES on both for member role — admin bypasses.
	denyReadMessages(t, database, chA, permissions.MemberRoleID)
	denyReadMessages(t, database, chB, permissions.MemberRoleID)

	rr := chGet(t, router, "/api/v1/search?q=findme", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	results := resp["results"].([]any)
	if len(results) != 2 {
		t.Errorf("admin should see all 2 results, got %d", len(results))
	}
}
