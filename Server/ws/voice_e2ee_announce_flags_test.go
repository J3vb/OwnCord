package ws_test

import (
	"encoding/json"
	"testing"
)

// voice_e2ee_announce carries optional capability flags: key_slots (the
// announcer stages each new room key in its own slot and switches to it a
// moment later) and bound_offers (it unwraps offers that bind sender and
// recipient). The server relays each and replays it to late joiners with the key.

var announceFlags = []string{"key_slots", "bound_offers"}

func e2eeAnnounceMsgFlag(publicKey, flag string, value any) []byte {
	payload := map[string]any{"public_key": publicKey}
	if value != nil {
		payload[flag] = value
	}
	raw := envelope("voice_e2ee_announce", payload)
	return raw
}

func payloadFlag(t *testing.T, msg []byte, flag string) (bool, bool) {
	t.Helper()
	var env struct {
		Payload map[string]json.RawMessage `json:"payload"`
	}
	mustUnmarshal(t, msg, &env)
	raw, ok := env.Payload[flag]
	if !ok {
		return false, false
	}
	var v bool
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("%s is not a bool: %s", flag, raw)
	}
	return v, true
}

func TestVoiceE2EEAnnounce_RelaysAndReplaysFlags(t *testing.T) {
	for _, flag := range announceFlags {
		t.Run(flag, func(t *testing.T) {
			hub, database, chanID, c1, _, send2 := decodeRoom(t, "flag-relay-"+flag)
			key := validB64Key()
			hub.HandleMessageForTest(c1, e2eeAnnounceMsgFlag(key, flag, true))

			m := waitMsgOfType(send2, "voice_e2ee_announce", waitTimeout)
			if m == nil {
				t.Fatal("peer should receive the announce")
			}
			if v, ok := payloadFlag(t, m, flag); !ok || !v {
				t.Errorf("relayed %s = %v (present=%v), want true", flag, v, ok)
			}

			user3 := seedVoiceOwner(t, database, "flag-relay-user3-"+flag)
			c3, send3 := connectClient(t, hub, user3, 0, 32)
			hub.HandleMessageForTest(c3, voiceJoinMsg(chanID))
			rm := waitMsgOfType(send3, "voice_e2ee_announce", waitTimeout)
			if rm == nil {
				t.Fatal("late joiner should receive the replayed announce")
			}
			if v, ok := payloadFlag(t, rm, flag); !ok || !v {
				t.Errorf("replayed %s = %v (present=%v), want true", flag, v, ok)
			}
		})
	}
}

func TestVoiceE2EEAnnounce_FlagsOnlyForTrue(t *testing.T) {
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
	for _, flag := range announceFlags {
		for _, tc := range tests {
			t.Run(flag+"/"+tc.name, func(t *testing.T) {
				hub, _, _, c1, user1, send2 := decodeRoom(t, "flag-"+flag+"-"+tc.name)
				key := validB64Key()
				hub.HandleMessageForTest(c1, e2eeAnnounceMsgFlag(key, flag, tc.value))

				m := waitMsgOfType(send2, "voice_e2ee_announce", waitTimeout)
				if m == nil {
					t.Fatal("the announce must still be relayed")
				}
				if _, present := payloadFlag(t, m, flag); present {
					t.Errorf("%s must be omitted unless true, relay was %s", flag, m)
				}
				if got := hub.GetClientE2EEPubKeyForTest(user1.ID); got != key {
					t.Errorf("stored key = %q, want %q (key must be accepted)", got, key)
				}
			})
		}
	}
}
