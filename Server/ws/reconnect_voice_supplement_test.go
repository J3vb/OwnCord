package ws

// reconnect_voice_supplement_test.go — regression test for finding v107.
//
// Voice membership is gated on CONNECT_VOICE alone (voice_join.go), and the
// live fan-out path deliberately unions the READ audience with the room's
// current participants for exactly that reason (broadcastVoiceEvent). Replay,
// though, filtered purely on computeAllowedChannels — READ-visible channels
// plus open DMs — so a resuming participant silently missed the buffered
// voice_state/voice_leave for the very room they were still in, including a
// key holder's departure, which is the E2EE stall the live-path union exists
// to prevent.
//
// The supplement must not widen what the client can read: the room stays out
// of allowedChannelIDs (that map also gates the ChannelTopic subscription in
// registerNow), so this test asserts the room's chat frames are still filtered
// out while its voice frames come through.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/owncord/server/auth"
)

func TestReconnect_ReplaysOwnVoiceRoomOutsideReadableChannels(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "voice-resume-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	// A role with no permissions at all: VisibleChannelIDs returns nothing, so
	// the voice room the user is live in cannot be in allowedChannelIDs.
	noPerms, err := database.CreateRole(ctx, "voice-only", nil, 0, 1)
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

	vcID, err := database.CreateChannel(ctx, "vc-resume", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, userID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vs, err := database.GetVoiceState(ctx, userID)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := NewHub(database, auth.NewRateLimiter(), nil)
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

	// The still-registered previous connection is what carries the live voice
	// session across the resume (registerNow transfers it when lastSeq > 0).
	oldClient := NewTestClient(hub, userID, make(chan []byte, 64))
	oldClient.user = user
	oldClient.setVoiceState(vcID, vs.JoinedAt)
	hub.mu.Lock()
	hub.clients[userID] = oldClient
	hub.mu.Unlock()

	// Ring buffer: everything is scoped to the unreadable voice room. seq 99
	// only exists so last_seq=100 sits strictly inside the buffer window.
	rb := hub.ReplayBuffer()
	push := func(seq uint64, eventType string) {
		rb.Push(seq, vcID, fmt.Appendf(nil, `{"seq":%d,"type":%q,"payload":{"channel_id":%d}}`, seq, eventType, vcID))
	}
	push(99, MsgTypeChatMessage)
	push(100, MsgTypeChatMessage)
	push(101, MsgTypeChatMessage) // must stay filtered out — no READ on this channel
	push(102, MsgTypeVoiceState)
	push(103, MsgTypeVoiceLeaveBC)

	srv := httptest.NewServer(ServeWS(hub, database, []string{"*"}))
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

	readFrame := func(what string) map[string]any {
		t.Helper()
		readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
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

	if got := readFrame("handshake response")["type"]; got != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok (buffer-tier resume), got type=%v", got)
	}
	// Replay frames are written synchronously inside handleReconnect, before
	// writePump starts, so they are the next two frames on the wire.
	for i, want := range []string{MsgTypeVoiceState, MsgTypeVoiceLeaveBC} {
		frame := readFrame("replay frame")
		got, _ := frame["type"].(string)
		if got == MsgTypeChatMessage {
			t.Fatalf("replay frame %d leaked a chat frame for a channel the user cannot READ: %+v", i, frame)
		}
		if got != want {
			t.Fatalf("replay frame %d: got type=%q, want %q — the resuming participant's own voice room was filtered out of replay", i, got, want)
		}
	}
}
