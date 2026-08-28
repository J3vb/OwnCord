package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// ─── helpers ────────────────────────────────────────────────────────────────

func dmPatch(t *testing.T, router http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPatch, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// decodeDMInfo decodes a db.DMChannelInfo response body.
func decodeDMInfo(t *testing.T, rr *httptest.ResponseRecorder) db.DMChannelInfo {
	t.Helper()
	var info db.DMChannelInfo
	if err := json.Unmarshal(rr.Body.Bytes(), &info); err != nil {
		t.Fatalf("decode DMChannelInfo: %v (body=%s)", err, rr.Body.String())
	}
	return info
}

// groupFixture stands up three users and returns their tokens.
func groupFixture(t *testing.T) (*db.DB, http.Handler, *mockBroadcaster, []string) {
	t.Helper()
	database := newDMTestDB(t)
	bc := &mockBroadcaster{}
	router := buildDMRouter(database, bc)
	tokens := []string{
		dmCreateToken(t, database, "alice", 4),
		dmCreateToken(t, database, "bob", 4),
		dmCreateToken(t, database, "carol", 4),
	}
	return database, router, bc, tokens
}

// ─── creation ───────────────────────────────────────────────────────────────

func TestCreateGroupDM_CreatesChannelWithAllParticipants(t *testing.T) {
	_, router, bc, tokens := groupFixture(t)

	rr := dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
		"name":          "Lunch crew",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rr.Code, rr.Body.String())
	}

	info := decodeDMInfo(t, rr)
	if !info.IsGroup {
		t.Error("expected is_group=true")
	}
	if info.Name != "Lunch crew" {
		t.Errorf("expected name %q, got %q", "Lunch crew", info.Name)
	}
	if len(info.Recipients) != 2 {
		t.Fatalf("expected 2 recipients (creator excluded), got %d", len(info.Recipients))
	}
	// Backward compat: a pre-group client reads `recipient` and must find one.
	if info.Recipient.ID == 0 {
		t.Error("expected a populated backward-compat recipient field")
	}
	for _, r := range info.Recipients {
		if r.ID == 1 {
			t.Error("creator must not appear in their own recipients list")
		}
	}

	// Every participant, creator included, is told about the new DM.
	got := map[int64]bool{}
	for _, m := range bc.sent {
		got[m.UserID] = true
	}
	for _, want := range []int64{1, 2, 3} {
		if !got[want] {
			t.Errorf("expected dm_channel_open broadcast to user %d", want)
		}
	}
}

func TestCreateGroupDM_RequiresTwoOtherUsers(t *testing.T) {
	_, router, _, tokens := groupFixture(t)

	rr := dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2},
	})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a one-recipient group, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestCreateGroupDM_DeduplicatesAndDropsSelf(t *testing.T) {
	_, router, _, tokens := groupFixture(t)

	// Naming the creator and repeating bob leaves only bob + carol.
	rr := dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{1, 2, 2, 3},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rr.Code, rr.Body.String())
	}
	info := decodeDMInfo(t, rr)
	if len(info.Recipients) != 2 {
		t.Fatalf("expected 2 unique recipients, got %d", len(info.Recipients))
	}
}

func TestCreateGroupDM_RejectsOverCap(t *testing.T) {
	database, router, _, tokens := groupFixture(t)
	ids := make([]int64, 0, 2+db.MaxGroupDMParticipants)
	ids = append(ids, 2, 3)
	for i := range db.MaxGroupDMParticipants {
		name := fmt.Sprintf("extra%d", i)
		if _, err := database.CreateUser(context.Background(), name, "$2a$12$fake", 4); err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		ids = append(ids, int64(4+i))
	}

	rr := dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{"recipient_ids": ids})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 over the participant cap, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestCreateGroupDM_RejectsUnknownRecipient(t *testing.T) {
	_, router, _, tokens := groupFixture(t)

	rr := dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 9999},
	})
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for an unknown recipient, got %d: %s", rr.Code, rr.Body.String())
	}
}

// ─── blocks ─────────────────────────────────────────────────────────────────

func TestCreateGroupDM_BlockerCannotAddBlocked(t *testing.T) {
	database, router, _, tokens := groupFixture(t)
	if err := database.BlockUser(context.Background(), 1, 3); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	rr := dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	})
	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 when adding a user the creator blocked, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestCreateGroupDM_BlockedCannotAddBlocker(t *testing.T) {
	database, router, _, tokens := groupFixture(t)
	// carol blocks alice; alice must not be able to pull carol in either.
	if err := database.BlockUser(context.Background(), 3, 1); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	rr := dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	})
	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 when the target blocked the creator, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestCreateGroupDM_RejectsMutuallyBlockedRecipients(t *testing.T) {
	database, router, _, tokens := groupFixture(t)
	// carol blocks bob; neither blocked alice, so alice (an uninvolved third
	// party) must not be able to force them into a shared group DM.
	if err := database.BlockUser(context.Background(), 3, 2); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	rr := dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	})
	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 when two recipients have blocked each other, got %d: %s", rr.Code, rr.Body.String())
	}
}

// ─── listing ────────────────────────────────────────────────────────────────

func TestListDMs_ReturnsGroupWithParticipants(t *testing.T) {
	_, router, _, tokens := groupFixture(t)

	if rr := dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
		"name":          "Trio",
	}); rr.Code != http.StatusCreated {
		t.Fatalf("create group: %d %s", rr.Code, rr.Body.String())
	}

	rr := dmGet(t, router, "/api/v1/dms", tokens[1])
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	var resp struct {
		DMChannels []db.DMChannelInfo `json:"dm_channels"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.DMChannels) != 1 {
		t.Fatalf("expected 1 DM for bob, got %d", len(resp.DMChannels))
	}
	dm := resp.DMChannels[0]
	if !dm.IsGroup || dm.Name != "Trio" {
		t.Errorf("expected group named Trio, got is_group=%v name=%q", dm.IsGroup, dm.Name)
	}
	if len(dm.Recipients) != 2 {
		t.Fatalf("expected bob to see 2 others, got %d", len(dm.Recipients))
	}
	for _, r := range dm.Recipients {
		if r.ID == 2 {
			t.Error("bob must not be in his own recipients list")
		}
	}
}

// A 1:1 DM must keep listing exactly one recipient and is_group=false, so an
// older client's `recipient`-only rendering is unaffected by group support.
func TestListDMs_OneToOneStaysUngrouped(t *testing.T) {
	_, router, _, tokens := groupFixture(t)

	if rr := dmPost(t, router, "/api/v1/dms", tokens[0], map[string]any{"recipient_id": 2}); rr.Code != http.StatusCreated {
		t.Fatalf("create dm: %d %s", rr.Code, rr.Body.String())
	}

	rr := dmGet(t, router, "/api/v1/dms", tokens[0])
	var resp struct {
		DMChannels []db.DMChannelInfo `json:"dm_channels"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.DMChannels) != 1 {
		t.Fatalf("expected 1 DM, got %d", len(resp.DMChannels))
	}
	dm := resp.DMChannels[0]
	if dm.IsGroup {
		t.Error("a two-person DM must not report is_group")
	}
	if len(dm.Recipients) != 1 || dm.Recipients[0].ID != 2 || dm.Recipient.ID != 2 {
		t.Errorf("expected recipient=bob in both fields, got %+v / %+v", dm.Recipient, dm.Recipients)
	}
}

// A group DM containing both users must never be handed back as "the DM
// between alice and bob" — that would deliver a private message to the group.
func TestCreateDM_DoesNotReuseGroupChannel(t *testing.T) {
	_, router, _, tokens := groupFixture(t)

	groupRR := dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	})
	group := decodeDMInfo(t, groupRR)

	rr := dmPost(t, router, "/api/v1/dms", tokens[0], map[string]any{"recipient_id": 2})
	if rr.Code != http.StatusCreated {
		t.Fatalf("expected a NEW 1:1 DM (201), got %d: %s", rr.Code, rr.Body.String())
	}
	var created struct {
		ChannelID int64 `json:"channel_id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.ChannelID == group.ChannelID {
		t.Fatal("1:1 DM creation reused the group DM channel")
	}
}

// ─── rename ─────────────────────────────────────────────────────────────────

func TestRenameGroupDM_ParticipantMayRename(t *testing.T) {
	_, router, bc, tokens := groupFixture(t)
	group := decodeDMInfo(t, dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	}))
	bc.sent = nil

	rr := dmPatch(t, router, fmt.Sprintf("/api/v1/dms/%d", group.ChannelID), tokens[1],
		map[string]any{"name": "Renamed by bob"})
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if got := decodeDMInfo(t, rr).Name; got != "Renamed by bob" {
		t.Errorf("expected renamed group, got %q", got)
	}
	if len(bc.sent) != 3 {
		t.Errorf("expected all 3 participants notified of the rename, got %d", len(bc.sent))
	}
}

func TestRenameGroupDM_NonParticipantRefused(t *testing.T) {
	database, router, _, tokens := groupFixture(t)
	group := decodeDMInfo(t, dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	}))
	outsider := dmCreateToken(t, database, "dave", 4)

	rr := dmPatch(t, router, fmt.Sprintf("/api/v1/dms/%d", group.ChannelID), outsider,
		map[string]any{"name": "hijacked"})
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for a non-participant, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestRenameGroupDM_RefusesOneToOne(t *testing.T) {
	_, router, _, tokens := groupFixture(t)
	rr := dmPost(t, router, "/api/v1/dms", tokens[0], map[string]any{"recipient_id": 2})
	var created struct {
		ChannelID int64 `json:"channel_id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &created)

	renameRR := dmPatch(t, router, fmt.Sprintf("/api/v1/dms/%d", created.ChannelID), tokens[0],
		map[string]any{"name": "not allowed"})
	if renameRR.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 renaming a 1:1 DM, got %d: %s", renameRR.Code, renameRR.Body.String())
	}
}

func TestRenameGroupDM_RejectsOverlongName(t *testing.T) {
	_, router, _, tokens := groupFixture(t)
	group := decodeDMInfo(t, dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	}))

	long := make([]byte, 200)
	for i := range long {
		long[i] = 'x'
	}
	rr := dmPatch(t, router, fmt.Sprintf("/api/v1/dms/%d", group.ChannelID), tokens[0],
		map[string]any{"name": string(long)})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an overlong name, got %d", rr.Code)
	}
}

// ─── leaving ────────────────────────────────────────────────────────────────

func TestLeaveGroupDM_RemovesParticipantAndNotifiesSurvivors(t *testing.T) {
	database, router, bc, tokens := groupFixture(t)
	group := decodeDMInfo(t, dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	}))
	bc.sent = nil

	rr := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%d", group.ChannelID), tokens[1])
	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d: %s", rr.Code, rr.Body.String())
	}

	ok, err := database.IsDMParticipant(context.Background(), 2, group.ChannelID)
	if err != nil {
		t.Fatalf("IsDMParticipant: %v", err)
	}
	if ok {
		t.Error("bob is still a participant after leaving")
	}

	// The leaver gets a close; the survivors get a refreshed membership.
	var closes, opens int
	for _, m := range bc.sent {
		var env struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(m.Msg, &env)
		switch env.Type {
		case "dm_channel_close":
			closes++
			if m.UserID != 2 {
				t.Errorf("close sent to user %d, expected the leaver (2)", m.UserID)
			}
		case "dm_channel_open":
			opens++
			if m.UserID == 2 {
				t.Error("the leaver must not receive a refreshed membership")
			}
		}
	}
	if closes != 1 {
		t.Errorf("expected 1 dm_channel_close, got %d", closes)
	}
	if opens != 2 {
		t.Errorf("expected 2 survivors notified, got %d", opens)
	}
}

func TestLeaveGroupDM_LastParticipantDeletesChannel(t *testing.T) {
	database, router, _, tokens := groupFixture(t)
	group := decodeDMInfo(t, dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	}))

	for _, tok := range tokens {
		if rr := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%d", group.ChannelID), tok); rr.Code != http.StatusNoContent {
			t.Fatalf("leave: %d %s", rr.Code, rr.Body.String())
		}
	}

	ch, err := database.GetChannel(context.Background(), group.ChannelID)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if ch != nil {
		t.Error("the channel should be gone once the last participant leaves")
	}
}

// Closing a 1:1 DM must stay a hide, not a leave: the closer remains a
// participant so the next message from either side reopens the conversation.
func TestCloseDM_OneToOneKeepsParticipation(t *testing.T) {
	database, router, _, tokens := groupFixture(t)
	rr := dmPost(t, router, "/api/v1/dms", tokens[0], map[string]any{"recipient_id": 2})
	var created struct {
		ChannelID int64 `json:"channel_id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &created)

	if delRR := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%d", created.ChannelID), tokens[0]); delRR.Code != http.StatusNoContent {
		t.Fatalf("close: %d", delRR.Code)
	}

	ok, err := database.IsDMParticipant(context.Background(), 1, created.ChannelID)
	if err != nil {
		t.Fatalf("IsDMParticipant: %v", err)
	}
	if !ok {
		t.Error("closing a 1:1 DM must not remove the participant row")
	}
}

func TestLeaveGroupDM_NonParticipantRefused(t *testing.T) {
	database, router, _, tokens := groupFixture(t)
	group := decodeDMInfo(t, dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	}))
	outsider := dmCreateToken(t, database, "erin", 4)

	rr := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%d", group.ChannelID), outsider)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}
