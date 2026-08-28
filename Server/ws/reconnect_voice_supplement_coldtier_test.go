package ws

// reconnect_voice_supplement_coldtier_test.go — regression test for OC-0337.
//
// liveVoiceEventsSince's cold-tier fallback (serve.go) runs the identical
// GetEventsSinceForChannels query as reconnectSelectReplay's cold-tier branch,
// with the identical row cap — but reconnectSelectReplay detects a cap hit
// ("ORDER BY seq ASC LIMIT n" means a full result silently dropped the NEWEST
// rows) and forces a full ready, while liveVoiceEventsSince had no such guard
// and handed the truncated window to the client as if it were complete. Since
// the query is oldest-first, the dropped rows are always the newest — which,
// for a voice room, is exactly where a peer's voice_leave would land after a
// run of earlier voice_state joins. The resumed client would then render a
// participant who has actually left, with no correction ever sent (the client
// tracks only max(seq)).
//
// This test seeds more persisted voice events on a channel than the
// configured cold-tier cap, with a voice_leave as the newest (and therefore
// dropped) row, and asserts the supplement degrades to nil — the documented
// best-effort miss — rather than returning a window that omits the leave.

import (
	"context"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestLiveVoiceEventsSince_ColdTierCapHit_DegradesToNil(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	const chID = int64(555)
	const coldCap = 3

	// Four persisted voice events on chID, but the cap is 3: the cold-tier
	// query ("ORDER BY seq ASC LIMIT 3") returns only the three oldest —
	// three voice_state joins — and silently drops the fourth, a
	// voice_leave, which is exactly the row a resuming client needs most.
	types := []string{MsgTypeVoiceState, MsgTypeVoiceState, MsgTypeVoiceState, MsgTypeVoiceLeaveBC}
	for i, evtType := range types {
		seq := int64(i + 1)
		payload := fmt.Appendf(nil, `{"seq":%d,"type":%q,"payload":{"channel_id":%d}}`, seq, evtType, chID)
		if err := database.PersistEvent(ctx, seq, evtType, chID, payload); err != nil {
			t.Fatalf("PersistEvent seq=%d: %v", seq, err)
		}
	}

	hub := NewHub(database, auth.NewRateLimiter(), nil)
	hub.SetEventStore(database)
	hub.ConfigureReplay(0, coldCap) // must run before Run(); this test never calls Run()

	// Ring buffer is untouched (nothing pushed), so EventsSinceFiltered
	// returns nil and liveVoiceEventsSince must fall through to the cold tier.
	got := hub.liveVoiceEventsSince(ctx, 0, chID)
	if got != nil {
		t.Fatalf("liveVoiceEventsSince: cap-hit cold-tier window must degrade to nil (best-effort miss), got %d event(s) — a truncated window silently drops the newest row (the voice_leave), installing a join whose matching leave was discarded", len(got))
	}
}
