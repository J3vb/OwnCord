package ws

// voice_join_token_race_test.go — regression test for OC-0008.
//
// handleVoiceJoin used to hand the client its LiveKit token (voice_join.go,
// the c.sendMsg(buildVoiceToken(...)) call) BEFORE checking whether the join
// had been superseded by a concurrent eviction (voice_mod_kick/move, the
// CONNECT_VOICE revocation sweep, CleanupVoiceForChannel). Those evictors all
// run while the joiner's goroutine is still inside the permission checks and
// GenerateToken call: they clear the client's in-memory voice state, delete
// the voice_states row, and call RemoveParticipant — which no-ops because the
// join has not reached the SFU yet. The token that goes out afterward is
// therefore a live 5-minute RoomJoin credential for a user the server just
// decided is not in the channel, and the client connects to the SFU with it.
//
// GenerateToken itself is a local JWT mint with no I/O, so the window between
// it and c.sendMsg is too narrow to land by staggering real goroutines.
// voiceJoinPostTokenRaceHook (test-only, nil in production) fires at exactly
// that point, mirroring the existing cleanupVoiceRaceClearHook pattern
// (hub_sweep.go) used to pin the analogous CleanupVoiceForChannel race.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

// TestVoiceJoin_SupersededDuringTokenGeneration_WithholdsToken pins OC-0008:
// if the client's voice state no longer matches this join instance by the
// time GenerateToken returns, the minted token must never reach the client.
func TestVoiceJoin_SupersededDuringTokenGeneration_WithholdsToken(t *testing.T) {
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "join-race-victim")
	chID := mustCreateVoiceChannel(t, database, "voice-join-race")

	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "test-api-key-race-0008",
		LiveKitAPISecret: "test-api-secret-race-0008-xyz",
		LiveKitURL:       "ws://127.0.0.1:1", // never dialed: GenerateToken is local
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	h := NewHub(database, auth.NewRateLimiter(), nil)
	h.SetLiveKit(lk)

	send := make(chan []byte, 8)
	c := NewTestClient(h, uid, send)
	c.user = &db.User{ID: uid, Username: "join-race-victim"}
	h.mu.Lock()
	h.clients[uid] = c
	h.mu.Unlock()

	// Simulate a moderator's kick landing between GenerateToken returning and
	// the token being handed to the client: clear the client's in-memory
	// voice state and delete the DB row, exactly as
	// DisconnectFromVoiceInChannel -> handleVoiceLeaveIfStillIn ->
	// clearVoiceStateIfMatch / LeaveVoiceChannelIfMatch do.
	var hookRan bool
	voiceJoinPostTokenRaceHook = func(client *Client) {
		hookRan = true
		if _, cleared := client.clearVoiceStateIfMatch(chID); !cleared {
			t.Errorf("hook: client voice state did not match channel %d at hook time", chID)
		}
		state, err := database.GetVoiceState(context.Background(), uid)
		if err != nil {
			t.Fatalf("hook: GetVoiceState: %v", err)
		}
		if state != nil {
			if _, err := database.LeaveVoiceChannelIfMatch(context.Background(), uid, chID, state.JoinedAt); err != nil {
				t.Fatalf("hook: LeaveVoiceChannelIfMatch: %v", err)
			}
		}
	}
	defer func() { voiceJoinPostTokenRaceHook = nil }()

	payload, _ := json.Marshal(map[string]any{"channel_id": chID})
	h.handleVoiceJoin(context.Background(), c, json.RawMessage(payload))

	if !hookRan {
		t.Fatal("voiceJoinPostTokenRaceHook never fired — test setup is broken, not exercising the join path")
	}

	msgs := drainChan(send, 100*time.Millisecond)
	for _, m := range msgs {
		var env struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env.Type == "voice_token" {
			t.Errorf("client received a voice_token for a join the server had already evicted mid-flight — got message %s", m)
		}
	}

	// The DB row must stay gone: the join must not resurrect what the
	// concurrent eviction just tore down.
	if state, err := database.GetVoiceState(context.Background(), uid); err != nil {
		t.Fatalf("GetVoiceState after join: %v", err)
	} else if state != nil {
		t.Errorf("voice_states row for user %d still present after a join superseded mid-flight, want it to stay deleted", uid)
	}

	// The client's own in-memory voice state must also stay cleared.
	if gotCh := c.getVoiceChID(); gotCh != 0 {
		t.Errorf("client voiceChID = %d after a join superseded mid-flight, want 0 (cleared by the eviction, not resurrected)", gotCh)
	}
}
