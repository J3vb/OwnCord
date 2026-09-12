package ws

// oc_0428_reconnect_voice_teardown_test.go — regression test for finding
// OC-0428.
//
// handleReconnect's own-voice-room replay supplement only fires when
// h.GetClient(c.userID) still returns the OLD, still-registered *Client — but
// by the time an ORDINARY reconnect reaches here, readPump's own
// disconnect-teardown defer has almost always already run: unregisterNow
// deleted the old entry from h.clients, and handleVoiceLeave tore down the
// voice_states row and broadcast the room's own voice_leave. h.GetClient then
// returns nil, so liveVoiceChID stays 0 and the supplement is skipped
// entirely — in exactly the case (a voice room outside the READ-gated
// allowed set, e.g. a DM voice call after the DM was closed) where the
// resuming client most needs its own voice_leave: it is the only frame that
// runs the client's VOICE_LEAVE dispatch and tears down its local voice UI.
//
// This test seeds the ring buffer with the resuming user's own voice_state
// and voice_leave for a channel outside allowedChannelIDs, WITHOUT
// registering an old *Client (mirroring the post-teardown state an ordinary
// reconnect actually resumes from), and asserts both frames are replayed.
// Before the fix, neither ever reaches the client.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestReconnect_ReplaysOwnVoiceLeaveAfterTeardownWithNoOldClient(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "voice-teardown-resume-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	// A role with no permissions at all: VisibleChannelIDs returns nothing, so
	// the voice room the user was live in cannot be in allowedChannelIDs.
	noPerms, err := database.CreateRole(ctx, "voice-only-teardown", nil, 0, 1)
	if err != nil || noPerms == nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if err := database.UpdateUserRole(ctx, userID, noPerms.ID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	user, err := database.GetUserByID(ctx, userID)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	vcID, err := database.CreateChannel(ctx, "vc-teardown-resume", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	// Precondition: the room really is outside the READ-gated allowed set, so
	// the plain replay filter can never deliver its events.
	allowed, err := hub.computeAllowedChannels(ctx, database, user)
	if err != nil {
		t.Fatalf("computeAllowedChannels: %v", err)
	}
	if allowed[vcID] {
		t.Fatalf("precondition: voice channel %d must not be READ-visible to the resuming user", vcID)
	}

	// Deliberately NOT registering an old *Client for userID: readPump's own
	// disconnect-teardown defer (unregisterNow + handleVoiceLeave) has
	// already run by the time this reconnect arrives, exactly like an
	// ordinary reconnect after the server observed the previous socket
	// close. h.GetClient(userID) must return nil.
	if hub.GetClient(userID) != nil {
		t.Fatalf("precondition: no old client must be registered for user %d", userID)
	}

	rb := hub.ReplayBuffer()
	// Filler below last_seq so the ring buffer's oldest entry sits strictly
	// before last_seq=100 (otherwise EventsSince*/EventsSinceFilteredContent
	// treat the window as "too old" and force a full ready instead of a
	// buffer-tier replay).
	rb.Push(1, 0, fmt.Appendf(nil, `{"seq":1,"type":%q,"payload":{}}`, MsgTypePong))
	// The disconnect teardown's own voice_state/voice_leave for the user's
	// room, tagged with the room's (unreadable) channel ID and the user's own
	// id in the payload — exactly what readPump's defer would have broadcast.
	pushVoice := func(seq uint64, eventType string) {
		rb.Push(seq, vcID, fmt.Appendf(nil, `{"seq":%d,"type":%q,"payload":{"channel_id":%d,"user_id":%d}}`, seq, eventType, vcID, userID))
	}
	pushVoice(101, MsgTypeVoiceState)
	pushVoice(102, MsgTypeVoiceLeaveBC)

	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	defer srv.Close()

	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, dialResp, dialErr := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if dialResp != nil && dialResp.Body != nil {
		_ = dialResp.Body.Close()
	}
	if dialErr != nil {
		t.Fatalf("websocket.Dial: %v", dialErr)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	raw, _ := json.Marshal(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": token, "last_seq": uint64(100)},
	})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	readFrame := func(what string, timeout time.Duration) map[string]any {
		t.Helper()
		readCtx, readCancel := context.WithTimeout(ctx, timeout)
		defer readCancel()
		_, msg, err := conn.Read(readCtx)
		if err != nil {
			t.Fatalf("read %s: %v", what, err)
		}
		var parsed map[string]any
		if err := json.Unmarshal(msg, &parsed); err != nil {
			t.Fatalf("unmarshal %s: %v; raw=%s", what, err, msg)
		}
		return parsed
	}

	if got := readFrame("handshake response", 5*time.Second)["type"]; got != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok (buffer-tier resume), got type=%v", got)
	}

	for i, want := range []string{MsgTypeVoiceState, MsgTypeVoiceLeaveBC} {
		frame := readFrame("replay frame", 2*time.Second)
		got, _ := frame["type"].(string)
		if got != want {
			t.Fatalf("replay frame %d: got type=%q, want %q — the resuming user's own voice teardown event for a room outside their READ-visible set never reached them because no old *Client was registered to source liveVoiceChID from", i, got, want)
		}
	}
}
