package ws

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

func runSpeak(deps VoiceDeps, uid, chID int64, speaking *bool) Result {
	return handleVoiceSpeakV2(context.Background(), VoiceSpeakCmd{userID: uid, Speaking: speaking},
		ClientInfo{UserID: uid, VoiceChannelID: chID}, deps)
}

func TestVoiceSpeakV2_RelaysEachState(t *testing.T) {
	for name, speaking := range map[string]*bool{"lit": new(true), "dark": new(false), "no verdict": nil} {
		r := runSpeak(VoiceDeps{}, 3, 9, speaking)
		if r.Error != nil || len(r.Events) != 0 || r.Reply != nil {
			t.Errorf("%s: the handler must only ask for the relay, got %+v", name, r)
		}
		relay := r.RelayVoiceSpeaking
		if relay == nil || relay.chID != 9 || relay.speaking != speaking {
			t.Errorf("%s: RelayVoiceSpeaking = %+v, want channel 9 and the sender's state", name, relay)
		}
	}
}

func TestVoiceSpeakV2_NotInVoiceIsDroppedSilently(t *testing.T) {
	r := runSpeak(VoiceDeps{}, 1, 0, new(true))
	if r.Error != nil || r.RelayVoiceSpeaking != nil {
		t.Errorf("result = %+v, want nothing relayed and no error", r)
	}
}

func TestVoiceSpeakV2_OverBudgetIsDroppedSilently(t *testing.T) {
	deps := VoiceDeps{Limiter: auth.NewRateLimiter()}
	for i := range voiceSpeakRateLimit {
		if r := runSpeak(deps, 1, 5, new(true)); r.RelayVoiceSpeaking == nil {
			t.Fatalf("frame %d within the budget was dropped", i)
		}
	}
	r := runSpeak(deps, 1, 5, new(true))
	if r.Error != nil || r.RelayVoiceSpeaking != nil {
		t.Errorf("over budget: result = %+v, want nothing relayed and no error", r)
	}
	if r := runSpeak(deps, 2, 5, new(true)); r.RelayVoiceSpeaking == nil {
		t.Error("another user shares the budget")
	}
}

// A frame from a client that is in no voice channel must not spend the budget of the call
// it joins next.
func TestVoiceSpeakV2_NotInVoiceSpendsNoBudget(t *testing.T) {
	deps := VoiceDeps{Limiter: auth.NewRateLimiter()}
	for range voiceSpeakRateLimit {
		runSpeak(deps, 1, 0, new(true))
	}
	if r := runSpeak(deps, 1, 5, new(true)); r.RelayVoiceSpeaking == nil {
		t.Error("frames sent outside a voice channel used up the budget")
	}
}

func TestBuildVoiceSpeaking_Shape(t *testing.T) {
	for want, speaking := range map[string]*bool{"true": new(true), "false": new(false), "null": nil} {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				UserID   int64           `json:"user_id"`
				Speaking json.RawMessage `json:"speaking"`
			} `json:"payload"`
		}
		raw := buildVoiceSpeaking(7, speaking)
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		if env.Type != "voice_speaking" || env.Payload.UserID != 7 || string(env.Payload.Speaking) != want {
			t.Errorf("frame %s, want speaking %s", raw, want)
		}
	}
}

type speakingFrame struct {
	UserID   int64 `json:"user_id"`
	Speaking *bool `json:"speaking"`
}

func speakingFrames(t *testing.T, ch chan []byte) []speakingFrame {
	t.Helper()
	var out []speakingFrame
	for _, m := range drainChan(ch, 100*time.Millisecond) {
		var env struct {
			Type    string        `json:"type"`
			Payload speakingFrame `json:"payload"`
		}
		if json.Unmarshal(m, &env) != nil || env.Type != MsgTypeVoiceSpeaking {
			continue
		}
		out = append(out, env.Payload)
	}
	return out
}

func applySpeak(h *Hub, c *Client, chID int64, speaking *bool) {
	h.handleMessageApply(context.Background(), context.Background(), c, envelope{Type: MsgTypeVoiceSpeak}, "",
		Result{RelayVoiceSpeaking: &voiceSpeakingRelay{chID: chID, speaking: speaking}}, time.Now())
}

func TestVoiceSpeak_RelaysToChannelExceptSender(t *testing.T) {
	h := newEmitTestHub()
	a, aSend := voiceWatchClient(h, 1, 50)
	_, bSend := voiceWatchClient(h, 2, 50)
	_, otherSend := voiceWatchClient(h, 3, 60)

	applySpeak(h, a, 50, new(true))

	frames := speakingFrames(t, bSend)
	if len(frames) != 1 || frames[0].UserID != 1 || frames[0].Speaking == nil || !*frames[0].Speaking {
		t.Errorf("peer frames = %+v, want one lit ring for user 1", frames)
	}
	if f := speakingFrames(t, aSend); len(f) != 0 {
		t.Errorf("sender got its own frame: %+v", f)
	}
	if f := speakingFrames(t, otherSend); len(f) != 0 {
		t.Errorf("other channel got a frame: %+v", f)
	}
}

// Two frames of one sender racing a channel switch: the one decided against the old
// channel reaches neither channel.
func TestVoiceSpeak_StaleChannelNotRelayed(t *testing.T) {
	h := newEmitTestHub()
	a, _ := voiceWatchClient(h, 1, 50)
	_, oldSend := voiceWatchClient(h, 2, 50)
	_, newSend := voiceWatchClient(h, 3, 60)

	a.voice.setState(60, "tok")
	applySpeak(h, a, 50, new(true))

	if f := speakingFrames(t, oldSend); len(f) != 0 {
		t.Errorf("old channel got a frame: %+v", f)
	}
	if f := speakingFrames(t, newSend); len(f) != 0 {
		t.Errorf("new channel got a frame: %+v", f)
	}
}

func TestVoiceSpeak_LeftVoiceNotRelayed(t *testing.T) {
	h := newEmitTestHub()
	a, _ := voiceWatchClient(h, 1, 50)
	_, bSend := voiceWatchClient(h, 2, 50)

	a.voice.clearState()
	applySpeak(h, a, 50, new(true))

	if f := speakingFrames(t, bSend); len(f) != 0 {
		t.Errorf("a sender that left still lit its ring: %+v", f)
	}
}

func TestParseVoiceSpeak(t *testing.T) {
	parse := commandConstructors[MsgTypeVoiceSpeak]
	for raw, want := range map[string]*bool{
		`{"speaking":true}`:  new(true),
		`{"speaking":false}`: new(false),
		`{"speaking":null}`:  nil,
		`{}`:                 nil,
	} {
		cmd, err := parse(4, "", json.RawMessage(raw))
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		got := cmd.(VoiceSpeakCmd)
		if got.UserID() != 4 || (got.Speaking == nil) != (want == nil) || (want != nil && *got.Speaking != *want) {
			t.Errorf("%s parsed to %+v", raw, got)
		}
	}
	for _, raw := range []string{`{"speaking":"yes"}`, `{"speaking":1}`, `[]`} {
		if _, err := parse(4, "", json.RawMessage(raw)); err == nil {
			t.Errorf("%s was accepted", raw)
		}
	}
}
