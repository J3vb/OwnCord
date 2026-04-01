package ws_test

// ws_integration_test.go covers ServeWS, authenticateConn, writePump, and
// readPump by spinning up a real httptest server and dialing it with the
// nhooyr.io/websocket client.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/ws"
)

// ─── ServeWS / authenticateConn happy path ────────────────────────────────────

// TestServeWS_InvalidUpgrade verifies that a plain HTTP GET (non-WS) returns
// a non-101 status without panicking.
func TestServeWS_InvalidUpgrade_ReturnsError(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	// Plain GET without WebSocket upgrade headers should fail gracefully.
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("http.Get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// nhooyr.io/websocket returns 400 or 426 when upgrade is absent.
	if resp.StatusCode == 200 {
		t.Errorf("expected non-200 for plain HTTP, got %d", resp.StatusCode)
	}
}

// ─── authenticateConn — error paths ──────────────────────────────────────────

// TestAuthenticateConn_NoAuthMessage verifies that a connection that closes
// immediately (without sending auth) causes the server to close it gracefully.
func TestAuthenticateConn_NoAuthMessage_ServerClosesConn(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, dialResp, err := websocket.Dial(ctx, wsURL, nil)
	if dialResp != nil && dialResp.Body != nil {
		defer dialResp.Body.Close() //nolint:errcheck // test cleanup
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}

	// Close without sending auth — the server's authDeadline (10s) will fire,
	// but closing immediately should cause a read error on the server side.
	_ = conn.Close(websocket.StatusNormalClosure, "no auth")

	// Give the server a moment to react.
	time.Sleep(50 * time.Millisecond)

	// Hub should have no clients registered.
	if hub.ClientCount() != 0 {
		t.Errorf("ClientCount = %d after unauthenticated connection, want 0", hub.ClientCount())
	}
}

// TestAuthenticateConn_InvalidJSON verifies that sending invalid JSON as the
// first message causes the server to send an auth_error and close.
func TestAuthenticateConn_InvalidJSON_ReceivesAuthError(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, dialResp2, err := websocket.Dial(ctx, wsURL, nil)
	if dialResp2 != nil && dialResp2.Body != nil {
		defer dialResp2.Body.Close() //nolint:errcheck // test cleanup
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// Send invalid JSON as first message.
	if err := conn.Write(ctx, websocket.MessageText, []byte("NOT JSON")); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Server should respond with auth_error.
	_, raw, readErr := conn.Read(ctx)
	if readErr != nil {
		// Server may close connection — also acceptable.
		return
	}
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err == nil {
		if msg["type"] == "auth_error" {
			return // expected
		}
		t.Errorf("expected auth_error, got type=%q", msg["type"])
	}
}

// TestAuthenticateConn_WrongMessageType verifies that sending a non-auth
// first message causes the server to send an auth_error.
func TestAuthenticateConn_WrongMessageType_ReceivesAuthError(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(ctx, wsURL, nil)
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// Send a chat_send instead of auth.
	wrongMsg := map[string]any{
		"type":    "chat_send",
		"payload": map[string]string{"content": "hello"},
	}
	raw, _ := json.Marshal(wrongMsg)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write: %v", err)
	}

	_, respRaw, readErr := conn.Read(ctx)
	if readErr != nil {
		return // server closed — acceptable
	}
	var msg map[string]any
	if err := json.Unmarshal(respRaw, &msg); err == nil {
		if msg["type"] == "auth_error" {
			return // expected
		}
		t.Errorf("expected auth_error, got type=%q", msg["type"])
	}
}

// TestAuthenticateConn_MissingToken verifies that an auth message without
// a token field receives an auth_error.
func TestAuthenticateConn_MissingToken_ReceivesAuthError(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(ctx, wsURL, nil)
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	authMsg := map[string]any{
		"type":    "auth",
		"payload": map[string]string{}, // no token field
	}
	raw, _ := json.Marshal(authMsg)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write: %v", err)
	}

	_, respRaw, readErr := conn.Read(ctx)
	if readErr != nil {
		return
	}
	var msg map[string]any
	if err := json.Unmarshal(respRaw, &msg); err == nil {
		if msg["type"] == "auth_error" {
			return
		}
		t.Errorf("expected auth_error, got type=%q", msg["type"])
	}
}

// TestAuthenticateConn_InvalidToken verifies that an auth message with a
// non-existent token receives an auth_error.
func TestAuthenticateConn_InvalidToken_ReceivesAuthError(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(ctx, wsURL, nil)
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	authMsg := map[string]any{
		"type":    "auth",
		"payload": map[string]string{"token": "totally-invalid-token-xyz"},
	}
	raw, _ := json.Marshal(authMsg)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write: %v", err)
	}

	_, respRaw, readErr := conn.Read(ctx)
	if readErr != nil {
		return
	}
	var msg map[string]any
	if err := json.Unmarshal(respRaw, &msg); err == nil {
		if msg["type"] == "auth_error" {
			return
		}
		t.Errorf("expected auth_error, got type=%q", msg["type"])
	}
}

// TestServeWS_ValidAuth_FullHandshake verifies the complete happy path:
// valid token → auth_ok + ready received, client counted in hub.
func TestServeWS_ValidAuth_FullHandshake(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	// Seed user and session.
	userID, err := database.CreateUser("ws-handshake-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(userID, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(ctx, wsURL, nil)
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// Send auth.
	authMsg := map[string]any{
		"type":    "auth",
		"payload": map[string]string{"token": token},
	}
	raw, _ := json.Marshal(authMsg)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	// Expect auth_ok.
	_, respRaw, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read auth_ok: %v", err)
	}
	var authOK map[string]any
	if err := json.Unmarshal(respRaw, &authOK); err != nil {
		t.Fatalf("unmarshal auth_ok: %v", err)
	}
	if authOK["type"] != "auth_ok" {
		t.Errorf("first response type = %q, want auth_ok", authOK["type"])
	}

	// Expect ready.
	_, respRaw2, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read ready: %v", err)
	}
	var readyMsg map[string]any
	if err := json.Unmarshal(respRaw2, &readyMsg); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	if readyMsg["type"] != "ready" {
		t.Errorf("second response type = %q, want ready", readyMsg["type"])
	}

	// Give hub a moment to register the client.
	time.Sleep(30 * time.Millisecond)
	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d after successful auth, want 1", hub.ClientCount())
	}
}

// TestServeWS_ImmediateDisconnect_DoesNotLeaveGhostClient verifies that a
// client that drops immediately after sending auth does not remain registered
// or stuck online.
func TestServeWS_ImmediateDisconnect_DoesNotLeaveGhostClient(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	userID, err := database.CreateUser("abruptclose", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token := "abrupt-close-token"
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(userID, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(ctx, wsURL, nil)
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer conn.CloseNow() //nolint:errcheck

	authMsg := map[string]any{
		"type":    "auth",
		"payload": map[string]string{"token": token},
	}
	raw, err := json.Marshal(authMsg)
	if err != nil {
		t.Fatalf("marshal auth: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	_ = conn.CloseNow()

	deadline := time.Now().Add(2 * time.Second)
	cleanedUp := false
	for time.Now().Before(deadline) {
		user, getErr := database.GetUserByID(userID)
		if getErr != nil {
			t.Fatalf("GetUserByID: %v", getErr)
		}
		if hub.ClientCount() == 0 && user.Status == "offline" {
			cleanedUp = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if !cleanedUp {
		user, getErr := database.GetUserByID(userID)
		if getErr != nil {
			t.Fatalf("GetUserByID final: %v", getErr)
		}
		t.Fatalf("immediate disconnect left stale state: client_count=%d user_status=%q", hub.ClientCount(), user.Status)
	}
}

// TestServeWS_DuplicateLogin_KeepsUserOnline verifies that replacing an
// existing connection does not broadcast or persist a false offline state for
// the still-connected replacement session.
func TestServeWS_DuplicateLogin_KeepsUserOnline(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	userID, err := database.CreateUser("ws-reconnect-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(userID, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dialAndAuth := func() *websocket.Conn {
		conn, dialResp, dialErr := websocket.Dial(ctx, wsURL, nil)
		if dialResp != nil && dialResp.Body != nil {
			dialResp.Body.Close()
		}
		if dialErr != nil {
			t.Fatalf("websocket.Dial: %v", dialErr)
		}
		authMsg := map[string]any{
			"type":    "auth",
			"payload": map[string]string{"token": token},
		}
		raw, marshalErr := json.Marshal(authMsg)
		if marshalErr != nil {
			t.Fatalf("marshal auth: %v", marshalErr)
		}
		if writeErr := conn.Write(ctx, websocket.MessageText, raw); writeErr != nil {
			t.Fatalf("write auth: %v", writeErr)
		}
		for i := 0; i < 2; i++ {
			if _, _, readErr := conn.Read(ctx); readErr != nil {
				t.Fatalf("read handshake message %d: %v", i, readErr)
			}
		}
		return conn
	}

	conn1 := dialAndAuth()
	defer func() { _ = conn1.Close(websocket.StatusNormalClosure, "") }()
	conn2 := dialAndAuth()
	defer func() { _ = conn2.Close(websocket.StatusNormalClosure, "") }()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		user, getErr := database.GetUserByID(userID)
		if getErr != nil {
			t.Fatalf("GetUserByID: %v", getErr)
		}
		if hub.ClientCount() == 1 && user.Status == "online" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}

	user, getErr := database.GetUserByID(userID)
	if getErr != nil {
		t.Fatalf("GetUserByID final: %v", getErr)
	}
	t.Fatalf("duplicate login left wrong state: client_count=%d user_status=%q", hub.ClientCount(), user.Status)
}

// TestServeWS_Reconnect_PreservesVoiceState verifies that replacing a
// connection via network reconnect (last_seq > 0) preserves voice state:
// no voice_leave broadcast, voiceChID transferred, DB row intact.
func TestServeWS_Reconnect_PreservesVoiceState(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	userID, err := database.CreateUser("ws-voice-reconnect", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(userID, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Create a voice channel.
	chID, err := database.CreateChannel("voice-reconnect", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dialAndAuth := func(lastSeq uint64) *websocket.Conn {
		t.Helper()
		conn, dialResp, dialErr := websocket.Dial(ctx, wsURL, nil)
		if dialResp != nil && dialResp.Body != nil {
			dialResp.Body.Close()
		}
		if dialErr != nil {
			t.Fatalf("websocket.Dial: %v", dialErr)
		}
		authMsg := map[string]any{
			"type":    "auth",
			"payload": map[string]any{"token": token, "last_seq": lastSeq},
		}
		raw, marshalErr := json.Marshal(authMsg)
		if marshalErr != nil {
			t.Fatalf("marshal auth: %v", marshalErr)
		}
		if writeErr := conn.Write(ctx, websocket.MessageText, raw); writeErr != nil {
			t.Fatalf("write auth: %v", writeErr)
		}
		// Read auth_ok + ready
		for i := 0; i < 2; i++ {
			if _, _, readErr := conn.Read(ctx); readErr != nil {
				t.Fatalf("read handshake message %d: %v", i, readErr)
			}
		}
		return conn
	}

	// First connection: fresh
	conn1 := dialAndAuth(0)
	defer func() { _ = conn1.Close(websocket.StatusNormalClosure, "") }()

	var originalClient *ws.Client
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		originalClient = hub.GetClient(userID)
		if originalClient != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if originalClient == nil {
		t.Fatal("expected first client to be registered")
	}

	// Simulate voice join AFTER conn1 is established — both in-memory and DB.
	// (Setting it before conn1 would cause serve.go's fresh-connect cleanup
	// to delete the DB row during conn1's handshake.)
	if err := database.JoinVoiceChannel(userID, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vsBeforeReconnect, err := database.GetVoiceState(userID)
	if err != nil {
		t.Fatalf("GetVoiceState(before reconnect): %v", err)
	}
	if vsBeforeReconnect == nil {
		t.Fatal("expected voice state row after JoinVoiceChannel")
	}
	ws.SetClientVoiceStateForTest(originalClient, chID, vsBeforeReconnect.JoinedAt)

	// Second connection: reconnect (lastSeq > 0) — voice state should transfer
	conn2 := dialAndAuth(1)
	defer func() { _ = conn2.Close(websocket.StatusNormalClosure, "") }()

	var replacementClient *ws.Client
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		replacementClient = hub.GetClient(userID)
		if replacementClient != nil && ws.GetClientVoiceChIDForTest(replacementClient) == chID {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if replacementClient == nil {
		t.Fatal("expected replacement client to be registered")
	}

	// Assert: voiceChID transferred
	if got := ws.GetClientVoiceChIDForTest(replacementClient); got != chID {
		t.Fatalf("replacement client voiceChID = %d, want %d", got, chID)
	}

	// Assert: DB row still intact
	vs, vsErr := database.GetVoiceState(userID)
	if vsErr != nil {
		t.Fatalf("GetVoiceState: %v", vsErr)
	}
	if vs == nil {
		t.Fatal("reconnect: DB voice_state row was deleted, expected it to be preserved")
	}
	if vs.ChannelID != chID {
		t.Fatalf("reconnect: DB voice_state channel_id = %d, want %d", vs.ChannelID, chID)
	}

	// Assert: no voice_leave broadcast
	readDeadline := time.Now().Add(400 * time.Millisecond)
	for time.Now().Before(readDeadline) {
		readCtx, readCancel := context.WithTimeout(ctx, 100*time.Millisecond)
		_, raw, readErr := conn2.Read(readCtx)
		readCancel()
		if readErr != nil {
			break
		}
		var msg map[string]any
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		if msg["type"] == "voice_leave" {
			t.Fatalf("reconnect must not broadcast voice_leave: %s", string(raw))
		}
	}
}

// TestServeWS_FreshReconnect_CleansStaleVoiceState verifies that when a user
// presses F5 (fresh connection, lastSeq = 0) while in voice, the server:
//  1. cleans the DB voice_state row before building ready
//  2. does NOT include the user in ready.payload.voice_states
//  3. sets replacement client voiceChID = 0
//  4. broadcasts exactly one voice_leave visible to an observer client
func TestServeWS_FreshReconnect_CleansStaleVoiceState(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	// Create two users: the voice user who F5-reloads, and an observer.
	userID, err := database.CreateUser("ws-voice-f5", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(userID, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	observerID, err := database.CreateUser("ws-observer", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser (observer): %v", err)
	}
	obsToken, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken (observer): %v", err)
	}
	obsTokenHash := auth.HashToken(obsToken)
	if _, err := database.CreateSession(observerID, obsTokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession (observer): %v", err)
	}

	// Create a voice channel for the user to be "in".
	chID, err := database.CreateChannel("voice-test", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dialAndAuthFresh := func(tok string) *websocket.Conn {
		t.Helper()
		conn, dialResp, dialErr := websocket.Dial(ctx, wsURL, nil)
		if dialResp != nil && dialResp.Body != nil {
			dialResp.Body.Close()
		}
		if dialErr != nil {
			t.Fatalf("websocket.Dial: %v", dialErr)
		}
		authMsg := map[string]any{
			"type":    "auth",
			"payload": map[string]string{"token": tok},
		}
		raw, marshalErr := json.Marshal(authMsg)
		if marshalErr != nil {
			t.Fatalf("marshal auth: %v", marshalErr)
		}
		if writeErr := conn.Write(ctx, websocket.MessageText, raw); writeErr != nil {
			t.Fatalf("write auth: %v", writeErr)
		}
		// Read auth_ok + ready
		for i := 0; i < 2; i++ {
			if _, _, readErr := conn.Read(ctx); readErr != nil {
				t.Fatalf("read handshake message %d: %v", i, readErr)
			}
		}
		return conn
	}

	// dialAndReadReady dials, authenticates with lastSeq=0, and returns the
	// conn plus the parsed ready payload so the caller can inspect voice_states.
	dialAndReadReady := func(tok string) (*websocket.Conn, map[string]any) {
		t.Helper()
		conn, dialResp, dialErr := websocket.Dial(ctx, wsURL, nil)
		if dialResp != nil && dialResp.Body != nil {
			dialResp.Body.Close()
		}
		if dialErr != nil {
			t.Fatalf("websocket.Dial: %v", dialErr)
		}
		authMsg := map[string]any{
			"type":    "auth",
			"payload": map[string]string{"token": tok},
		}
		raw, marshalErr := json.Marshal(authMsg)
		if marshalErr != nil {
			t.Fatalf("marshal auth: %v", marshalErr)
		}
		if writeErr := conn.Write(ctx, websocket.MessageText, raw); writeErr != nil {
			t.Fatalf("write auth: %v", writeErr)
		}
		// Read auth_ok (skip it)
		if _, _, readErr := conn.Read(ctx); readErr != nil {
			t.Fatalf("read auth_ok: %v", readErr)
		}
		// Read ready — parse it
		_, readyRaw, readErr := conn.Read(ctx)
		if readErr != nil {
			t.Fatalf("read ready: %v", readErr)
		}
		var readyMsg map[string]any
		if err := json.Unmarshal(readyRaw, &readyMsg); err != nil {
			t.Fatalf("unmarshal ready: %v", err)
		}
		return conn, readyMsg
	}

	// First connection: user joins voice
	conn1 := dialAndAuthFresh(token)
	defer func() { _ = conn1.Close(websocket.StatusNormalClosure, "") }()

	var originalClient *ws.Client
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		originalClient = hub.GetClient(userID)
		if originalClient != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if originalClient == nil {
		t.Fatal("expected first client to be registered")
	}

	// Simulate voice join — both in-memory and DB
	if err := database.JoinVoiceChannel(userID, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vsBeforeReload, err := database.GetVoiceState(userID)
	if err != nil {
		t.Fatalf("GetVoiceState(before reload): %v", err)
	}
	if vsBeforeReload == nil {
		t.Fatal("expected voice state row after JoinVoiceChannel")
	}
	ws.SetClientVoiceStateForTest(originalClient, chID, vsBeforeReload.JoinedAt)

	// Connect the observer (will receive broadcasts).
	// Do NOT drain the observer — nhooyr.io/websocket closes the conn
	// when a Read context expires. Instead, collect all messages below
	// and filter for voice_leave in the assertion.
	obsConn := dialAndAuthFresh(obsToken)
	defer func() { _ = obsConn.Close(websocket.StatusNormalClosure, "") }()

	// F5 reload: fresh connection (lastSeq = 0)
	conn2, readyMsg := dialAndReadReady(token)
	defer func() { _ = conn2.Close(websocket.StatusNormalClosure, "") }()

	// Wait for replacement to register fully and broadcasts to propagate.
	time.Sleep(500 * time.Millisecond)

	// Assert 1: replacement client voiceChID == 0
	replacementClient := hub.GetClient(userID)
	if replacementClient == nil {
		t.Fatal("expected replacement client to be registered")
	}
	if got := ws.GetClientVoiceChIDForTest(replacementClient); got != 0 {
		t.Fatalf("fresh reconnect: replacement client voiceChID = %d, want 0", got)
	}

	// Assert 2: DB voice row is gone
	vs, vsErr := database.GetVoiceState(userID)
	if vsErr != nil {
		t.Fatalf("GetVoiceState: %v", vsErr)
	}
	if vs != nil {
		t.Fatalf("fresh reconnect: stale voice state still in DB: channel_id=%d", vs.ChannelID)
	}

	// Assert 3: ready.payload.voice_states does not include the reconnecting user
	payload, _ := readyMsg["payload"].(map[string]any)
	voiceStates, _ := payload["voice_states"].([]any)
	for _, vsRaw := range voiceStates {
		vsMap, _ := vsRaw.(map[string]any)
		vsUserID, _ := vsMap["user_id"].(float64)
		if int64(vsUserID) == userID {
			t.Fatalf("ready payload must not include stale voice state for user %d: %+v", userID, vsMap)
		}
	}

	// Assert 4: observer saw exactly one voice_leave for our user+channel.
	// Read all pending messages — the observer may have received
	// member_join/presence/voice_leave since connecting.
	voiceLeaveCount := 0
	for {
		readCtx, readCancel := context.WithTimeout(ctx, 500*time.Millisecond)
		_, raw, readErr := obsConn.Read(readCtx)
		readCancel()
		if readErr != nil {
			break
		}
		var msg map[string]any
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		msgType, _ := msg["type"].(string)
		if msgType == "voice_leave" {
			msgPayload, _ := msg["payload"].(map[string]any)
			msgUserID, _ := msgPayload["user_id"].(float64)
			msgChID, _ := msgPayload["channel_id"].(float64)
			if int64(msgUserID) == userID && int64(msgChID) == chID {
				voiceLeaveCount++
			}
		}
	}
	if voiceLeaveCount == 0 {
		t.Fatal("fresh reconnect: observer never received voice_leave for the ghost user")
	}
	if voiceLeaveCount > 1 {
		t.Fatalf("fresh reconnect: observer received %d voice_leave messages, want exactly 1", voiceLeaveCount)
	}
}

// TestServeWS_writePump_MessageDelivered verifies that messages queued on the
// hub are written through writePump to the connected client.
func TestServeWS_writePump_MessageDelivered(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	// Seed user and session.
	userID, err := database.CreateUser("ws-pump-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(userID, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(ctx, wsURL, nil)
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// Authenticate.
	authMsg := map[string]any{
		"type":    "auth",
		"payload": map[string]string{"token": token},
	}
	raw, _ := json.Marshal(authMsg)
	_ = conn.Write(ctx, websocket.MessageText, raw)

	// Drain auth_ok and ready.
	for i := 0; i < 2; i++ {
		_, _, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("drain initial messages: %v", err)
		}
	}

	// Wait for client to be registered and then broadcast a server_restart.
	time.Sleep(50 * time.Millisecond)
	hub.BroadcastServerRestart("test", 0)

	// The client should receive the broadcast via writePump.
	readCtx, readCancel := context.WithTimeout(ctx, 2*time.Second)
	defer readCancel()
	_, broadcastRaw, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read broadcast: %v", err)
	}
	var bcast map[string]any
	if err := json.Unmarshal(broadcastRaw, &bcast); err != nil {
		t.Fatalf("unmarshal broadcast: %v", err)
	}
	// May receive member_join or presence first; drain until server_restart found.
	found := bcast["type"] == "server_restart"
	if !found {
		// Drain a few more messages.
		for i := 0; i < 5 && !found; i++ {
			rCtx, rCancel := context.WithTimeout(ctx, 500*time.Millisecond)
			_, raw2, err2 := conn.Read(rCtx)
			rCancel()
			if err2 != nil {
				break
			}
			var m map[string]any
			if json.Unmarshal(raw2, &m) == nil && m["type"] == "server_restart" {
				found = true
			}
		}
	}
	if !found {
		t.Error("did not receive server_restart broadcast via writePump")
	}
}

// TestIntegration_MessageRoundTrip verifies that two clients can exchange messages
// through the real WebSocket upgrade path: Client A sends chat_send, Client B
// receives chat_message via the hub broadcast.
func TestIntegration_MessageRoundTrip(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	// Seed two users with sessions.
	userIDA, err := database.CreateUser("roundtrip-a", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser A: %v", err)
	}
	tokenA, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken A: %v", err)
	}
	if _, err := database.CreateSession(userIDA, auth.HashToken(tokenA), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession A: %v", err)
	}

	userIDB, err := database.CreateUser("roundtrip-b", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser B: %v", err)
	}
	tokenB, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken B: %v", err)
	}
	if _, err := database.CreateSession(userIDB, auth.HashToken(tokenB), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession B: %v", err)
	}

	// Create a text channel for the chat.
	chID, err := database.CreateChannel("integration-chat", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	// --- Helper: connect and authenticate a WebSocket client ---
	connectAndAuth := func(label, token string) *websocket.Conn {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		conn, dialResp, dialErr := websocket.Dial(ctx, wsURL, nil)
		if dialResp != nil && dialResp.Body != nil {
			dialResp.Body.Close()
		}
		if dialErr != nil {
			t.Fatalf("%s dial: %v", label, dialErr)
		}
		authMsg, _ := json.Marshal(map[string]any{
			"type":    "auth",
			"payload": map[string]string{"token": token},
		})
		if writeErr := conn.Write(ctx, websocket.MessageText, authMsg); writeErr != nil {
			t.Fatalf("%s write auth: %v", label, writeErr)
		}
		// Drain auth_ok + ready.
		for i := 0; i < 2; i++ {
			if _, _, readErr := conn.Read(ctx); readErr != nil {
				t.Fatalf("%s drain initial msg %d: %v", label, i, readErr)
			}
		}
		return conn
	}

	connA := connectAndAuth("clientA", tokenA)
	defer func() { _ = connA.Close(websocket.StatusNormalClosure, "") }()

	connB := connectAndAuth("clientB", tokenB)
	defer func() { _ = connB.Close(websocket.StatusNormalClosure, "") }()

	// Wait for both clients to be registered in the hub.
	time.Sleep(50 * time.Millisecond)

	// Client B focuses on the channel so it receives channel-scoped broadcasts.
	focusMsg, _ := json.Marshal(map[string]any{
		"type":    "channel_focus",
		"payload": map[string]any{"channel_id": chID},
	})
	ctxB, cancelB := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelB()
	if err := connB.Write(ctxB, websocket.MessageText, focusMsg); err != nil {
		t.Fatalf("clientB write channel_focus: %v", err)
	}
	time.Sleep(30 * time.Millisecond)

	// Client A sends a chat message.
	chatSend, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"id":   "req-1",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "hello from A",
		},
	})
	ctxA, cancelA := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelA()
	if err := connA.Write(ctxA, websocket.MessageText, chatSend); err != nil {
		t.Fatalf("clientA write chat_send: %v", err)
	}

	// Client B should receive a chat_message broadcast.
	// Drain a few messages (member_join, presence, etc.) until we find chat_message.
	found := false
	readCtx, readCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer readCancel()
	for i := 0; i < 15 && !found; i++ {
		_, raw, readErr := connB.Read(readCtx)
		if readErr != nil {
			t.Fatalf("clientB read: %v", readErr)
		}
		var env map[string]any
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		if env["type"] == "chat_message" {
			payload, _ := env["payload"].(map[string]any)
			if payload == nil {
				t.Fatal("chat_message has nil payload")
			}
			if payload["content"] != "hello from A" {
				t.Errorf("content = %q, want 'hello from A'", payload["content"])
			}
			user, _ := payload["user"].(map[string]any)
			if user == nil {
				t.Fatal("chat_message missing user")
			}
			if user["username"] != "roundtrip-a" {
				t.Errorf("username = %q, want 'roundtrip-a'", user["username"])
			}
			found = true
		}
	}
	if !found {
		t.Error("clientB never received chat_message from clientA")
	}
}

// TestIntegration_SequenceNumbers verifies that broadcast messages delivered via
// the real WebSocket path carry a monotonically increasing `seq` field.
func TestIntegration_SequenceNumbers(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	userID, err := database.CreateUser("seq-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(ctx, wsURL, nil)
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// Authenticate.
	authMsg, _ := json.Marshal(map[string]any{
		"type":    "auth",
		"payload": map[string]string{"token": token},
	})
	if err := conn.Write(ctx, websocket.MessageText, authMsg); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	// Drain auth_ok and ready (these are direct writes, not broadcasts).
	for i := 0; i < 2; i++ {
		if _, _, err := conn.Read(ctx); err != nil {
			t.Fatalf("drain msg %d: %v", i, err)
		}
	}

	// Wait for registration.
	time.Sleep(50 * time.Millisecond)

	// Trigger two broadcasts.
	hub.BroadcastServerRestart("test-seq-1", 10)
	hub.BroadcastServerRestart("test-seq-2", 20)

	// Collect broadcast messages — they must carry monotonically increasing seq.
	var seqs []float64
	readCtx, readCancel := context.WithTimeout(ctx, 3*time.Second)
	defer readCancel()
	for i := 0; i < 10; i++ {
		_, raw, readErr := conn.Read(readCtx)
		if readErr != nil {
			break
		}
		var env map[string]any
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		// Broadcasts go through deliverBroadcast which stamps seq.
		if seq, ok := env["seq"].(float64); ok {
			seqs = append(seqs, seq)
		}
		// Stop once we've collected at least 2 seq-bearing messages.
		if len(seqs) >= 2 {
			break
		}
	}

	if len(seqs) < 2 {
		t.Fatalf("expected at least 2 messages with seq field, got %d", len(seqs))
	}
	for i := 1; i < len(seqs); i++ {
		if seqs[i] <= seqs[i-1] {
			t.Errorf("seq not monotonically increasing: seq[%d]=%.0f seq[%d]=%.0f", i-1, seqs[i-1], i, seqs[i])
		}
	}
}

// TestServeWS_BannedUser_ReceivesError verifies that a banned user cannot connect.
func TestServeWS_BannedUser_ReceivesError(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	defer hub.Stop()

	// Seed user, then ban them.
	userID, err := database.CreateUser("ws-banned-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(userID, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	// Ban the user permanently.
	if err := database.BanUser(userID, "test ban", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(ctx, wsURL, nil)
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	authMsg := map[string]any{
		"type":    "auth",
		"payload": map[string]string{"token": token},
	}
	raw, _ := json.Marshal(authMsg)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	_, respRaw, readErr := conn.Read(ctx)
	if readErr != nil {
		return // server closed connection — acceptable
	}
	var msg map[string]any
	if err := json.Unmarshal(respRaw, &msg); err == nil {
		msgType, _ := msg["type"].(string)
		if msgType == "auth_ok" {
			t.Error("banned user should not receive auth_ok")
		}
	}
}
