package api_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ─── Authorization tests for channel read access (REST) ─────────────────────
// These tests verify that permission checks (READ_MESSAGES) are enforced on
// GET /api/v1/channels, GET /api/v1/channels/{id}/messages, and GET /api/v1/search.

// denyReadMessages inserts a channel_override that denies READ_MESSAGES for the
// given role on the given channel.
func denyReadMessages(t *testing.T, database *db.DB, channelID, roleID int64) {
	t.Helper()
	_, err := database.ExecContext(context.Background(),
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

	chVisible := mustCreateChannel(t, database, "visible", "text")
	chHidden, _ := database.CreateChannel(context.Background(), "hidden", "text", "", "", 1)
	_ = chVisible // used implicitly in response

	// Deny READ_MESSAGES on the hidden channel for the Member role.
	denyReadMessages(t, database, chHidden, permissions.MemberRoleID)

	rr := chGet(t, router, "/api/v1/channels", token)
	requireStatus(t, rr, http.StatusOK)

	channels := decodeBody[[]map[string]any](t, rr)
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

	chA := mustCreateChannel(t, database, "a", "text")
	chB, _ := database.CreateChannel(context.Background(), "b", "text", "", "", 1)

	// Deny READ_MESSAGES on both channels for all roles.
	denyReadMessages(t, database, chA, permissions.MemberRoleID)
	denyReadMessages(t, database, chB, permissions.MemberRoleID)

	rr := chGet(t, router, "/api/v1/channels", token)
	requireStatus(t, rr, http.StatusOK)

	channels := decodeBody[[]any](t, rr)
	if len(channels) != 2 {
		t.Errorf("admin should see all 2 channels, got %d", len(channels))
	}
}

// ─── GET /api/v1/channels/{id}/messages: permission check ───────────────────

func TestChannelMessages_DeniedByPermission(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	token := chTestCreateToken(t, database, "authz-member2", 4)
	chID := mustCreateChannel(t, database, "restricted", "text")

	// Deny READ_MESSAGES for Member role on this channel.
	denyReadMessages(t, database, chID, permissions.MemberRoleID)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", chID), token)
	expectStatus(t, rr, http.StatusForbidden)
}

func TestChannelMessages_AdminBypassesDeny(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	token := chTestCreateToken(t, database, "authz-owner2", 1)
	chID := mustCreateChannel(t, database, "restricted", "text")

	// Deny READ_MESSAGES for Member role — should not affect Owner.
	denyReadMessages(t, database, chID, permissions.MemberRoleID)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", chID), token)
	expectStatus(t, rr, http.StatusOK)
}

// ─── GET /api/v1/search: permission filtering ───────────────────────────────

func TestSearch_FiltersResultsByPermission(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	// Create an owner to insert messages (owner can write anywhere).
	_ = chTestCreateToken(t, database, "authz-owner3", 1)
	owner, _ := database.GetUserByUsername(context.Background(), "authz-owner3")

	// Member user for search.
	memberToken := chTestCreateToken(t, database, "authz-member3", 4)

	chVisible := mustCreateChannel(t, database, "pub", "text")
	chHidden, _ := database.CreateChannel(context.Background(), "priv", "text", "", "", 1)

	// Insert messages in both channels with a common keyword.
	_ = mustCreateMessage(t, database, chVisible, owner.ID, "searchable keyword public")
	_ = mustCreateMessage(t, database, chHidden, owner.ID, "searchable keyword private")

	// Deny READ_MESSAGES on the hidden channel for members.
	denyReadMessages(t, database, chHidden, permissions.MemberRoleID)

	rr := chGet(t, router, "/api/v1/search?q=searchable", memberToken)
	requireStatus(t, rr, http.StatusOK)

	resp := decodeBody[map[string]any](t, rr)
	results, ok := resp["results"].([]any)
	if !ok {
		t.Fatalf("results is not an array: %v", resp)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 search result (public only), got %d", len(results))
	}
}

// DP-20: paging newest first walks the same readable set as a plain search —
// the caller's DMs stay in (OC-0087), a channel they cannot read and a
// labelled one they have not acknowledged stay out (B9-7), on every page.
func TestSearch_RecentPagingKeepsReadableScope(t *testing.T) {
	ctx := context.Background()
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	_ = chTestCreateToken(t, database, "authz-owner-pg", 1)
	owner, _ := database.GetUserByUsername(ctx, "authz-owner-pg")
	memberToken := chTestCreateToken(t, database, "authz-member-pg", 4)
	member, _ := database.GetUserByUsername(ctx, "authz-member-pg")

	chVisible, _ := database.CreateChannel(ctx, "pub", "text", "", "", 0)
	chHidden, _ := database.CreateChannel(ctx, "priv", "text", "", "", 1)
	chLabelled, _ := database.CreateChannel(ctx, "labelled", "text", "", "", 2)
	if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, chLabelled); err != nil {
		t.Fatalf("label channel: %v", err)
	}
	denyReadMessages(t, database, chHidden, permissions.MemberRoleID)
	dm, _, err := database.GetOrCreateDMChannel(ctx, member.ID, owner.ID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	var want []int64
	for _, ch := range []int64{chVisible, chHidden, dm.ID, chLabelled, chVisible} {
		id, err := database.CreateMessage(ctx, ch, owner.ID, "scopedword hit", nil)
		if err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		if ch == chVisible || ch == dm.ID {
			want = append([]int64{id}, want...)
		}
	}

	var got []int64
	path := "/api/v1/search?q=scopedword&sort=recent&limit=1"
	for range 10 {
		rr := chGet(t, router, path, memberToken)
		requireStatus(t, rr, http.StatusOK)
		resp := decodeBody[struct {
			Results []struct {
				MessageID int64 `json:"message_id"`
			} `json:"results"`
			NextBefore *int64 `json:"next_before"`
		}](t, rr)
		for _, r := range resp.Results {
			got = append(got, r.MessageID)
		}
		if resp.NextBefore == nil {
			break
		}
		path = fmt.Sprintf("/api/v1/search?q=scopedword&sort=recent&limit=1&before=%d", *resp.NextBefore)
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("paged hits = %v, want %v (visible and DM only, newest first)", got, want)
	}
}

func TestSearch_AdminSeesAllResults(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)

	token := chTestCreateToken(t, database, "authz-owner4", 1)
	owner, _ := database.GetUserByUsername(context.Background(), "authz-owner4")

	chA := mustCreateChannel(t, database, "a", "text")
	chB, _ := database.CreateChannel(context.Background(), "b", "text", "", "", 1)

	_ = mustCreateMessage(t, database, chA, owner.ID, "findme alpha")
	_ = mustCreateMessage(t, database, chB, owner.ID, "findme beta")

	// Deny READ_MESSAGES on both for member role — admin bypasses.
	denyReadMessages(t, database, chA, permissions.MemberRoleID)
	denyReadMessages(t, database, chB, permissions.MemberRoleID)

	rr := chGet(t, router, "/api/v1/search?q=findme", token)
	requireStatus(t, rr, http.StatusOK)

	resp := decodeBody[map[string]any](t, rr)
	results := resp["results"].([]any)
	if len(results) != 2 {
		t.Errorf("admin should see all 2 results, got %d", len(results))
	}
}

// ─── DM exclusion from channel list (BUG-093) ─────────────────────────────

func TestChannelList_ExcludesDMChannels_Member(t *testing.T) {
	database := newChannelTestDB(t)
	router, token := newChannelRouterAs(t, database, "dm-excl-member", 4)

	// Create a normal text channel and a DM channel.
	database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	database.ExecContext(context.Background(), `INSERT INTO channels (name, type, position) VALUES ('dm-1', 'dm', 0)`)

	rr := chGet(t, router, "/api/v1/channels", token)
	requireStatus(t, rr, http.StatusOK)

	channels := decodeBody[[]map[string]any](t, rr)
	for _, ch := range channels {
		if ch["type"] == "dm" {
			t.Errorf("DM channel should not appear in channel list, got: %v", ch["name"])
		}
	}
	if len(channels) != 1 {
		t.Errorf("expected 1 channel (text only), got %d", len(channels))
	}
}

func TestChannelList_ExcludesDMChannels_Admin(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "dm-excl-admin", 1) // Owner

	database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	database.CreateChannel(context.Background(), "voice", "voice", "", "", 1)
	database.ExecContext(context.Background(), `INSERT INTO channels (name, type, position) VALUES ('dm-1', 'dm', 0)`)

	rr := chGet(t, router, "/api/v1/channels", token)
	requireStatus(t, rr, http.StatusOK)

	channels := decodeBody[[]map[string]any](t, rr)
	for _, ch := range channels {
		if ch["type"] == "dm" {
			t.Errorf("DM channel should not appear even for admin, got: %v", ch["name"])
		}
	}
	if len(channels) != 2 {
		t.Errorf("expected 2 channels (text+voice), got %d", len(channels))
	}
}
