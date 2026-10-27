package ws

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// drainVoiceStateBroadcasts empties h.broadcast and returns the voice_state
// payloads queued on it.
func drainVoiceStateBroadcasts(t *testing.T, h *Hub) []map[string]any {
	t.Helper()
	var states []map[string]any
	for {
		select {
		case bm := <-h.broadcast:
			var env struct {
				Type    string         `json:"type"`
				Payload map[string]any `json:"payload"`
			}
			if err := json.Unmarshal(bm.msg, &env); err != nil {
				t.Fatalf("broadcast is not JSON: %v", err)
			}
			if env.Type == "voice_state" {
				states = append(states, env.Payload)
			}
		default:
			return states
		}
	}
}

func setVoiceMediaFlags(t *testing.T, h *Hub, userID int64, camera, screenshare bool) {
	t.Helper()
	ctx := context.Background()
	if err := h.voice.SetCamera(ctx, userID, camera); err != nil {
		t.Fatal(err)
	}
	if err := h.voice.SetScreenshare(ctx, userID, screenshare); err != nil {
		t.Fatal(err)
	}
}

// A user who loses SHARE_SCREEN and USE_VIDEO mid-call keeps their seat, but
// the permission sweep clears both media flags and tells everyone once.
func TestVoiceMediaFlags_SweepClearsRevokedFlags(t *testing.T) {
	ctx := context.Background()
	_, database := tokenRefreshDeps(t)
	base := permissions.ReadMessages | permissions.ConnectVoice | permissions.SpeakVoice
	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, base|permissions.UseVideo|permissions.ShareScreen)
	h := newTestHubWith(t, HubOptions{DB: database})
	state, err := h.voice.State(ctx, 1)
	if err != nil || state == nil {
		t.Fatalf("state: %v", err)
	}
	c := NewTestClient(h, 1, make(chan []byte, 8))
	c.voice.setState(100, state.JoinedAt)
	h.clients[1] = []*Client{c}
	setVoiceMediaFlags(t, h, 1, true, true)

	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, base)
	h.sweepStaleVoiceEvictRevoked(ctx)

	after, err := h.voice.State(ctx, 1)
	if err != nil || after == nil {
		t.Fatalf("state after sweep: %v", err)
	}
	if after.Camera || after.Screenshare {
		t.Fatalf("camera=%v screenshare=%v after the sweep, want both cleared", after.Camera, after.Screenshare)
	}
	if c.voice.channel() != 100 {
		t.Fatal("losing media permissions must not evict a user who may still join")
	}
	states := drainVoiceStateBroadcasts(t, h)
	if len(states) != 1 {
		t.Fatalf("got %d voice_state broadcasts, want 1", len(states))
	}
	if states[0]["camera"] != false || states[0]["screenshare"] != false {
		t.Fatalf("broadcast voice_state = %v, want camera and screenshare false", states[0])
	}

	h.sweepStaleVoiceEvictRevoked(ctx)
	if again := drainVoiceStateBroadcasts(t, h); len(again) != 0 {
		t.Fatalf("a second sweep re-broadcast %d voice_state frames, want 0", len(again))
	}
}

// Only the flag whose permission went is cleared; a still-permitted stream,
// and a user whose flags are already off, produce no broadcast.
func TestVoiceMediaFlags_SweepClearsOnlyRevokedFlag(t *testing.T) {
	ctx := context.Background()
	_, database := tokenRefreshDeps(t)
	base := permissions.ReadMessages | permissions.ConnectVoice | permissions.UseVideo
	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, base|permissions.ShareScreen)
	h := newTestHubWith(t, HubOptions{DB: database})
	state, err := h.voice.State(ctx, 1)
	if err != nil || state == nil {
		t.Fatalf("state: %v", err)
	}
	c := NewTestClient(h, 1, make(chan []byte, 8))
	c.voice.setState(100, state.JoinedAt)
	h.clients[1] = []*Client{c}

	setVoiceMediaFlags(t, h, 1, true, false)
	h.sweepStaleVoiceEvictRevoked(ctx)
	if got := drainVoiceStateBroadcasts(t, h); len(got) != 0 {
		t.Fatalf("permitted camera produced %d voice_state broadcasts, want 0", len(got))
	}

	setVoiceMediaFlags(t, h, 1, true, true)
	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, base)
	h.sweepStaleVoiceEvictRevoked(ctx)
	after, err := h.voice.State(ctx, 1)
	if err != nil || after == nil {
		t.Fatalf("state after sweep: %v", err)
	}
	if !after.Camera || after.Screenshare {
		t.Fatalf("camera=%v screenshare=%v, want camera kept and screenshare cleared", after.Camera, after.Screenshare)
	}
	if got := drainVoiceStateBroadcasts(t, h); len(got) != 1 {
		t.Fatalf("got %d voice_state broadcasts, want 1", len(got))
	}
}

// A membership that changed after the sweep's snapshot is left alone: the
// clear is tied to the session the permission check looked at.
func TestVoiceMediaFlags_StaleSessionIsNotTouched(t *testing.T) {
	ctx := context.Background()
	_, database := tokenRefreshDeps(t)
	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, permissions.ReadMessages|permissions.ConnectVoice)
	h := newTestHubWith(t, HubOptions{DB: database})
	state, err := h.voice.State(ctx, 1)
	if err != nil || state == nil {
		t.Fatalf("state: %v", err)
	}
	c := NewTestClient(h, 1, make(chan []byte, 8))
	c.voice.setState(100, "an-older-session")
	h.clients[1] = []*Client{c}
	setVoiceMediaFlags(t, h, 1, true, true)

	h.clearRevokedVoiceMedia(ctx, c, 100)

	after, err := h.voice.State(ctx, 1)
	if err != nil || after == nil {
		t.Fatalf("state: %v", err)
	}
	if !after.Camera || !after.Screenshare {
		t.Fatal("flags of a session the check did not look at were cleared")
	}
	if got := drainVoiceStateBroadcasts(t, h); len(got) != 0 {
		t.Fatalf("got %d voice_state broadcasts, want 0", len(got))
	}
}
