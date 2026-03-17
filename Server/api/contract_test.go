package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

// ─── Contract tests: verify REST responses match API.md shapes ──────────────
// These tests assert that responses include all documented fields with the
// correct types, catching drift between implementation and specification.

// ─── GET /api/v1/channels/{id}/messages: response shape ─────────────────────

func TestContract_Messages_HasRequiredFields(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "contract-msg1", 1)
	user, _ := database.GetUserByUsername("contract-msg1")
	chID, _ := database.CreateChannel("contract-ch", "text", "", "", 0)
	_, _ = database.CreateMessage(chID, user.ID, "contract test message", nil)

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", chID), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Messages []json.RawMessage `json:"messages"`
		HasMore  *bool             `json:"has_more"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.HasMore == nil {
		t.Error("response missing 'has_more' field")
	}
	if len(resp.Messages) == 0 {
		t.Fatal("expected at least 1 message")
	}

	// Parse the first message and verify all API.md fields are present.
	var msg map[string]any
	if err := json.Unmarshal(resp.Messages[0], &msg); err != nil {
		t.Fatalf("decode message: %v", err)
	}

	requiredFields := []string{
		"id", "channel_id", "user", "content", "reply_to",
		"attachments", "reactions", "pinned", "edited_at",
		"deleted", "timestamp",
	}
	for _, field := range requiredFields {
		if _, ok := msg[field]; !ok {
			t.Errorf("message missing required field %q (per API.md)", field)
		}
	}

	// Verify 'user' is an object with id, username.
	userObj, ok := msg["user"].(map[string]any)
	if !ok {
		t.Fatal("'user' is not an object")
	}
	for _, f := range []string{"id", "username"} {
		if _, ok := userObj[f]; !ok {
			t.Errorf("user object missing field %q", f)
		}
	}

	// Verify 'attachments' is an array (even if empty).
	if _, ok := msg["attachments"].([]any); !ok {
		t.Error("'attachments' is not an array")
	}

	// Verify 'reactions' is an array (even if empty).
	if _, ok := msg["reactions"].([]any); !ok {
		t.Error("'reactions' is not an array")
	}
}

// TestContract_Messages_ReactionsHaveMeFlag verifies that when a reaction
// exists, the response includes the 'me' boolean per API.md.
func TestContract_Messages_ReactionsHaveMeFlag(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "contract-react1", 1)
	user, _ := database.GetUserByUsername("contract-react1")
	chID, _ := database.CreateChannel("react-ch", "text", "", "", 0)
	msgID, _ := database.CreateMessage(chID, user.ID, "reaction target", nil)
	_ = database.AddReaction(msgID, user.ID, "👍")

	rr := chGet(t, router, fmt.Sprintf("/api/v1/channels/%d/messages", chID), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}

	var resp struct {
		Messages []struct {
			Reactions []struct {
				Emoji string `json:"emoji"`
				Count int    `json:"count"`
				Me    *bool  `json:"me"`
			} `json:"reactions"`
		} `json:"messages"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Messages) == 0 {
		t.Fatal("expected at least 1 message")
	}
	if len(resp.Messages[0].Reactions) == 0 {
		t.Fatal("expected at least 1 reaction")
	}
	r := resp.Messages[0].Reactions[0]
	if r.Emoji != "👍" {
		t.Errorf("emoji = %q, want 👍", r.Emoji)
	}
	if r.Count != 1 {
		t.Errorf("count = %d, want 1", r.Count)
	}
	if r.Me == nil {
		t.Error("reaction missing 'me' boolean field (per API.md)")
	} else if !*r.Me {
		t.Error("me = false, want true (requesting user added the reaction)")
	}
}

// ─── GET /api/v1/search: response shape ─────────────────────────────────────

func TestContract_Search_HasRequiredFields(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "contract-search1", 1)
	user, _ := database.GetUserByUsername("contract-search1")
	chID, _ := database.CreateChannel("search-ch", "text", "", "", 0)
	_, _ = database.CreateMessage(chID, user.ID, "contractsearchterm in body", nil)

	rr := chGet(t, router, "/api/v1/search?q=contractsearchterm", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Results []json.RawMessage `json:"results"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Results) == 0 {
		t.Fatal("expected at least 1 search result")
	}

	var result map[string]any
	if err := json.Unmarshal(resp.Results[0], &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}

	// Per API.md, search results must have these fields.
	requiredFields := []string{
		"message_id", "channel_id", "channel_name", "user",
		"content", "timestamp",
	}
	for _, field := range requiredFields {
		if _, ok := result[field]; !ok {
			t.Errorf("search result missing required field %q (per API.md)", field)
		}
	}

	// Verify 'user' is an object with id and username.
	userObj, ok := result["user"].(map[string]any)
	if !ok {
		t.Fatal("search result 'user' is not an object")
	}
	for _, f := range []string{"id", "username"} {
		if _, ok := userObj[f]; !ok {
			t.Errorf("search result user object missing field %q", f)
		}
	}
}
