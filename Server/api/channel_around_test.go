package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/owncord/server/db"
)

// ─── GET /api/v1/channels/{id}/messages/around/{messageId} ───────────────────
//
// The around window is what turns a "jump to this message" affordance (search
// hit, pinned entry, reply reference, permalink) into something that works for
// a message outside the client's loaded history. Its contract has three parts
// worth pinning: the same read gate as history, a window actually centred on
// the target, and honest has-more flags at the edges of a channel.

type aroundResponse struct {
	Messages []struct {
		ID      int64  `json:"id"`
		Content string `json:"content"`
	} `json:"messages"`
	HasMoreBefore bool `json:"has_more_before"`
	HasMoreAfter  bool `json:"has_more_after"`
}

func aroundPath(channelID, messageID int64, query string) string {
	p := fmt.Sprintf("/api/v1/channels/%d/messages/around/%d", channelID, messageID)
	if query != "" {
		p += "?" + query
	}
	return p
}

// seedAroundChannel creates a channel owned by username and fills it with n
// messages, returning the channel id and the message ids in ascending order.
func seedAroundChannel(t *testing.T, database *db.DB, username string, n int) (int64, []int64) {
	t.Helper()
	user, err := database.GetUserByUsername(context.Background(), username)
	if err != nil {
		t.Fatalf("GetUserByUsername(%q): %v", username, err)
	}
	chID, err := database.CreateChannel(context.Background(), "around-"+username, "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	ids := make([]int64, 0, n)
	for i := range n {
		id, msgErr := database.CreateMessage(context.Background(), chID, user.ID, fmt.Sprintf("m%d", i), nil)
		if msgErr != nil {
			t.Fatalf("CreateMessage %d: %v", i, msgErr)
		}
		ids = append(ids, id)
	}
	return chID, ids
}

func decodeAround(t *testing.T, rr *httptest.ResponseRecorder) aroundResponse {
	t.Helper()
	var resp aroundResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode around response: %v (body: %s)", err, rr.Body.String())
	}
	return resp
}

func TestMessagesAround_Unauthenticated(t *testing.T) {
	router := buildChannelRouter(newChannelTestDB(t))
	rr := chGet(t, router, aroundPath(1, 1, ""), "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

func TestMessagesAround_InvalidMessageID(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "aroundbadid", 1)
	chID, _ := seedAroundChannel(t, database, "aroundbadid", 1)

	for _, raw := range []string{"abc", "0", "-3"} {
		path := fmt.Sprintf("/api/v1/channels/%d/messages/around/%s", chID, raw)
		rr := chGet(t, router, path, token)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("message id %q: status = %d, want 400; body: %s", raw, rr.Code, rr.Body.String())
		}
	}
}

func TestMessagesAround_InvalidLimit(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "aroundbadlimit", 1)
	chID, ids := seedAroundChannel(t, database, "aroundbadlimit", 3)

	rr := chGet(t, router, aroundPath(chID, ids[1], "limit=abc"), token)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body: %s", rr.Code, rr.Body.String())
	}
}

func TestMessagesAround_ChannelNotFound(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "aroundnochan", 1)

	rr := chGet(t, router, aroundPath(9999, 1, ""), token)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}

func TestMessagesAround_MessageInAnotherChannel(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "aroundcross", 1)
	_, idsA := seedAroundChannel(t, database, "aroundcross", 2)
	chB, _ := seedAroundChannel(t, database, "aroundcross", 2)

	rr := chGet(t, router, aroundPath(chB, idsA[0], ""), token)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}

func TestMessagesAround_DeletedMessageIsNotFound(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "arounddeleted", 1)
	user, _ := database.GetUserByUsername(context.Background(), "arounddeleted")
	chID, ids := seedAroundChannel(t, database, "arounddeleted", 3)

	if err := database.DeleteMessage(context.Background(), ids[1], user.ID, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	rr := chGet(t, router, aroundPath(chID, ids[1], ""), token)
	if rr.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}

func TestMessagesAround_CentersTheWindow(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "aroundcenter", 1)
	chID, ids := seedAroundChannel(t, database, "aroundcenter", 40)

	target := ids[20]
	rr := chGet(t, router, aroundPath(chID, target, "limit=10"), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	resp := decodeAround(t, rr)

	if len(resp.Messages) != 10 {
		t.Fatalf("window size = %d, want 10", len(resp.Messages))
	}
	// limit 10 → 5 older, the centre, 4 newer.
	if resp.Messages[5].ID != target {
		t.Errorf("centre at index 5 = %d, want %d", resp.Messages[5].ID, target)
	}
	for i := 1; i < len(resp.Messages); i++ {
		if resp.Messages[i-1].ID >= resp.Messages[i].ID {
			t.Fatalf("window is not ascending at index %d: %v then %v",
				i, resp.Messages[i-1].ID, resp.Messages[i].ID)
		}
	}
	if !resp.HasMoreBefore || !resp.HasMoreAfter {
		t.Errorf("has_more_before = %v, has_more_after = %v; want both true mid-channel",
			resp.HasMoreBefore, resp.HasMoreAfter)
	}
}

func TestMessagesAround_NearChannelStart(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "aroundstart", 1)
	chID, ids := seedAroundChannel(t, database, "aroundstart", 30)

	rr := chGet(t, router, aroundPath(chID, ids[0], "limit=10"), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	resp := decodeAround(t, rr)

	if len(resp.Messages) == 0 || resp.Messages[0].ID != ids[0] {
		t.Fatalf("first entry = %v, want the centre %d at the head", resp.Messages, ids[0])
	}
	if resp.HasMoreBefore {
		t.Error("has_more_before = true at the first message of the channel")
	}
	if !resp.HasMoreAfter {
		t.Error("has_more_after = false with 29 newer messages")
	}
	// Only the after half is available, so the window is shorter than limit.
	if len(resp.Messages) != 5 {
		t.Errorf("window size = %d, want 5 (centre + 4 newer)", len(resp.Messages))
	}
}

func TestMessagesAround_NearChannelEnd(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "aroundend", 1)
	chID, ids := seedAroundChannel(t, database, "aroundend", 30)

	last := ids[len(ids)-1]
	rr := chGet(t, router, aroundPath(chID, last, "limit=10"), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	resp := decodeAround(t, rr)

	if resp.HasMoreAfter {
		t.Error("has_more_after = true at the newest message of the channel")
	}
	if !resp.HasMoreBefore {
		t.Error("has_more_before = false with 29 older messages")
	}
	tail := resp.Messages[len(resp.Messages)-1]
	if tail.ID != last {
		t.Errorf("last entry = %d, want the centre %d", tail.ID, last)
	}
	if len(resp.Messages) != 6 {
		t.Errorf("window size = %d, want 6 (5 older + centre)", len(resp.Messages))
	}
}

func TestMessagesAround_ShortChannelReturnsEverything(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "aroundshort", 1)
	chID, ids := seedAroundChannel(t, database, "aroundshort", 3)

	rr := chGet(t, router, aroundPath(chID, ids[1], "limit=50"), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	resp := decodeAround(t, rr)

	if len(resp.Messages) != 3 {
		t.Fatalf("window size = %d, want all 3 messages", len(resp.Messages))
	}
	if resp.HasMoreBefore || resp.HasMoreAfter {
		t.Errorf("has_more_before = %v, has_more_after = %v; want both false",
			resp.HasMoreBefore, resp.HasMoreAfter)
	}
}

func TestMessagesAround_SkipsDeletedNeighbours(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "aroundtomb", 1)
	user, _ := database.GetUserByUsername(context.Background(), "aroundtomb")
	chID, ids := seedAroundChannel(t, database, "aroundtomb", 5)

	// Soft-delete a neighbour: history omits deleted rows, so the window must
	// too — otherwise the client renders a tombstone it never asked for.
	if err := database.DeleteMessage(context.Background(), ids[0], user.ID, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	rr := chGet(t, router, aroundPath(chID, ids[2], "limit=50"), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	resp := decodeAround(t, rr)

	if len(resp.Messages) != 4 {
		t.Fatalf("window size = %d, want 4 (5 minus the deleted one)", len(resp.Messages))
	}
	for _, m := range resp.Messages {
		if m.ID == ids[0] {
			t.Errorf("deleted message %d present in the window", ids[0])
		}
	}
}

func TestMessagesAround_DMNonParticipantIsNotFound(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)

	chTestCreateToken(t, database, "arounddm1", 4)
	chTestCreateToken(t, database, "arounddm2", 4)
	outsiderToken := chTestCreateToken(t, database, "arounddmout", 4)

	user1, _ := database.GetUserByUsername(context.Background(), "arounddm1")
	user2, _ := database.GetUserByUsername(context.Background(), "arounddm2")
	dmCh, _, err := database.GetOrCreateDMChannel(context.Background(), user1.ID, user2.ID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	msgID, _ := database.CreateMessage(context.Background(), dmCh.ID, user1.ID, "private", nil)

	rr := chGet(t, router, aroundPath(dmCh.ID, msgID, ""), outsiderToken)
	if rr.Code != http.StatusNotFound {
		t.Errorf("outsider status = %d, want 404; body: %s", rr.Code, rr.Body.String())
	}
}

func TestMessagesAround_DMParticipantAllowed(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)

	token1 := chTestCreateToken(t, database, "arounddmok1", 4)
	chTestCreateToken(t, database, "arounddmok2", 4)
	user1, _ := database.GetUserByUsername(context.Background(), "arounddmok1")
	user2, _ := database.GetUserByUsername(context.Background(), "arounddmok2")
	dmCh, _, err := database.GetOrCreateDMChannel(context.Background(), user1.ID, user2.ID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	msgID, _ := database.CreateMessage(context.Background(), dmCh.ID, user1.ID, "private", nil)

	rr := chGet(t, router, aroundPath(dmCh.ID, msgID, ""), token1)
	if rr.Code != http.StatusOK {
		t.Fatalf("participant status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	resp := decodeAround(t, rr)
	if len(resp.Messages) != 1 || resp.Messages[0].ID != msgID {
		t.Errorf("window = %v, want just the DM message %d", resp.Messages, msgID)
	}
}

func TestMessagesAround_NoReadPermissionIsForbidden(t *testing.T) {
	database := newPinTestDB(t)
	router := buildChannelRouter(database)

	// Role 4 (Member) with READ_MESSAGES denied on this channel by override.
	ownerToken := chTestCreateToken(t, database, "aroundowner", 1)
	deniedToken := chTestCreateToken(t, database, "arounddenied", 4)
	chID, ids := seedAroundChannel(t, database, "aroundowner", 3)

	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 2147483647)`,
		chID,
	); err != nil {
		t.Fatalf("insert override: %v", err)
	}

	rr := chGet(t, router, aroundPath(chID, ids[1], ""), deniedToken)
	if rr.Code != http.StatusForbidden {
		t.Errorf("denied member status = %d, want 403; body: %s", rr.Code, rr.Body.String())
	}
	// The owner still gets the window — the override, not the endpoint, is the gate.
	rr = chGet(t, router, aroundPath(chID, ids[1], ""), ownerToken)
	if rr.Code != http.StatusOK {
		t.Errorf("owner status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

func TestMessagesAround_EnrichesReactionsAndMentions(t *testing.T) {
	database := newChannelTestDB(t)
	router := buildChannelRouter(database)
	token := chTestCreateToken(t, database, "aroundrich", 1)
	user, _ := database.GetUserByUsername(context.Background(), "aroundrich")
	chID, ids := seedAroundChannel(t, database, "aroundrich", 3)

	if err := database.AddReaction(context.Background(), ids[1], user.ID, "👍"); err != nil {
		t.Fatalf("AddReaction: %v", err)
	}

	rr := chGet(t, router, aroundPath(chID, ids[1], ""), token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var raw struct {
		Messages []struct {
			ID        int64 `json:"id"`
			Reactions []struct {
				Emoji string `json:"emoji"`
				Count int    `json:"count"`
				Me    bool   `json:"me"`
			} `json:"reactions"`
			Attachments []any   `json:"attachments"`
			Mentions    []int64 `json:"mentions"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, m := range raw.Messages {
		if m.Attachments == nil || m.Mentions == nil {
			t.Errorf("message %d has null attachments/mentions; the enrichment path was skipped", m.ID)
		}
		if m.ID != ids[1] {
			continue
		}
		if len(m.Reactions) != 1 || m.Reactions[0].Emoji != "👍" || !m.Reactions[0].Me {
			t.Errorf("centre reactions = %v, want one 👍 with me=true", m.Reactions)
		}
	}
}
