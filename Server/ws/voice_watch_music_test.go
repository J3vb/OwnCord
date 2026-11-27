package ws

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func runWatchMusic(uid, chID, musicID int64) Result {
	return handleVoiceWatchV2(context.Background(), VoiceWatchCmd{userID: uid, MusicID: musicID},
		ClientInfo{UserID: uid, VoiceChannelID: chID}, VoiceDeps{})
}

func TestVoiceWatchV2_MusicIDValidation(t *testing.T) {
	cases := []struct {
		name  string
		music int64
		want  int64
	}{
		{"another member", 8, 8},
		{"absent", 0, 0},
		{"negative", -3, 0},
		{"own id", 3, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := runWatchMusic(3, 9, tc.music)
			if r.Error != nil || r.SetVoiceWatching == nil {
				t.Fatalf("result %+v", r)
			}
			if got := r.SetVoiceWatching.musicID; got != tc.want {
				t.Errorf("musicID = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestVoiceWatchCmd_ParsesMusicID(t *testing.T) {
	build := commandConstructors[MsgTypeVoiceWatch]
	for raw, want := range map[string]int64{
		`{"user_ids":[2],"music_id":7}`: 7,
		`{"user_ids":[2]}`:              0, // an older client sends none
	} {
		cmd, err := build(1, "", json.RawMessage(raw))
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if got := cmd.(VoiceWatchCmd).MusicID; got != want {
			t.Errorf("%s: MusicID = %d, want %d", raw, got, want)
		}
	}
}

type musicFrame struct {
	UserID  int64
	UserIDs []int64
	MusicID int64
}

func musicFrames(ch chan []byte) []musicFrame {
	var out []musicFrame
	for _, m := range drainChan(ch, 100*time.Millisecond) {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				UserID  int64   `json:"user_id"`
				UserIDs []int64 `json:"user_ids"`
				MusicID int64   `json:"music_id"`
			} `json:"payload"`
		}
		if json.Unmarshal(m, &env) != nil || env.Type != MsgTypeVoiceWatching {
			continue
		}
		out = append(out, musicFrame{env.Payload.UserID, env.Payload.UserIDs, env.Payload.MusicID})
	}
	return out
}

func applyWatchMusic(h *Hub, c *Client, chID int64, ids []int64, musicID int64) {
	h.handleMessageApply(context.Background(), context.Background(), c, envelope{Type: MsgTypeVoiceWatch}, "",
		Result{SetVoiceWatching: &voiceWatchSet{chID: chID, ids: ids, musicID: musicID}}, time.Now())
}

func TestVoiceWatch_RelaysMusicIDWithEmptySet(t *testing.T) {
	h := newEmitTestHub()
	a, _ := voiceWatchClient(h, 1, 50)
	_, bSend := voiceWatchClient(h, 2, 50)

	applyWatchMusic(h, a, 50, nil, 2)

	if got := a.voice.listeningCopy(); got != 2 {
		t.Errorf("stored music id = %d, want 2", got)
	}
	frames := musicFrames(bSend)
	want := []musicFrame{{UserID: 1, UserIDs: []int64{}, MusicID: 2}}
	if !reflect.DeepEqual(frames, want) {
		t.Errorf("frames = %+v, want %+v", frames, want)
	}
}

// Edge case 1: a joiner gets a member who only listens to music.
func TestSendVoicePeerWatching_MusicOnlyPeer(t *testing.T) {
	h := newEmitTestHub()
	joiner, jSend := voiceWatchClient(h, 1, 50)
	p2, _ := voiceWatchClient(h, 2, 50)
	p3, _ := voiceWatchClient(h, 3, 50)
	voiceWatchClient(h, 4, 50) // nothing
	p5, _ := voiceWatchClient(h, 5, 60)
	p2.voice.setWatchingIfChannel(50, nil, 9)
	p3.voice.setWatchingIfChannel(50, []int64{1}, 9)
	p5.voice.setWatchingIfChannel(60, nil, 9)

	h.sendVoicePeerWatching(joiner, 50)

	got := map[int64]musicFrame{}
	for _, f := range musicFrames(jSend) {
		got[f.UserID] = f
	}
	if len(got) != 2 || got[2].MusicID != 9 || got[2].UserIDs == nil || got[3].MusicID != 9 ||
		!reflect.DeepEqual(got[3].UserIDs, []int64{1}) {
		t.Errorf("frames = %+v", got)
	}
}

func TestMusicID_ClearedOnLeaveAndNewJoin(t *testing.T) {
	var s voiceSlot
	s.setState(5, "tok")
	s.setWatchingIfChannel(5, nil, 4)
	if snap := s.clearSnap(); snap.musicID != 4 {
		t.Errorf("snapshot lost the music id: %d", snap.musicID)
	}
	if got := s.listeningCopy(); got != 0 {
		t.Errorf("leave kept %d", got)
	}
	s.setState(5, "tok2")
	s.setWatchingIfChannel(5, nil, 4)
	s.setState(5, "tok3")
	if got := s.listeningCopy(); got != 0 {
		t.Errorf("new join instance kept %d", got)
	}
}

func TestMusicID_NotStoredForOtherChannel(t *testing.T) {
	h := newEmitTestHub()
	a, _ := voiceWatchClient(h, 1, 50)
	_, oldSend := voiceWatchClient(h, 2, 50)
	a.voice.setState(60, "tok") // channel change after the handler decided against 50

	applyWatchMusic(h, a, 50, nil, 2)

	if got := a.voice.listeningCopy(); got != 0 {
		t.Errorf("stale frame stored music id %d", got)
	}
	if f := musicFrames(oldSend); len(f) != 0 {
		t.Errorf("old channel got %+v", f)
	}
	if _, music := a.voice.watchStateIfChannel(50); music != 0 {
		t.Errorf("watchStateIfChannel(50) music = %d", music)
	}
}
