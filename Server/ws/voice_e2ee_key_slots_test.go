package ws_test

import (
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/ws"
)

// voice_e2ee_announce carries an optional key_slots flag: the announcer stages
// each new room key in its own slot and switches to it a moment later. The
// server relays it and replays it to late joiners with the key.

func e2eeAnnounceMsgKeySlots(publicKey string, keySlots any) []byte {
	payload := map[string]any{"public_key": publicKey}
	if keySlots != nil {
		payload["key_slots"] = keySlots
	}
	raw, _ := json.Marshal(map[string]any{"type": "voice_e2ee_announce", "payload": payload})
	return raw
}

func payloadKeySlots(t *testing.T, msg []byte) (bool, bool) {
	t.Helper()
	var env struct {
		Payload map[string]json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	raw, ok := env.Payload["key_slots"]
	if !ok {
		return false, false
	}
	var v bool
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("key_slots is not a bool: %s", raw)
	}
	return v, true
}

func TestVoiceE2EEAnnounce_RelaysAndReplaysKeySlots(t *testing.T) {
	hub, database, chanID, c1, _, send2 := decodeRoom(t, "ks-relay")
	key := validB64Key()
	hub.HandleMessageForTest(c1, e2eeAnnounceMsgKeySlots(key, true))

	m := waitMsgOfType(send2, "voice_e2ee_announce", waitTimeout)
	if m == nil {
		t.Fatal("peer should receive the announce")
	}
	if v, ok := payloadKeySlots(t, m); !ok || !v {
		t.Errorf("relayed key_slots = %v (present=%v), want true", v, ok)
	}

	user3 := seedVoiceOwner(t, database, "ks-relay-user3")
	send3 := make(chan []byte, 32)
	c3 := ws.NewTestClientWithUser(hub, user3, 0, send3)
	hub.Register(c3)
	waitRegistered(t, hub, c3)
	hub.HandleMessageForTest(c3, voiceJoinMsg(chanID))
	rm := waitMsgOfType(send3, "voice_e2ee_announce", waitTimeout)
	if rm == nil {
		t.Fatal("late joiner should receive the replayed announce")
	}
	if v, ok := payloadKeySlots(t, rm); !ok || !v {
		t.Errorf("replayed key_slots = %v (present=%v), want true", v, ok)
	}
}

func TestVoiceE2EEAnnounce_KeySlotsOnlyForTrue(t *testing.T) {
	tests := []struct {
		name  string
		value any
	}{
		{"absent", nil},
		{"false", false},
		{"string", "true"},
		{"number", 1},
		{"object", map[string]any{"a": true}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			hub, _, _, c1, user1, send2 := decodeRoom(t, "ks-"+tc.name)
			key := validB64Key()
			hub.HandleMessageForTest(c1, e2eeAnnounceMsgKeySlots(key, tc.value))

			m := waitMsgOfType(send2, "voice_e2ee_announce", waitTimeout)
			if m == nil {
				t.Fatal("the announce must still be relayed")
			}
			if _, present := payloadKeySlots(t, m); present {
				t.Errorf("key_slots must be omitted unless true, relay was %s", m)
			}
			if got := hub.GetClientE2EEPubKeyForTest(user1.ID); got != key {
				t.Errorf("stored key = %q, want %q (key must be accepted)", got, key)
			}
		})
	}
}
