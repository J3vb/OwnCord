package ws_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/ws"
)

// oc_0439_voice_quality_fallback_test.go — regression test for OC-0439.
//
// channels.voice_quality has no DEFAULT and CreateChannel never writes it, so
// the column is NULL on every channel ever created. voiceJoinComplete's
// fallback for a NULL/empty ch.VoiceQuality was hardcoded to "medium",
// ignoring the operator-facing voice.quality config setting entirely. This
// pins that the configured quality, plumbed through HubOptions, is the
// fallback used when a channel has no per-channel override.
func TestVoiceJoin_UsesConfiguredQualityFallback(t *testing.T) {
	database := openVoiceTestDB(t)
	limiter := auth.NewRateLimiter()

	lk, err := ws.NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "test-api-key-12345",
		LiveKitAPISecret: "test-api-secret-67890abcdef",
		LiveKitURL:       "ws://localhost:7880",
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	hub := newTestHubWith(t, ws.HubOptions{DB: database, Limiter: limiter, LiveKit: lk, VoiceQuality: "high"})
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })

	// A freshly created channel has NULL voice_quality (CreateChannel never
	// writes the column), so the join must fall back to the configured value.
	chanID := seedVoiceChan(t, database, "vc-oc0439")

	user := seedVoiceOwner(t, database, "oc0439-user")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	msgs := drainChanTimeout(send, 50*time.Millisecond)
	found := false
	for _, msg := range msgs {
		if extractType(t, msg) != "voice_config" {
			continue
		}
		found = true
		var env struct {
			Payload struct {
				Quality string `json:"quality"`
				Bitrate int    `json:"bitrate"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("unmarshal voice_config: %v", err)
		}
		if env.Payload.Quality != "high" || env.Payload.Bitrate != 128000 {
			t.Errorf("voice_config = (quality=%q, bitrate=%d), want (quality=high, bitrate=128000): "+
				"a channel with no per-channel voice_quality override must fall back to the "+
				"server's configured voice.quality, not a hardcoded 'medium'",
				env.Payload.Quality, env.Payload.Bitrate)
		}
		break
	}
	if !found {
		t.Fatalf("joiner did not receive voice_config after voice_join")
	}
}
