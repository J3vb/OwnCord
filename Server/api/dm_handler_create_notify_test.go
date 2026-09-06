package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// TestCreateDM_Success_NotifiesRecipient pins OC-0199 for a pair that
// already trusts each other: a REST-created 1:1 DM must tell the recipient
// about it immediately (a dm_channel_open event), mirroring what
// handleCreateGroupDM already does via broadcastDMOpen.
//
// Without this, GetOrCreateDMChannel pre-opens dm_open_state for BOTH users
// at creation time, so the recipient's OpenDM call on the first message
// later finds the row already present (INSERT OR IGNORE affects 0 rows) and
// never reports "opened" either — leaving the recipient with no live event
// and no visibility-watermark bump to pick the DM up on a warm reconnect.
//
// B5-6 (Codex P1-1) narrowed this to the trusted case: an UNTRUSTED
// recipient must get no such notification at creation time — see
// TestCreateDM_Untrusted_DoesNotNotifyRecipientOrOpenTheirSide below — so
// this test explicitly trusts the pair first, the same way seedDMChannel
// (ws) and journeyDMSend (the protocol fixture) do.
func TestCreateDM_Success_NotifiesRecipient(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &mockBroadcaster{}
	router := buildDMRouter(database, broadcaster)

	tokenAlice := dmCreateToken(t, database, "notify_alice", 4)
	_ = dmCreateToken(t, database, "notify_bob", 4)
	alice, err := database.GetUserByUsername(context.Background(), "notify_alice")
	if err != nil || alice == nil {
		t.Fatalf("lookup alice: %v", err)
	}
	bob, err := database.GetUserByUsername(context.Background(), "notify_bob")
	if err != nil || bob == nil {
		t.Fatalf("lookup bob: %v", err)
	}
	if err := database.TrustSender(context.Background(), bob.ID, alice.ID, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
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

// TestCreateDM_Untrusted_DoesNotNotifyRecipientOrOpenTheirSide is B5-6's
// Codex P1-1 fix: a stranger creating a 1:1 DM must not show up in the
// recipient's DM list, or send them a dm_channel_open, before any message
// (and its first-contact gate) exists — GetOrCreateDMChannel's unconditional
// both-sides open is undone for the untrusted recipient.
func TestCreateDM_Untrusted_DoesNotNotifyRecipientOrOpenTheirSide(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &mockBroadcaster{}
	router := buildDMRouter(database, broadcaster)

	tokenAlice := dmCreateToken(t, database, "untrusted_alice", 4)
	_ = dmCreateToken(t, database, "untrusted_bob", 4)
	bob, err := database.GetUserByUsername(context.Background(), "untrusted_bob")
	if err != nil || bob == nil {
		t.Fatalf("lookup bob: %v", err)
	}

	rr := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("CreateDM: status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}
	for _, m := range broadcaster.sent {
		if m.UserID == bob.ID {
			t.Errorf("untrusted recipient got a broadcast at creation time: %s", m.Msg)
		}
	}

	var n int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM dm_open_state WHERE user_id = ?`, bob.ID).Scan(&n); err != nil || n != 0 {
		t.Errorf("dm_open_state rows for the untrusted recipient = %d, %v; want 0", n, err)
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
