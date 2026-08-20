package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// TestCreateDM_Success_NotifiesRecipient pins OC-0199: a REST-created 1:1 DM
// must tell the recipient about it immediately (a dm_channel_open event),
// mirroring what handleCreateGroupDM already does via broadcastDMOpen.
//
// Without this, GetOrCreateDMChannel pre-opens dm_open_state for BOTH users
// at creation time, so the recipient's OpenDM call on the first message
// later finds the row already present (INSERT OR IGNORE affects 0 rows) and
// never reports "opened" either — leaving the recipient with no live event
// and no visibility-watermark bump to pick the DM up on a warm reconnect.
func TestCreateDM_Success_NotifiesRecipient(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &mockBroadcaster{}
	router := buildDMRouter(database, broadcaster)

	tokenAlice := dmCreateToken(t, database, "notify_alice", 4)
	_ = dmCreateToken(t, database, "notify_bob", 4)
	bob, err := database.GetUserByUsername(context.Background(), "notify_bob")
	if err != nil || bob == nil {
		t.Fatalf("lookup bob: %v", err)
	}

	rr := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("CreateDM: status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}

	var gotOpenForBob bool
	for _, m := range broadcaster.sent {
		if m.UserID != bob.ID {
			continue
		}
		var payload struct {
			Type string `json:"type"`
		}
		if jsonErr := json.Unmarshal(m.Msg, &payload); jsonErr != nil {
			continue
		}
		if payload.Type == "dm_channel_open" {
			gotOpenForBob = true
		}
	}
	if !gotOpenForBob {
		t.Errorf("CreateDM: recipient %d never got a dm_channel_open broadcast; sent = %v",
			bob.ID, dumpSent(broadcaster.sent))
	}
}

func dumpSent(sent []mockBroadcastMsg) string {
	var b bytes.Buffer
	for _, m := range sent {
		b.WriteString(m.String())
		b.WriteByte('\n')
	}
	return b.String()
}

// String renders a mockBroadcastMsg for test failure output.
func (m mockBroadcastMsg) String() string {
	return string(m.Msg)
}
