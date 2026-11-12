package ws_test

import (
	"encoding/json"
	"testing"
	"time"
)

// drainForErrorEnvelope reads from ch until an error frame arrives and returns
// its code and envelope id; hasID is false when the frame had no id key.
func drainForErrorEnvelope(ch <-chan []byte, deadline time.Duration) (code, id string, hasID bool) {
	env := waitErrorEnvelope(ch, deadline, func(map[string]any) bool { return true })
	if env == nil {
		return "", "", false
	}
	if payload, ok := errorPayload(env); ok {
		code, _ = payload["code"].(string)
	}
	rawID, present := env["id"]
	id, _ = rawID.(string)
	return code, id, present
}

func voiceJoinFrame(t *testing.T, reqID string, channelID int64) []byte {
	t.Helper()
	env := map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": channelID},
	}
	if reqID != "" {
		env["id"] = reqID
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal voice_join: %v", err)
	}
	return raw
}

func TestVoiceJoinRefusal_EchoesRequestID(t *testing.T) {
	t.Run("not_found_precheck", func(t *testing.T) {
		hub, database := newCoverageHub(t)
		user := seedCoverageOwner(t, database, "vjid-nf")
		c, send := connectClient(t, hub, user, 0, 64)

		hub.HandleMessageForTest(c, voiceJoinFrame(t, "req-nf", 999999))

		code, id, _ := drainForErrorEnvelope(send, 500*time.Millisecond)
		if code != "NOT_FOUND" || id != "req-nf" {
			t.Fatalf("got code=%q id=%q, want NOT_FOUND with id req-nf", code, id)
		}
	})

	t.Run("join_gate_text_channel", func(t *testing.T) {
		hub, database := newCoverageHub(t)
		textID := mustCreateChannel(t, database, "vjid-text", "text")
		user := seedCoverageOwner(t, database, "vjid-gate")
		c, send := connectClient(t, hub, user, 0, 64)

		hub.HandleMessageForTest(c, voiceJoinFrame(t, "req-gate", textID))

		code, id, _ := drainForErrorEnvelope(send, 500*time.Millisecond)
		if code == "" || id != "req-gate" {
			t.Fatalf("got code=%q id=%q, want a refusal with id req-gate", code, id)
		}
	})

	t.Run("channel_full_persist", func(t *testing.T) {
		hub, database := newCoverageHub(t)
		vcID := mustCreateChannel(t, database, "vjid-full", "voice")
		mustExec(t, database, "UPDATE channels SET voice_max_users = 1 WHERE id = ?", vcID)

		user1 := seedCoverageOwner(t, database, "vjid-full-u1")
		c1, send1 := connectClient(t, hub, user1, 0, 64)
		hub.HandleMessageForTest(c1, voiceJoinFrame(t, "req-first", vcID))
		drainChanTimeout(send1, 100*time.Millisecond)

		user2 := seedVoiceMember(t, database, "vjid-full-u2")
		c2, send2 := connectClient(t, hub, user2, 0, 64)
		hub.HandleMessageForTest(c2, voiceJoinFrame(t, "req-full", vcID))

		code, id, _ := drainForErrorEnvelope(send2, 500*time.Millisecond)
		if code != "CHANNEL_FULL" || id != "req-full" {
			t.Fatalf("got code=%q id=%q, want CHANNEL_FULL with id req-full", code, id)
		}
	})

	t.Run("rate_limited", func(t *testing.T) {
		hub, database := newCoverageHub(t)
		user := seedCoverageOwner(t, database, "vjid-rl")
		c, send := connectClient(t, hub, user, 0, 64)

		// Each refused attempt still spends a rate-limit token.
		for range 5 {
			hub.HandleMessageForTest(c, voiceJoinFrame(t, "req-spend", 999999))
		}
		drainChanTimeout(send, 100*time.Millisecond)
		hub.HandleMessageForTest(c, voiceJoinFrame(t, "req-rl", 999999))

		code, id, _ := drainForErrorEnvelope(send, 500*time.Millisecond)
		if code != "RATE_LIMITED" || id != "req-rl" {
			t.Fatalf("got code=%q id=%q, want RATE_LIMITED with id req-rl", code, id)
		}
	})
}

func TestVoiceJoinRefusal_NoRequestID_StaysIDLess(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vjid-none")
	c, send := connectClient(t, hub, user, 0, 64)

	hub.HandleMessageForTest(c, voiceJoinFrame(t, "", 999999))

	code, _, hasID := drainForErrorEnvelope(send, 500*time.Millisecond)
	if code != "NOT_FOUND" {
		t.Fatalf("got code=%q, want NOT_FOUND", code)
	}
	if hasID {
		t.Fatal("an id-less voice_join refusal must not carry an id key")
	}
}
