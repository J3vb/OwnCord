package ws

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

// WP M-4 internal tests: the video decode list rides with the E2EE key through
// every path the key takes (late-joiner replay, resume, grace window).

func TestSanitizeVideoDecode(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want []string
	}{
		{"nil", nil, nil},
		{"empty", []string{}, nil},
		{"valid", []string{"vp8", "h264", "vp9", "h265", "av1"}, []string{"vp8", "h264", "vp9", "h265", "av1"}},
		{"eight entries ok", []string{"a", "b", "c", "d", "e", "f", "g", "h"}, []string{"a", "b", "c", "d", "e", "f", "g", "h"}},
		{"nine entries", []string{"a", "b", "c", "d", "e", "f", "g", "h", "i"}, nil},
		{"sixteen chars ok", []string{strings.Repeat("a", 16)}, []string{strings.Repeat("a", 16)}},
		{"seventeen chars", []string{strings.Repeat("a", 17)}, nil},
		{"empty entry", []string{"vp8", ""}, nil},
		{"uppercase", []string{"VP8"}, nil},
		{"punctuation", []string{"h.264"}, nil},
		{"space", []string{"vp 8"}, nil},
		{"non-ascii", []string{"vp8é"}, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeVideoDecode(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("sanitizeVideoDecode(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestSanitizeVideoDecode_DoesNotAliasInput(t *testing.T) {
	in := []string{"vp8", "h264"}
	out := sanitizeVideoDecode(in)
	in[0] = "zzz"
	if out[0] != "vp8" {
		t.Errorf("output aliases input: out[0] = %q", out[0])
	}
}

func TestE2EEAnnounce_GetterReturnsCopy(t *testing.T) {
	c := NewTestClient(newEmitTestHub(), 1, make(chan []byte, 1))
	c.setE2EEAnnounce(e2eeAnnounce{key: "k", videoDecode: []string{"vp8"}})
	got := c.getE2EEAnnounce()
	got.videoDecode[0] = "mutated"
	if again := c.getE2EEAnnounce(); again.videoDecode[0] != "vp8" {
		t.Errorf("caller mutated stored state: %v", again.videoDecode)
	}
}

func TestBuildVoiceE2EEAnnounce_LegacyByteIdentical(t *testing.T) {
	got := string(buildVoiceE2EEAnnounce(7, e2eeAnnounce{key: "k", sig: "s"}))
	want := `{"type":"voice_e2ee_announce","payload":{"user_id":7,"public_key":"k","signature":"s"}}`
	if got != want {
		t.Errorf("legacy announce changed:\n got %s\nwant %s", got, want)
	}
	got = string(buildVoiceE2EEAnnounce(7, e2eeAnnounce{key: "k", sig: "s", videoDecode: []string{"vp8"}}))
	want = `{"type":"voice_e2ee_announce","payload":{"user_id":7,"public_key":"k","signature":"s","video_decode":["vp8"]}}`
	if got != want {
		t.Errorf("announce with list:\n got %s\nwant %s", got, want)
	}
}

// announceVideoDecode returns the video_decode list of the announce for userID
// found in msgs, and whether such an announce was seen.
func announceVideoDecode(t *testing.T, msgs [][]byte, userID int64) ([]string, bool) {
	t.Helper()
	for _, m := range msgs {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				UserID      int64    `json:"user_id"`
				VideoDecode []string `json:"video_decode"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(m, &env); err != nil {
			t.Fatalf("unmarshal %s: %v", m, err)
		}
		if env.Type == MsgTypeVoiceE2EEAnnounceBC && env.Payload.UserID == userID {
			return env.Payload.VideoDecode, true
		}
	}
	return nil, false
}

func TestSendVoicePeerKeys_IncludesVideoDecode(t *testing.T) {
	h, c1, c2 := setupVoiceRoom(t)
	want := []string{"vp8", "h264", "vp9"}
	c1.setE2EEAnnounce(e2eeAnnounce{key: "peer-pub", sig: "peer-sig", videoDecode: want})

	h.sendVoicePeerKeys(c2, 5)

	got, seen := announceVideoDecode(t, drainChanTimeoutInternal(c2.send), 1)
	if !seen {
		t.Fatal("late joiner never received the peer's announce")
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("replayed video_decode = %v, want %v", got, want)
	}
}

func drainChanTimeoutInternal(ch chan []byte) [][]byte {
	var out [][]byte
	for {
		select {
		case m := <-ch:
			out = append(out, m)
		case <-time.After(20 * time.Millisecond):
			return out
		}
	}
}

func TestResume_ReannounceCarriesVideoDecode(t *testing.T) {
	h, c1, c2 := setupVoiceRoom(t)
	want := []string{"vp8", "h264"}
	c1.setE2EEAnnounce(e2eeAnnounce{key: "user-pub", sig: "user-sig", videoDecode: want})
	h.pubsub.Subscribe(c2, VoiceTopic(5))

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1
	h.registerNow(replacement, map[int64]bool{5: true})

	if got := replacement.getE2EEAnnounce(); !reflect.DeepEqual(got.videoDecode, want) {
		t.Errorf("transferred video decode = %v, want %v", got.videoDecode, want)
	}
	got, seen := announceVideoDecode(t, drainChanTimeoutInternal(c2.send), 1)
	if !seen {
		t.Fatal("peer never saw the resumed client's re-announce")
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("re-announced video_decode = %v, want %v", got, want)
	}
}

func TestVoiceGrace_CarriesVideoDecode(t *testing.T) {
	prev := voiceGraceWindow
	voiceGraceWindow = time.Minute
	t.Cleanup(func() { voiceGraceWindow = prev })

	h, c1, _ := setupVoiceRoom(t)
	want := []string{"vp8", "av1"}
	c1.setE2EEAnnounce(e2eeAnnounce{key: "user-pub", sig: "user-sig", videoDecode: want})

	h.leaveVoiceOnDisconnect(t.Context(), c1, voiceLeaveReasonDisconnect)
	t.Cleanup(func() { h.voiceGrace.take(1) })
	if h.voiceGrace.get(1) == nil {
		t.Fatal("membership was not parked in the grace window")
	}
	if got := c1.getE2EEAnnounce(); got.key != "" || got.videoDecode != nil {
		t.Errorf("departing client kept its announce: %+v", got)
	}

	resumed := NewTestClient(h, 1, make(chan []byte, 8))
	resumed.lastSeq = 1
	if ch := h.inheritParkedVoice(resumed); ch != 5 {
		t.Fatalf("inheritParkedVoice = %d, want 5", ch)
	}
	got := resumed.getE2EEAnnounce()
	if got.key != "user-pub" || got.sig != "user-sig" || !reflect.DeepEqual(got.videoDecode, want) {
		t.Errorf("restored announce = %+v, want key/sig/list %v", got, want)
	}
}
