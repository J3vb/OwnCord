package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

// orderRecordingCloseDMBroadcaster records the order MarkVisibilityChanged
// and SendToUser are called in, delegating the actual bookkeeping to an
// embedded mockBroadcaster so dmPost/dmDelete keep working unmodified.
type orderRecordingCloseDMBroadcaster struct {
	*mockBroadcaster
	calls []string
}

func (b *orderRecordingCloseDMBroadcaster) MarkVisibilityChanged() {
	b.calls = append(b.calls, "bump")
}

func (b *orderRecordingCloseDMBroadcaster) SendToUser(userID int64, msg []byte) bool {
	b.calls = append(b.calls, "notify")
	return b.mockBroadcaster.SendToUser(userID, msg)
}

// TestCloseDM_WatermarkBumpsBeforeTheNotifySend pins OC-0424: handleCloseDM
// must bump the visibility watermark BEFORE sending dm_channel_close, the
// same ordering broadcastDMOpen (relative to its SendToUser loop) and the
// NSFW ack/revoke handlers use — see TestNSFW_WatermarkBumpsBeforeTheNotifySend
// in nsfw_watermark_order_test.go.
//
// ws.Hub.MarkVisibilityChanged and reconnectRegister share h.seqMu precisely
// so that a socket registering concurrently either observes the bumped
// watermark (and takes the full-ready path) or is already registered by the
// time the caller's send runs. If the bump instead runs after the send, a
// warm reconnect landing in the gap observes the stale watermark, is granted
// a sequenced-only resume, and dm_channel_close — unsequenced and targeted —
// can never be redelivered to it: the client keeps rendering a DM that was
// already closed.
func TestCloseDM_WatermarkBumpsBeforeTheNotifySend(t *testing.T) {
	database := newDMTestDB(t)
	bc := &orderRecordingCloseDMBroadcaster{mockBroadcaster: &mockBroadcaster{}}
	router := buildDMRouter(database, bc)

	tokenAlice := dmCreateToken(t, database, "order_alice", 4)
	_ = dmCreateToken(t, database, "order_bob", 4)
	bob, _ := database.GetUserByUsername(context.Background(), "order_bob")

	rr1 := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	if rr1.Code != http.StatusCreated {
		t.Fatalf("setup CreateDM: status = %d, want 201; body = %s", rr1.Code, rr1.Body.String())
	}
	var createResp map[string]any
	_ = json.NewDecoder(rr1.Body).Decode(&createResp)
	channelID := createResp["channel_id"]

	// Only the close's own calls matter — creation already exercised
	// broadcastDMOpen (and its own correctly-ordered bump) against bob.
	bc.calls = nil

	rr := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%v", channelID), tokenAlice)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("CloseDM: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}

	if len(bc.calls) < 2 || bc.calls[0] != "bump" {
		t.Fatalf("close order = %v, want the watermark bump before the first notify send — "+
			"a socket registering between them must already observe the bumped watermark", bc.calls)
	}
}
