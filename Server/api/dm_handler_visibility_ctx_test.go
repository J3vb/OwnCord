package api_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// OC-0140: broadcastDMOpen is called with r.Context() by CreateGroupDM (and
// the rename/group-leave refreshes). The channel row and its participants
// have already committed by the time broadcastDMOpen runs, so if the caller's
// request context is cancelled in the gap (client disconnect), every
// DMSummaryFor lookup inside the fan-out loop fails with context.Canceled and
// is silently skipped — nobody gets the dm_channel_open, and (because it is
// unsequenced) nothing ever redelivers it.
func TestBroadcastDMOpen_SurvivesCancelledRequestContext(t *testing.T) {
	database := newDMTestDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	broadcaster := &mockBroadcaster{}

	// Fresh per-test DB, so creation order fixes the IDs: alice=1, bob=2, carol=3.
	_ = dmCreateToken(t, database, "ctx_alice", 4)
	_ = dmCreateToken(t, database, "ctx_bob", 4)
	_ = dmCreateToken(t, database, "ctx_carol", 4)

	result, err := svc.DMs.CreateGroupDM(context.Background(), 1, []int64{2, 3}, "")
	if err != nil {
		t.Fatalf("CreateGroupDM: %v", err)
	}

	// Simulate the request context being cancelled after the mutation has
	// committed but before the fan-out loop runs — e.g. the caller's
	// connection dropped mid-handler.
	cancelledCtx, cancel := context.WithCancel(context.Background())
	cancel()

	api.BroadcastDMOpenForTest(cancelledCtx, svc, broadcaster, result.Channel.ID, result.ParticipantIDs)

	if len(broadcaster.sent) != len(result.ParticipantIDs) {
		t.Fatalf("SendToUser calls = %d, want %d (one per participant): a cancelled request context must not stop the DM-open fan-out from reaching participants who are otherwise unaffected by the cancellation",
			len(broadcaster.sent), len(result.ParticipantIDs))
	}
}
