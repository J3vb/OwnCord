package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
)

// An externally managed SFU (lkProcess == nil) that is unreachable must be
// refused before a token is minted. Minting one is the disguised-success shape
// B6-6 forbids: the client is handed a credential and only discovers the
// failure when its connection attempt dies, with no server-side explanation.
// cmd/smoke's stepSExternalAbsent records exactly this; the managed case is
// covered by voiceJoinPrecheck's IsRunning guard.
func TestHandleVoiceJoin_ExternalLiveKitUnreachable_RefusedNoToken(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "lk-down")
	chID := mustCreateVoiceChannel(t, database, "voice-lk-down")

	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "harvest-key",
		LiveKitAPISecret: "harvest-secret-0123456789abcdef",
		LiveKitURL:       "ws://127.0.0.1:1", // nothing is listening here
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	h.livekit = lk

	c := NewTestClient(h, uid, make(chan []byte, 32))
	c.user = user
	h.clients[uid] = c

	h.handleVoiceJoin(ctx, c, json.RawMessage(fmt.Sprintf(`{"channel_id": %d}`, chID)), "")

	sawRefusal := false
	for {
		select {
		case raw := <-c.send:
			var env struct {
				Type    string `json:"type"`
				Payload struct {
					Code string `json:"code"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(raw, &env); err != nil {
				continue
			}
			if env.Type == "voice_token" {
				t.Fatal("minted a voice_token for an unreachable externally managed SFU (B6-6 disguised success)")
			}
			if env.Type == "error" {
				sawRefusal = true
				if env.Payload.Code != ErrCodeVoiceError {
					t.Errorf("refusal code = %q, want %q", env.Payload.Code, ErrCodeVoiceError)
				}
			}
		default:
			if !sawRefusal {
				t.Error("no error frame for an unreachable externally managed SFU")
			}
			if vs, err := database.GetVoiceState(ctx, uid); err == nil && vs != nil {
				t.Error("unreachable SFU left a voice_states row behind")
			}
			return
		}
	}
}
