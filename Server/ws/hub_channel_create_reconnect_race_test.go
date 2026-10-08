package ws

// hub_channel_create_reconnect_race_test.go — codex-oc-1732.
//
// BroadcastChannelCreate fans out unsequenced, per-recipient channel_create
// frames, so a client that misses one can only recover through a full ready.
// A client can ack a frame sequenced after the fan-out starts, drop, be
// skipped by the loop, and resume while the loop is still running; the
// reconnect's watermark re-check (mustFullResyncAtRegister, under seqMu) must
// force that resume onto the full-ready path for the whole fan-out, not only
// once the trailing watermark bump has landed.

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestBroadcastChannelCreate_ReconnectDuringFanoutForcesFullResync(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "create-race-user")
	chID := mustCreateVoiceChannel(t, database, "create-race-channel")
	ch, err := database.GetChannel(ctx, chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	h.RegisterNowForTest(NewTestClientWithUser(h, user, 0, make(chan []byte, 8)))

	var hookRan, forced bool
	broadcastChannelCreateRaceHook = func(userID int64) {
		if userID != uid {
			return
		}
		hookRan = true
		// A sequenced frame lands mid-fan-out; the reconnecting client has
		// acked it, so its last_seq sits above the leading watermark bump.
		lastSeq := atomic.AddUint64(&h.seq, 1)
		h.seqMu.Lock()
		forced = h.mustFullResyncAtRegister(lastSeq)
		h.seqMu.Unlock()
	}
	defer func() { broadcastChannelCreateRaceHook = nil }()

	h.BroadcastChannelCreate(ch)

	if !hookRan {
		t.Fatal("broadcastChannelCreateRaceHook never fired — test setup is broken, not exercising the race window")
	}
	if !forced {
		t.Error("a reconnect registering mid-fan-out was allowed to replay; it would never receive the channel_create")
	}
	// Once the fan-out ends, a resume from a seq it could have acked is still
	// forced to a full ready by the trailing bump.
	h.seqMu.Lock()
	defer h.seqMu.Unlock()
	if !h.mustFullResyncAtRegister(atomic.LoadUint64(&h.seq)) {
		t.Error("after the fan-out, a resume from the mid-fan-out seq was allowed to replay")
	}
}
