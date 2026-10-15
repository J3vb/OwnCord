package ws_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// WP M-4: voice_e2ee_announce carries an optional video_decode list (the video
// codecs the announcer can decode) that the server validates, stores with the
// key and relays to channel peers.

func e2eeAnnounceMsgDecode(publicKey string, videoDecode any) []byte {
	payload := map[string]any{"public_key": publicKey}
	if videoDecode != nil {
		payload["video_decode"] = videoDecode
	}
	raw, _ := json.Marshal(map[string]any{"type": "voice_e2ee_announce", "payload": payload})
	return raw
}

// decodeRoom puts two users in one voice channel and returns the announcer, the
// listening peer's send channel and the hub.
func decodeRoom(t *testing.T, name string) (*ws.Hub, *db.DB, int64, *ws.Client, *db.User, chan []byte) {
	t.Helper()
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-"+name)

	user1 := seedVoiceOwner(t, database, name+"-user1")
	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	user2 := seedVoiceOwner(t, database, name+"-user2")
	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	waitRegistered(t, hub, c1)
	waitRegistered(t, hub, c2)

	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	drainChanTimeout(send1, 30*time.Millisecond)
	drainChan(send2)
	return hub, database, chanID, c1, user1, send2
}

func payloadVideoDecode(t *testing.T, msg []byte) ([]string, bool) {
	t.Helper()
	var env struct {
		Payload map[string]json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	raw, ok := env.Payload["video_decode"]
	if !ok {
		return nil, false
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("video_decode is not a string list: %v", err)
	}
	return out, true
}

func TestVoiceE2EEAnnounce_RelaysVideoDecode(t *testing.T) {
	hub, _, _, c1, _, send2 := decodeRoom(t, "vd-relay")

	want := []string{"vp8", "h264", "vp9"}
	key := validB64Key()
	hub.HandleMessageForTest(c1, e2eeAnnounceMsgDecode(key, want))

	m := waitMsgOfType(send2, "voice_e2ee_announce", waitTimeout)
	if m == nil {
		t.Fatal("peer should receive the announce")
	}
	got, ok := payloadVideoDecode(t, m)
	if !ok || !reflect.DeepEqual(got, want) {
		t.Errorf("relayed video_decode = %v (present=%v), want %v", got, ok, want)
	}
	if pk, _ := extractPayloadField(t, m, "public_key").(string); pk != key {
		t.Errorf("relayed public_key = %q, want %q", pk, key)
	}
}

func TestVoiceE2EEAnnounce_InvalidVideoDecodeDroppedKeyAccepted(t *testing.T) {
	tooMany := []string{"vp8", "h264", "vp9", "h265", "av1", "a1", "a2", "a3", "a4"}
	tests := []struct {
		name string
		list any
	}{
		{"nine entries", tooMany},
		{"seventeen char entry", []string{"vp8", strings.Repeat("a", 17)}},
		{"uppercase", []string{"VP8"}},
		{"bad chars", []string{"vp8", "h.264"}},
		{"empty string entry", []string{"vp8", ""}},
		{"non-ascii", []string{"vp8é"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			hub, _, _, c1, user1, send2 := decodeRoom(t, "vd-bad-"+strings.ReplaceAll(tc.name, " ", ""))
			key := validB64Key()
			hub.HandleMessageForTest(c1, e2eeAnnounceMsgDecode(key, tc.list))

			m := waitMsgOfType(send2, "voice_e2ee_announce", waitTimeout)
			if m == nil {
				t.Fatal("announce with a bad video_decode must still be relayed")
			}
			if _, present := payloadVideoDecode(t, m); present {
				t.Errorf("invalid video_decode must be dropped, relay was %s", m)
			}
			if pk, _ := extractPayloadField(t, m, "public_key").(string); pk != key {
				t.Errorf("relayed public_key = %q, want %q", pk, key)
			}
			if got := hub.GetClientE2EEPubKeyForTest(user1.ID); got != key {
				t.Errorf("stored key = %q, want %q (key must be accepted)", got, key)
			}
		})
	}
}

func TestVoiceE2EEAnnounce_AbsentVideoDecodeOmitted(t *testing.T) {
	hub, _, _, c1, _, send2 := decodeRoom(t, "vd-absent")
	key := validB64Key()
	hub.HandleMessageForTest(c1, e2eeAnnounceMsgDecode(key, nil))

	m := waitMsgOfType(send2, "voice_e2ee_announce", waitTimeout)
	if m == nil {
		t.Fatal("peer should receive the announce")
	}
	if strings.Contains(string(m), "video_decode") {
		t.Errorf("legacy announce must not carry video_decode: %s", m)
	}
	// An explicitly empty list is the same as absent.
	hub.HandleMessageForTest(c1, e2eeAnnounceMsgDecode(key, []string{}))
	m = waitMsgOfType(send2, "voice_e2ee_announce", waitTimeout)
	if m == nil || strings.Contains(string(m), "video_decode") {
		t.Errorf("empty video_decode must be omitted, got %s", m)
	}
}

func TestVoiceE2EEAnnounce_ReannounceWithoutFieldClears(t *testing.T) {
	hub, database, chanID, c1, _, send2 := decodeRoom(t, "vd-clear")
	key := validB64Key()

	hub.HandleMessageForTest(c1, e2eeAnnounceMsgDecode(key, []string{"vp8", "av1"}))
	if m := waitMsgOfType(send2, "voice_e2ee_announce", waitTimeout); m == nil {
		t.Fatal("first announce not relayed")
	}
	hub.HandleMessageForTest(c1, e2eeAnnounceMsgDecode(key, nil))
	m := waitMsgOfType(send2, "voice_e2ee_announce", waitTimeout)
	if m == nil {
		t.Fatal("second announce not relayed")
	}
	if _, present := payloadVideoDecode(t, m); present {
		t.Errorf("announce without the field must not relay a list: %s", m)
	}

	// The stored state must have been cleared too: a late joiner's replay
	// carries no list.
	user3 := seedVoiceOwner(t, database, "vd-clear-user3")
	send3 := make(chan []byte, 32)
	c3 := ws.NewTestClientWithUser(hub, user3, 0, send3)
	hub.Register(c3)
	waitRegistered(t, hub, c3)
	hub.HandleMessageForTest(c3, voiceJoinMsg(chanID))
	rm := waitMsgOfType(send3, "voice_e2ee_announce", waitTimeout)
	if rm == nil {
		t.Fatal("late joiner should receive the replayed announce")
	}
	if _, present := payloadVideoDecode(t, rm); present {
		t.Errorf("replay after a clearing re-announce must not carry a list: %s", rm)
	}
}

func TestVoiceE2EEAnnounce_ReplayedVideoDecodeToLateJoiner(t *testing.T) {
	hub, database, chanID, c1, _, _ := decodeRoom(t, "vd-late")
	want := []string{"vp8", "h264"}
	hub.HandleMessageForTest(c1, e2eeAnnounceMsgDecode(validB64Key(), want))

	user3 := seedVoiceOwner(t, database, "vd-late-user3")
	send3 := make(chan []byte, 32)
	c3 := ws.NewTestClientWithUser(hub, user3, 0, send3)
	hub.Register(c3)
	waitRegistered(t, hub, c3)
	hub.HandleMessageForTest(c3, voiceJoinMsg(chanID))
	rm := waitMsgOfType(send3, "voice_e2ee_announce", waitTimeout)
	if rm == nil {
		t.Fatal("late joiner should receive the replayed announce")
	}
	if got, _ := payloadVideoDecode(t, rm); !reflect.DeepEqual(got, want) {
		t.Errorf("replayed video_decode = %v, want %v", got, want)
	}
}
