package api_test

// router_delete_account_broadcast_test.go pins the production wiring for
// OC-0048: NewRouter (router.go) must pass the WS hub to MountAuthRoutes as
// its optional AuthBroadcaster so self-service account deletion fans out
// member_ban exactly like the admin ban path does. MountAuthRoutes is called
// before the hub exists in router.go, so the only production call site used
// to omit the broadcaster entirely — handleDeleteAccount's
// `if broadcaster != nil` guard was never taken outside tests that construct
// their own fake broadcaster (see auth_handler_delete_broadcast_test.go,
// which only proves the handler itself works when a broadcaster IS passed).
// This test drives the real api.NewRouter wiring end to end, including a live
// WebSocket connection, so it fails if the router ever again forgets to wire
// the hub through.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

func TestNewRouter_DeleteAccount_BroadcastsMemberBanOverWS(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	cfg := &config.Config{
		Server: config.ServerConfig{
			Name:           "Test Server",
			Port:           8443,
			DataDir:        t.TempDir(),
			AllowedOrigins: []string{"*"},
		},
	}

	handler, _, cleanup := api.NewRouter(cfg, database, "test", nil, nil)
	t.Cleanup(cleanup)

	hash, _ := auth.HashPassword("correctPass1")
	// role_id=4 ("Member") so the last-admin check doesn't block deletion.
	uid, err := database.CreateUser(context.Background(), "routerdeletebroadcast", hash, 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	dialCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/ws"
	conn, dialResp, dialErr := websocket.Dial(dialCtx, wsURL, nil)
	if dialResp != nil && dialResp.Body != nil {
		defer dialResp.Body.Close() //nolint:errcheck // test cleanup
	}
	if dialErr != nil {
		t.Fatalf("websocket.Dial: %v", dialErr)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	authMsg := map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": token},
	}
	raw, _ := json.Marshal(authMsg)
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	_, authOKMsg, err := conn.Read(dialCtx)
	if err != nil {
		t.Fatalf("read auth_ok: %v", err)
	}
	var authOK map[string]any
	if err := json.Unmarshal(authOKMsg, &authOK); err != nil {
		t.Fatalf("unmarshal auth_ok: %v; raw=%s", err, authOKMsg)
	}
	if authOK["type"] != "auth_ok" {
		t.Fatalf("expected auth_ok, got %v; raw=%s", authOK["type"], authOKMsg)
	}

	// Self-delete over the real HTTP handler, same as the client would.
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/account",
		strings.NewReader(`{"password":"correctPass1"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE /api/v1/auth/account status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}

	// The hub must fan out a member_ban message over the still-open WS
	// connection. Loop with an overall deadline: BroadcastMemberBan enqueues
	// the broadcast on the hub's async broadcast channel, then separately
	// force-disconnects the socket, so more than one frame may arrive before
	// (or instead of, on the buggy wiring) the connection closes.
	deadline := time.Now().Add(5 * time.Second)
	sawMemberBan := false
	for time.Now().Before(deadline) {
		readCtx, readCancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, msg, readErr := conn.Read(readCtx)
		readCancel()
		if readErr != nil {
			break
		}
		var frame map[string]any
		if err := json.Unmarshal(msg, &frame); err != nil {
			continue
		}
		if frame["type"] == "member_ban" {
			sawMemberBan = true
			break
		}
	}

	if !sawMemberBan {
		t.Fatal("no member_ban WS broadcast observed after self-account-deletion — " +
			"router.go's MountAuthRoutes call must pass the hub as the optional " +
			"AuthBroadcaster (mount it after ws.NewHub, not before)")
	}
}
