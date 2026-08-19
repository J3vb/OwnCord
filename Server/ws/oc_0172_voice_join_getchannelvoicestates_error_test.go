package ws

// oc_0172_voice_join_getchannelvoicestates_error_test.go — regression test
// for finding OC-0172.
//
// voiceJoinComplete had already subscribed the joiner to the voice topic,
// re-elected the key holder, and broadcast the joiner's own voice_state to
// every client that can see the channel by the time it reads back the
// channel's existing participants via GetChannelVoiceStates. That read is
// also the ONLY place the server ever relays an existing participant's
// stored ECDH public key (voice_e2ee_announce) to a joiner. When the read
// failed, the old code just `return`ed: no error frame, no rollback of the
// voice_states row it had already committed, no compensating voice_leave for
// the voice_state it had already broadcast, and the client's in-memory
// voiceChID stayed set even though the join never finished. The joiner was
// left half-joined and silent, guaranteed to fail the E2EE key exchange with
// whoever was already in the channel and time out ~15s later with no
// explanation.
//
// This reuses voiceJoinPostTokenRaceHook (already test-only plumbing for
// OC-0008) to fault-inject exactly the failure this finding describes: it
// fires after the token round trip completes and before voiceJoinComplete's
// GetChannelVoiceStates call, so everything up to and including the joiner's
// own voice_state broadcast has already happened by the time the DB read
// that this finding is about fails.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

// TestVoiceJoin_GetChannelVoiceStatesError_RollsBackAndNotifiesClient pins
// OC-0172: a GetChannelVoiceStates failure inside voiceJoinComplete must not
// leave the joiner silently half-joined. It must roll back the DB row it
// already committed and tell the client the join failed, the same way every
// other post-commit failure in this handler already does (BUG-088's
// rollbackVoiceJoin, OC-0008's token-supersession guard).
func TestVoiceJoin_GetChannelVoiceStatesError_RollsBackAndNotifiesClient(t *testing.T) {
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "join-0172-victim")
	chID := mustCreateVoiceChannel(t, database, "voice-join-0172")

	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "test-api-key-0172",
		LiveKitAPISecret: "test-api-secret-0172-xyz",
		LiveKitURL:       "ws://127.0.0.1:1", // never dialed: GenerateToken is local
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	h := NewHub(database, auth.NewRateLimiter(), nil)
	h.SetLiveKit(lk)

	send := make(chan []byte, 8)
	c := NewTestClient(h, uid, send)
	c.user = &db.User{ID: uid, Username: "join-0172-victim"}
	h.mu.Lock()
	h.clients[uid] = c
	h.mu.Unlock()

	// Fault-inject the GetChannelVoiceStates call inside voiceJoinComplete.
	// This hook fires after GenerateToken succeeds and before the token is
	// handed to the client — i.e. strictly before voiceJoinComplete runs, so
	// by the time GetChannelVoiceStates executes, the `users` table it joins
	// against is gone and it returns an error. Nothing between the hook and
	// that call touches the DB (subscribe, updateKeyHolder, and the joiner's
	// own voice_state broadcast are all in-memory), so this does not perturb
	// any earlier step.
	//
	// Renaming (not dropping) `users` is deliberate: with foreign keys
	// enabled, SQLite's DROP TABLE performs an implicit cascading DELETE
	// through any FK referencing the dropped table before removing it (see
	// https://www.sqlite.org/lang_droptable.html), which would delete the
	// joiner's own voice_states row as a side effect of the fault injection
	// itself — masking whether the handler's own rollback logic is what
	// cleaned it up. A rename breaks the same JOIN without touching any row.
	var hookRan bool
	voiceJoinPostTokenRaceHook = func(client *Client) {
		hookRan = true
		if _, err := database.ExecContext(context.Background(), `ALTER TABLE users RENAME TO users_bak_0172`); err != nil {
			t.Fatalf("hook: rename users: %v", err)
		}
	}
	defer func() { voiceJoinPostTokenRaceHook = nil }()

	payload, _ := json.Marshal(map[string]any{"channel_id": chID})
	h.handleVoiceJoin(context.Background(), c, json.RawMessage(payload))

	if !hookRan {
		t.Fatal("voiceJoinPostTokenRaceHook never fired — test setup is broken, not exercising the join path")
	}

	msgs := drainChan(send, 200*time.Millisecond)

	var gotError bool
	for _, m := range msgs {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env.Type == MsgTypeError {
			gotError = true
			if env.Payload.Code != ErrCodeInternal {
				t.Errorf("error frame code = %q, want %q", env.Payload.Code, ErrCodeInternal)
			}
		}
	}
	if !gotError {
		t.Error("client received no error frame after GetChannelVoiceStates failed mid-join — the join silently half-completed with no explanation")
	}

	// The client's in-memory voice state must be cleared, not left pointing
	// at a join the server gave up on partway through.
	if gotCh := c.getVoiceChID(); gotCh != 0 {
		t.Errorf("client voiceChID = %d after GetChannelVoiceStates failed mid-join, want 0 (rolled back)", gotCh)
	}

	// The voice_states row committed earlier in the handler must not survive
	// a join that never finished. Query without the `users` JOIN so the
	// dropped table (a fault-injection artifact, not part of the finding)
	// does not itself break this check.
	var count int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM voice_states WHERE user_id = ?`, uid).Scan(&count); err != nil {
		t.Fatalf("count voice_states: %v", err)
	}
	if count != 0 {
		t.Errorf("voice_states row for user %d still present after a join that failed mid-completion, want it rolled back", uid)
	}
}
