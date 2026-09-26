package ws

// reconnect_fallback_channel_leak_test.go — regression test for OC-0001.
//
// handleReconnect promotes an attacker-supplied (but READ-gated at the time)
// active_channel_id into c.channelID (serve.go ~349) before its own abort
// paths run. When a permission revocation lands deep in the handshake and
// trips the final mustFullResync re-check (serve.go ~401), handleReconnect
// aborts with handled=false and ServeWS falls through to handleFreshConnect
// — but nothing clears the already-set c.channelID. handleFreshConnect
// recomputes allowedChannelIDs WITHOUT the revoked channel and its
// buildReady payload correctly omits it, but registerNow (hub.go ~560)
// subscribes c.channelID's ChannelTopic unconditionally, with no
// readableChannelIDs check — unlike its two siblings in the same function.
// Every subsequent broadcast to that channel is then delivered to a client
// that was never granted READ_MESSAGES for it.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

func TestReconnect_FullReadyFallbackDoesNotLeakRevokedChannelSubscription(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()

	uid := seedHarvestVoiceUser(t, database, "fallback-leak-user")
	chID := mustCreateVoiceChannel(t, database, "fallback-leak-channel")
	ch, err := database.GetChannel(ctx, chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	// Precondition: the channel is READ-visible at the moment the auth frame
	// is evaluated, so the auth-frame active_channel_id is legitimately
	// honoured by handleReconnect.
	allowedBefore, err := hub.computeAllowedChannels(ctx, database, user)
	if err != nil {
		t.Fatalf("computeAllowedChannels: %v", err)
	}
	if !allowedBefore[chID] {
		t.Fatalf("precondition: channel %d should start READ-visible", chID)
	}

	// Bracket last_seq=99 so the resume takes the buffer tier (not a
	// mustFullResync-forced full ready from the very start).
	rb := hub.ReplayBuffer()
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{}}`))
	hub.SeedSeq(100)
	const lastSeq = uint64(99)

	if hub.mustFullResync(lastSeq) {
		t.Fatalf("precondition: mustFullResync must be false before any visibility change")
	}

	// Fires once, deep inside handleReconnect — after c.channelID has already
	// been promoted from active_channel_id (serve.go ~349) but before the
	// final mustFullResync re-check (serve.go ~401). Revoke READ_MESSAGES on
	// chID, mirroring an admin edit racing the resume, exactly like
	// TestHandleReconnect_VisibilityChangeDuringHandshake_ForcesFullReady.
	var hookRan bool
	handleReconnectPreRegisterRaceHook = func() {
		hookRan = true
		if overrideErr := database.UpsertChannelOverride(ctx, chID, harvestVoiceRoleID, 0, permissions.ReadMessages); overrideErr != nil {
			t.Fatalf("UpsertChannelOverride: %v", overrideErr)
		}
		//nolint:contextcheck // RefreshChannelVisibility takes no context by design.
		hub.RefreshChannelVisibility(ch)
	}
	defer func() { handleReconnectPreRegisterRaceHook = nil }()

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
			"last_seq":          lastSeq,
			"active_channel_id": chID,
		},
	})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	// The abort forces the fallback full-connect flow, which writes TWO
	// frames — auth_ok, then ready — unlike the single auth_ok a successful
	// buffer-tier resume would send.
	readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
	defer readCancel()
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

	_, readyMsg, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read ready: %v", err)
	}
	var readyParsed map[string]any
	if err := json.Unmarshal(readyMsg, &readyParsed); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	if readyParsed["type"] != MsgTypeReady {
		t.Fatalf("expected ready (handleReconnect aborted, fell through to handleFreshConnect), got %v", readyParsed["type"])
	}

	if !hookRan {
		t.Fatal("handleReconnectPreRegisterRaceHook never fired — test setup is broken, not exercising the race window")
	}

	deadline := time.Now().Add(2 * time.Second)
	var c *Client
	for {
		hub.mu.Lock()
		c = hub.clients[uid]
		hub.mu.Unlock()
		if c != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("client was never registered")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if got := c.getChannelID(); got == chID {
		t.Errorf("resumed-then-fallback client kept focus on revoked channel %d after registerNow, want 0", got)
	}

	hub.pubsub.mu.RLock()
	sub := hub.pubsub.topics[ChannelTopic(chID)][uid]
	hub.pubsub.mu.RUnlock()
	if sub != nil {
		t.Errorf("client is subscribed to ChannelTopic(%d) despite READ_MESSAGES being revoked before registration — "+
			"every subsequent broadcast to that channel will be delivered to this socket", chID)
	}
}
