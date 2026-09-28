package ws

// restart_resync_active_channel_test.go — regression test for the restart
// load profile's ws_replay_gap gate.
//
// A server restart renumbers the seq space from a fresh per-boot floor
// (OC-0210) and bumps the visibility watermark, so EVERY resume after a
// restart is forced onto the full-resync path (replay_source "none"). The
// auth frame's active_channel_id was honoured only along handleReconnect's
// replay-capable path; handleFreshConnect ignored it, so the full-resync
// socket held no ChannelTopic subscription until its post-ready
// channel_focus round trip landed. Every channel frame broadcast in that
// window (auth_ok + ready write, pump startup, one RTT) reached nobody on
// that socket and could never be re-requested, because the client only
// reports max(seq). Under the restart drill all 100 connections reconnect at
// once and keep chatting, so those windows overlap and frames are lost —
// which is exactly the ws_replay_gap max==0 gate failing 2/2.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestFullResyncAfterRestartHonorsActiveChannelID(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "restart-resync-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByID(ctx, userID)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "restart-resync-room", "text", "", "", 0)
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

	// Precondition: the channel IS readable, so the auth-frame id is eligible
	// to be honoured.
	allowed, err := hub.computeAllowedChannels(ctx, database, user)
	if err != nil {
		t.Fatalf("computeAllowedChannels: %v", err)
	}
	if !allowed[chID] {
		t.Fatalf("precondition: channel %d should be READ-visible", chID)
	}

	// Simulate the post-restart boot: seedHubReplayState reserves a fresh seq
	// floor far above any pre-restart value and bumps the visibility watermark
	// (internal/app/persistence.go), forcing every resume onto the full-resync
	// path.
	hub.SeedSeq(1_000_000_000)
	hub.MarkVisibilityChanged()
	const preRestartLastSeq = 500
	if !hub.mustFullResync(preRestartLastSeq) {
		t.Fatalf("precondition: mustFullResync must be true after the simulated restart boot")
	}

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
		"type": "auth",
		"payload": map[string]any{
			"token":             token,
			"last_seq":          preRestartLastSeq,
			"active_channel_id": chID,
		},
	})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
	defer readCancel()

	// auth_ok carries replay_source "none" — proof this is the full-resync path.
	_, authMsg, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read auth_ok: %v", err)
	}
	var authParsed map[string]any
	if err := json.Unmarshal(authMsg, &authParsed); err != nil {
		t.Fatalf("unmarshal auth_ok: %v", err)
	}
	if authParsed["type"] != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok, got %v", authParsed["type"])
	}
	authPayload, _ := authParsed["payload"].(map[string]any)
	if authPayload["replay_source"] != "none" {
		t.Fatalf("expected replay_source=none (full resync), got %v", authPayload["replay_source"])
	}

	if _, readyMsg, err := conn.Read(readCtx); err != nil {
		t.Fatalf("read ready: %v", err)
	} else {
		var readyParsed map[string]any
		if err := json.Unmarshal(readyMsg, &readyParsed); err != nil {
			t.Fatalf("unmarshal ready: %v", err)
		}
		if readyParsed["type"] != MsgTypeReady {
			t.Fatalf("expected ready, got %v", readyParsed["type"])
		}
	}

	// The full-resync socket must already be focused on — and subscribed to —
	// the channel the auth frame named, BEFORE any channel_focus is sent.
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
			t.Fatalf("post-restart full-resync client channelID = %d, want %d — the auth frame's "+
				"active_channel_id was ignored on the full-resync path, so the socket is unsubscribed "+
				"until channel_focus and every channel frame broadcast in the meantime is lost", got, chID)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// End-to-end: a channel frame broadcast right now (before the client sends
	// its own channel_focus) must reach this socket. Without the subscription
	// it is delivered to nobody and cannot be requested back.
	hub.BroadcastToChannel(chID, []byte(`{"type":"chat_message","payload":{"channel_id":1,"content":"restart-resync-probe"}}`))

	probeDeadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(probeDeadline) {
		frameCtx, frameCancel := context.WithTimeout(ctx, probeDeadline.Sub(time.Now()))
		_, frame, frameErr := conn.Read(frameCtx)
		frameCancel()
		if frameErr != nil {
			break
		}
		var frameParsed map[string]any
		if err := json.Unmarshal(frame, &frameParsed); err != nil {
			continue
		}
		if frameParsed["type"] != MsgTypeChatMessage {
			continue
		}
		payload, _ := frameParsed["payload"].(map[string]any)
		if payload["content"] == "restart-resync-probe" {
			return
		}
	}
	t.Fatalf("post-restart full-resync socket never received the channel frame broadcast during its "+
		"resume handshake (channel %d) — the frame is lost, which is the ws_replay_gap the restart "+
		"load profile gates on", chID)
}

// The auth frame's id is attacker-controlled, so on the full-resync path too it
// must be honoured only when the freshly recomputed READ set contains it — the
// same fail-closed gate handleReconnect applies. A regression here would hand
// an unreadable channel's live stream to a resumed socket.
func TestFullResyncAfterRestartActiveChannelIsReadGated(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "restart-resync-gated", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	noPerms, err := database.CreateRole(ctx, "restart-resync-no-perms", nil, 0, 1)
	if err != nil || noPerms == nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if err := database.UpdateUserRole(ctx, userID, noPerms.ID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	secretID, err := database.CreateChannel(ctx, "restart-resync-secret", "text", "", "", 0)
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

	hub.SeedSeq(1_000_000_000)
	hub.MarkVisibilityChanged()

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
		"type": "auth",
		"payload": map[string]any{
			"token":             token,
			"last_seq":          uint64(500),
			"active_channel_id": secretID,
		},
	})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
	defer readCancel()
	if _, _, err := conn.Read(readCtx); err != nil {
		t.Fatalf("read auth_ok: %v", err)
	}
	if _, _, err := conn.Read(readCtx); err != nil {
		t.Fatalf("read ready: %v", err)
	}

	time.Sleep(200 * time.Millisecond)
	hub.mu.Lock()
	c := hub.clients[userID]
	hub.mu.Unlock()
	if c == nil {
		t.Fatal("client was not registered")
	}
	if got := c.getChannelID(); got == secretID {
		t.Fatalf("post-restart full-resync client was focused on unreadable channel %d from an "+
			"attacker-supplied auth frame", got)
	}
	hub.pubsub.mu.RLock()
	sub := hub.pubsub.topics[ChannelTopic(secretID)][userID]
	hub.pubsub.mu.RUnlock()
	if sub != nil {
		t.Fatalf("post-restart full-resync client is subscribed to ChannelTopic(%d) despite "+
			"READ_MESSAGES being denied", secretID)
	}
}
