package ws

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// stallingVoiceStore commits through the real store and then sleeps past the
// per-frame deadline, modelling a deadline that expires between a voice flag's
// commit and the handler's state read.
type stallingVoiceStore struct {
	VoiceStore
	stall time.Duration
}

func (s stallingVoiceStore) SetSelfMute(ctx context.Context, userID int64, muted bool) error {
	err := s.VoiceStore.SetSelfMute(ctx, userID, muted)
	time.Sleep(s.stall)
	return err
}

func (s stallingVoiceStore) SetCamera(ctx context.Context, userID int64, on bool) error {
	err := s.VoiceStore.SetCamera(ctx, userID, on)
	time.Sleep(s.stall)
	return err
}

func (s stallingVoiceStore) ReserveCamera(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error) {
	ok, err := s.VoiceStore.ReserveCamera(ctx, userID, channelID, maxVideo)
	time.Sleep(s.stall)
	return ok, err
}

// stallVoiceDeps swaps the Voice dependency of typ's registered handler.
func stallVoiceDeps(t *testing.T, h *Hub, typ string, stall time.Duration) {
	t.Helper()
	entry, ok := h.registry.handlersV2[typ]
	if !ok {
		t.Fatalf("%s not registered", typ)
	}
	d, ok := entry.deps.(VoiceDeps)
	if !ok {
		t.Fatalf("%s deps are %T, want VoiceDeps", typ, entry.deps)
	}
	d.Voice = stallingVoiceStore{VoiceStore: d.Voice, stall: stall}
	entry.deps = d
	h.registry.handlersV2[typ] = entry
}

// drainFrames returns the (type, payload) of every frame queued on c.
func drainFrames(c *Client) []map[string]any {
	var out []map[string]any
	for {
		select {
		case raw := <-c.send:
			var env map[string]any
			if json.Unmarshal(raw, &env) == nil {
				out = append(out, env)
			}
		default:
			return out
		}
	}
}

// A voice flag that commits and then outlives the deadline is acknowledged
// with the normal voice_state broadcast, never REQUEST_TIMEOUT: the row is
// committed, so the client must not roll it back.
func TestHandleMessage_VoiceFlagDeadlineAfterCommitStillBroadcasts(t *testing.T) {
	cases := []struct {
		name, typ string
		payload   map[string]any
		flag      string
	}{
		{"self mute", "voice_mute", map[string]any{"muted": true}, "muted"},
		{"camera reserve", "voice_camera", map[string]any{"enabled": true}, "camera"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, database, c, chID := newVoiceTraceHub(t, "dl-"+tc.typ)
			go h.Run()
			joinVoiceForTrace(t, h, c, chID)
			drainFrames(c)

			SetCommandDeadlineForTest(t, 50*time.Millisecond)
			stallVoiceDeps(t, h, tc.typ, 150*time.Millisecond)
			h.handleMessage(c, voiceFrame(t, tc.typ, "req-"+tc.typ, tc.payload))

			var sawState bool
			var stateFlag any
			deadline := time.Now().Add(2 * time.Second)
			for !sawState && time.Now().Before(deadline) {
				for _, f := range drainFrames(c) {
					if f["type"] == "error" {
						t.Fatalf("got an error frame after a committed %s: %v", tc.typ, f)
					}
					if f["type"] == "voice_state" {
						sawState = true
						p, _ := f["payload"].(map[string]any)
						stateFlag = p[tc.flag]
					}
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !sawState {
				t.Fatalf("no voice_state broadcast after %s", tc.typ)
			}
			stored, err := h.voice.State(context.Background(), c.userID)
			if err != nil || stored == nil {
				t.Fatalf("State: %v %v", stored, err)
			}
			committed := stored.Muted
			if tc.flag == "camera" {
				committed = stored.Camera
			}
			if !committed || stateFlag != true {
				t.Errorf("committed %s = %v, broadcast = %v; want both true", tc.flag, committed, stateFlag)
			}
			_ = database
		})
	}
}

// A timed-out lookup is not a refusal: the LeaveVoice a handler attaches to a
// failed voice_token_refresh gate read must not evict the user, who is told to
// retry instead.
func TestHandleMessage_DeadlineDoesNotEvictFromVoice(t *testing.T) {
	h, _, c, chID := newVoiceTraceHub(t, "dl-evict")
	joinVoiceForTrace(t, h, c, chID)
	drainFrames(c)

	SetCommandDeadlineForTest(t, 50*time.Millisecond)
	h.ReplaceHandlerForTest("voice_token_refresh", func(ctx context.Context) Result {
		<-ctx.Done()
		return Result{
			Error:            ClientError{Code: ErrCodeForbidden, Message: "missing permission to join this voice channel"},
			LeaveVoice:       true,
			LeaveVoiceReason: voiceLeaveReasonTokenRefresh,
		}
	})
	h.handleMessage(c, voiceFrame(t, "voice_token_refresh", "req-refresh", map[string]any{}))

	var code any
	for _, f := range drainFrames(c) {
		if f["type"] == "error" {
			p, _ := f["payload"].(map[string]any)
			code = p["code"]
		}
	}
	if code != ErrCodeRequestTimeout {
		t.Errorf("error code = %v, want %s", code, ErrCodeRequestTimeout)
	}
	if got := c.getVoiceChID(); got != chID {
		t.Errorf("voice channel after timed-out refresh = %d, want %d (still joined)", got, chID)
	}
}
