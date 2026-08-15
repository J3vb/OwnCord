package ws

// reconnect_active_channel_test.go — regression test for finding v019.
//
// registerNow restores a resuming client's ChannelTopic subscription by
// copying it from the OLD client entry. But readPump's unregister deletes that
// entry as soon as the server observes the socket close, which normally
// happens well before the client's first reconnect attempt — so on the common
// resume there is nothing to copy from, and the reconnected socket holds NO
// channel subscription until its post-auth_ok channel_focus round trip lands.
// Every message broadcast to that channel in the window (auth_ok write, up to
// maxColdReplay replay frames, pump startup, one RTT) is delivered to nobody
// and can never be re-requested, because the client only reports max(seq).
//
// The auth frame now carries active_channel_id, which handleReconnect promotes
// to c.channelID — READ-gated — before registerNow runs.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/owncord/server/auth"
)

func TestReconnect_AuthFrameActiveChannelRestoresSubscription(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "resume-focus-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByID(ctx, userID)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	chID, err := database.CreateChannel(ctx, "resume-room", "text", "", "", 0)
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

	hub := NewHub(database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	// Precondition: the channel IS readable, so the auth-frame id is eligible
	// to be honoured (an unreadable one must be ignored — covered below).
	allowed, err := hub.computeAllowedChannels(ctx, database, user)
	if err != nil {
		t.Fatalf("computeAllowedChannels: %v", err)
	}
	if !allowed[chID] {
		t.Fatalf("precondition: channel %d should be READ-visible", chID)
	}

	// Deliberately NO pre-registered old client: this is the exact case the
	// subscription-transfer path cannot cover, because there is nothing to
	// copy the focused channel from.
	// EventsSinceFiltered returns nil unless last_seq is STRICTLY greater than
	// the oldest buffered seq and no greater than the newest, so the window has
	// to bracket it: 98 anchors below, 100 sits above. Without that the replay
	// is empty, handleReconnect returns false, and the connection falls through
	// to the full-ready path -- which also sends auth_ok, so asserting on that
	// frame alone would not distinguish the two.
	rb := hub.ReplayBuffer()
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{}}`))

	srv := httptest.NewServer(ServeWS(hub, database, []string{"*"}, 0))
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
		"type": "auth",
		"payload": map[string]any{
			"token":             token,
			"last_seq":          uint64(99),
			"active_channel_id": chID,
		},
	})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
	defer readCancel()
	_, msg, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read handshake response: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(msg, &parsed); err != nil {
		t.Fatalf("unmarshal handshake response: %v", err)
	}
	if parsed["type"] != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok (buffer-tier resume), got %v", parsed["type"])
	}

	// The registered client must already be focused on — and subscribed to —
	// the channel, with no channel_focus ever sent.
	deadline := time.Now().Add(2 * time.Second)
	for {
		hub.mu.Lock()
		c := hub.clients[userID]
		hub.mu.Unlock()
		if c != nil && c.getChannelID() == chID {
			break
		}
		if time.Now().After(deadline) {
			got := int64(-1)
			if c != nil {
				got = c.getChannelID()
			}
			t.Fatalf("resumed client channelID = %d, want %d — the socket is unsubscribed until channel_focus, "+
				"so every broadcast to that channel in the meantime is lost", got, chID)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The id is attacker-controlled, so a channel the user may not read must never
// be honoured — it would hand out a ChannelTopic subscription (and with it the
// channel's live message stream) that the permission set denies.
func TestReconnect_AuthFrameActiveChannelIsReadGated(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "resume-gated-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	noPerms, err := database.CreateRole(ctx, "no-perms-resume", nil, 0, 1)
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

	secretID, err := database.CreateChannel(ctx, "secret-resume", "text", "", "", 0)
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

	hub := NewHub(database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	allowed, err := hub.computeAllowedChannels(ctx, database, user)
	if err != nil {
		t.Fatalf("computeAllowedChannels: %v", err)
	}
	if allowed[secretID] {
		t.Fatalf("precondition: channel %d must NOT be readable by this role", secretID)
	}

	// Global (channel_id 0) frames bracketing last_seq, so the resume takes the
	// buffer tier rather than falling through to full ready.
	hub.ReplayBuffer().Push(98, 0, []byte(`{"seq":98,"type":"presence","payload":{}}`))
	hub.ReplayBuffer().Push(99, 0, []byte(`{"seq":99,"type":"presence","payload":{}}`))
	hub.ReplayBuffer().Push(100, 0, []byte(`{"seq":100,"type":"presence","payload":{}}`))

	srv := httptest.NewServer(ServeWS(hub, database, []string{"*"}, 0))
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
		"type": "auth",
		"payload": map[string]any{
			"token":             token,
			"last_seq":          uint64(99),
			"active_channel_id": secretID,
		},
	})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
	defer readCancel()
	if _, _, err := conn.Read(readCtx); err != nil {
		t.Fatalf("read handshake response: %v", err)
	}

	// Give registration a moment, then assert the claim was refused.
	time.Sleep(200 * time.Millisecond)
	hub.mu.Lock()
	c := hub.clients[userID]
	hub.mu.Unlock()
	if c == nil {
		t.Fatal("client was not registered")
	}
	if got := c.getChannelID(); got == secretID {
		t.Fatalf("client was focused on unreadable channel %d from an attacker-supplied auth frame", got)
	}
}
