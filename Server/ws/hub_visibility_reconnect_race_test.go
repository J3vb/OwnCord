package ws

// hub_visibility_reconnect_race_test.go — RefreshChannelVisibility and
// revokeUnreadableChannels send unsequenced, targeted channel_create /
// channel_delete frames, so a client that misses one recovers only through a
// full ready. A client can ack a frame sequenced after the pass starts, drop,
// and resume while the pass is still running; the reconnect's register-time
// check must force that resume onto a full ready for the whole pass, the same
// guarantee BroadcastChannelCreate has (codex-oc-1732).

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// midPassResyncForced allocates one seq (a frame the reconnecting client
// acked) and reports whether a reconnect from it would be forced to a full
// ready right now.
func midPassResyncForced(h *Hub) bool {
	lastSeq := atomic.AddUint64(&h.seq, 1)
	h.seqMu.Lock()
	defer h.seqMu.Unlock()
	return h.mustFullResyncAtRegister(lastSeq, 0, "")
}

func assertResyncForcedAfterPass(t *testing.T, h *Hub) {
	t.Helper()
	h.seqMu.Lock()
	defer h.seqMu.Unlock()
	if !h.mustFullResyncAtRegister(atomic.LoadUint64(&h.seq), 0, "") {
		t.Error("after the pass, a resume from the mid-pass seq was allowed to replay")
	}
}

func TestRefreshChannelVisibility_ReconnectDuringFanoutForcesFullResync(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "refresh-resync-user")
	chID := mustCreateVoiceChannel(t, database, "refresh-resync-channel")
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
	refreshChannelVisibilityRaceHook = func(userID int64) {
		if userID != uid {
			return
		}
		hookRan = true
		forced = midPassResyncForced(h)
	}
	defer func() { refreshChannelVisibilityRaceHook = nil }()

	h.RefreshChannelVisibility(ch)

	if !hookRan {
		t.Fatal("refreshChannelVisibilityRaceHook never fired — test setup is broken, not exercising the race window")
	}
	if !forced {
		t.Error("a reconnect registering mid-fan-out was allowed to replay; it would never receive the targeted frame")
	}
	assertResyncForcedAfterPass(t, h)
}

func TestRevokeUnreadableChannels_ReconnectDuringPassForcesFullResync(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	seedDemotedRole(t, database)
	uid := seedHarvestVoiceUser(t, database, "revoke-resync-user")
	chID := mustCreateTextChannel(t, database, "revoke-resync-channel")
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	c := newClient(h, nil, user, "", 0, ctx)
	h.mu.Lock()
	h.clients[uid] = []*Client{c}
	h.mu.Unlock()
	h.pubsub.Subscribe(c, ChannelTopic(chID))

	// Demoted: the pass finds chID unreadable and reaches the pre-act hook.
	reassignRole(t, database, uid, demotedRoleID)

	var hookRan, forced bool
	revokeUnreadableChannelsPreActRaceHook = func(userID int64) {
		if userID != uid {
			return
		}
		hookRan = true
		forced = midPassResyncForced(h)
	}
	defer func() { revokeUnreadableChannelsPreActRaceHook = nil }()

	h.revokeUnreadableChannels(uid)

	if !hookRan {
		t.Fatal("revokeUnreadableChannelsPreActRaceHook never fired — test setup is broken, not exercising the race window")
	}
	if !forced {
		t.Error("a reconnect registering mid-revoke was allowed to replay; it would never receive the channel_delete")
	}
	assertResyncForcedAfterPass(t, h)
}
