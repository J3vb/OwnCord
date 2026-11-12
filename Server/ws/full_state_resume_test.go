package ws

// full_state_resume_test.go — a client that could not read a sequenced frame asks for the full
// ready with full_state while keeping its last_seq. The server must skip replay yet keep treating
// the dial as a resume of the same session, so a live voice call survives it. last_seq 0 would
// read as a reload and end the call.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// dialAuthFullState dials and sends an auth frame with last_seq and full_state.
func dialAuthFullState(t *testing.T, ctx context.Context, srvURL, token string, lastSeq uint64, fullState bool) *websocket.Conn {
	t.Helper()
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, dialResp, dialErr := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srvURL, "http"), nil)
	if dialResp != nil && dialResp.Body != nil {
		_ = dialResp.Body.Close()
	}
	if dialErr != nil {
		t.Fatalf("websocket.Dial: %v", dialErr)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	payload := map[string]any{"token": token, "last_seq": lastSeq}
	if fullState {
		payload["full_state"] = true
	}
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": payload})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	return conn
}

// readReplaySource reads auth_ok and returns its replay_source.
func readReplaySource(t *testing.T, ctx context.Context, conn *websocket.Conn) string {
	t.Helper()
	typ, raw := readFrameType(t, ctx, conn)
	if typ != MsgTypeAuthOK {
		t.Fatalf("first frame = %q, want auth_ok", typ)
	}
	var frame struct {
		Payload struct {
			ReplaySource string `json:"replay_source"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatalf("unmarshal auth_ok: %v", err)
	}
	return frame.Payload.ReplaySource
}

// fullStateVoiceRig connects one device, puts it in a settled voice call and leaves a replay
// window a resume at last_seq 99 could be served from.
func fullStateVoiceRig(t *testing.T, name string) (rig *serveRig, uid, vcID int64, token string) {
	t.Helper()
	ctx := context.Background()
	rig = newServeRig(t)
	user, token := rig.seedOwner(t, name)
	uid = user.ID
	textID := mustCreateChannel(t, rig.db, name+"-text", "text")
	vcID = mustCreateChannel(t, rig.db, name+"-vc", "voice")
	rig.handshake(t, ctx, token, 0, 0)
	old := waitForRegisteredClient(t, rig.hub, uid)
	mustJoinVoice(t, rig.db, uid, vcID)
	vs, err := rig.db.GetVoiceState(ctx, uid)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	old.voice.setState(vcID, vs.JoinedAt)
	old.voice.markCompletedIfMatch(vcID, vs.JoinedAt)
	pushReplayWindow(rig.hub, textID)
	rig.hub.SeedSeq(100)
	return rig, uid, vcID, token
}

func TestAuthFullState_ResumeSendsFullReadyAndKeepsVoice(t *testing.T) {
	rig, uid, vcID, token := fullStateVoiceRig(t, "full-state")
	ctx := context.Background()

	conn := dialAuthFullState(t, ctx, rig.srv.URL, token, 99, true)
	if got := readReplaySource(t, ctx, conn); got != "none" {
		t.Fatalf("replay_source = %q, want none (full ready)", got)
	}
	expectFrame(t, ctx, conn, MsgTypeReady, " (full_state resume)")

	vs, err := rig.db.GetVoiceState(ctx, uid)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if vs == nil || vs.ChannelID != vcID {
		t.Fatalf("voice_states row = %+v, want the call in channel %d kept", vs, vcID)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		if c := rig.newestClient(uid); c != nil && c.voice.channel() == vcID {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the resumed connection never inherited the voice session")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Without the flag the same resume replays from the buffer, so the test above proves the flag.
func TestAuthFullState_AbsentFlagReplays(t *testing.T) {
	rig, _, _, token := fullStateVoiceRig(t, "no-full-state")
	ctx := context.Background()

	conn := dialAuthFullState(t, ctx, rig.srv.URL, token, 99, false)
	if got := readReplaySource(t, ctx, conn); got != "buffer" {
		t.Fatalf("replay_source = %q, want buffer", got)
	}
}
