package ws

// oc_0219_voice_join_rollback_unsubscribe_test.go — regression test for
// finding OC-0219.
//
// rollbackVoiceJoin clears the client's voice channel ID but never drops its
// VoiceTopic subscription. voiceJoinComplete subscribes the joiner to
// VoiceTopic(channelID) (voice_join.go) BEFORE it reads back the channel's
// existing participants via GetChannelVoiceStates; when that read fails, the
// handler calls rollbackVoiceJoin to undo the join. Every other path that
// takes a client out of voice while its WS stays up (clearVoiceAndUnsubscribe
// in voice_leave.go, and its callers) also drops the VoiceTopic subscription
// — rollbackVoiceJoin is the only one that does not. A socket left subscribed
// after a failed join keeps receiving that room's voice_e2ee_announce relays
// (which carry no channel_id to filter on) for the rest of the connection,
// polluting whatever voice session the client joins next.
//
// This reuses voiceJoinPostTokenRaceHook (test-only plumbing shared with
// OC-0008 and OC-0172) to fault-inject a GetChannelVoiceStates failure inside
// voiceJoinComplete, landing strictly after h.pubsub.Subscribe has already
// run for this join.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

// TestVoiceJoin_GetChannelVoiceStatesError_UnsubscribesVoiceTopic pins
// OC-0219: rollbackVoiceJoin must drop the client's VoiceTopic subscription,
// not just its in-memory voiceChID, so a socket that failed mid-join stops
// receiving that room's E2EE relays.
func TestVoiceJoin_GetChannelVoiceStatesError_UnsubscribesVoiceTopic(t *testing.T) {
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "join-0219-victim")
	chID := mustCreateVoiceChannel(t, database, "voice-join-0219")

	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "test-api-key-0219",
		LiveKitAPISecret: "test-api-secret-0219-xyz",
		LiveKitURL:       "ws://127.0.0.1:1", // never dialed: GenerateToken is local
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	h := NewHub(database, auth.NewRateLimiter(), nil)
	h.SetLiveKit(lk)

	send := make(chan []byte, 8)
	c := NewTestClient(h, uid, send)
	c.user = &db.User{ID: uid, Username: "join-0219-victim"}
	h.mu.Lock()
	h.clients[uid] = c
	h.mu.Unlock()

	// Fault-inject the GetChannelVoiceStates call inside voiceJoinComplete —
	// same technique as the OC-0172 regression test. This hook fires after
	// GenerateToken succeeds and strictly before voiceJoinComplete's
	// h.pubsub.Subscribe call runs, so by the time GetChannelVoiceStates
	// executes the client is already subscribed to VoiceTopic(chID).
	var hookRan bool
	voiceJoinPostTokenRaceHook = func(client *Client) {
		hookRan = true
		if _, err := database.ExecContext(context.Background(), `ALTER TABLE users RENAME TO users_bak_0219`); err != nil {
			t.Fatalf("hook: rename users: %v", err)
		}
	}
	defer func() { voiceJoinPostTokenRaceHook = nil }()

	payload, _ := json.Marshal(map[string]any{"channel_id": chID})
	h.handleVoiceJoin(context.Background(), c, json.RawMessage(payload))

	if !hookRan {
		t.Fatal("voiceJoinPostTokenRaceHook never fired — test setup is broken, not exercising the join path")
	}

	drainChan(send, 200*time.Millisecond)

	// Sanity: the in-memory voiceChID was rolled back (OC-0172 already pins
	// this half of the cleanup).
	if gotCh := c.getVoiceChID(); gotCh != 0 {
		t.Fatalf("client voiceChID = %d after GetChannelVoiceStates failed mid-join, want 0 (rolled back)", gotCh)
	}

	// The bug: rollbackVoiceJoin must also drop the VoiceTopic subscription
	// that voiceJoinComplete already established. Left in place, this socket
	// keeps receiving voice_e2ee_announce relays for chID indefinitely.
	topic := VoiceTopic(chID)
	for _, tp := range h.pubsub.TopicsForClient(uid) {
		if tp == topic {
			t.Fatalf("client is still subscribed to %q after rollbackVoiceJoin — E2EE relays for this channel will keep reaching a socket that never finished joining it", topic)
		}
	}
}
