package api_test

// router_delete_account_broadcast_test.go pins the production wiring for
// OC-0048: NewRouter (router.go) must hand the WS hub to
// service.NewAuthService as its AuthBroadcaster so self-service account
// deletion fans out member_ban exactly like the admin ban path does. Auth
// routes were once mounted before the hub existed in router.go, so the only
// production call site used to omit the broadcaster entirely — handleDeleteAccount's
// `if broadcaster != nil` guard was never taken outside tests that construct
// their own fake broadcaster (see auth_handler_delete_broadcast_test.go,
// which only proves the handler itself works when a broadcaster IS passed).
// This test drives the real api.NewRouter wiring end to end, including a live
// WebSocket connection, so it fails if the router ever again forgets to wire
// the hub through.
//
// The broadcast is observed on a SECOND user's connection, not the deleted
// user's own: BroadcastMemberBan enqueues the broadcast and then force-
// disconnects the target, and on a slow runner the disconnect can close the
// target's socket before its copy of the frame is flushed. The observer
// socket has no such race — and it is the party the event exists for (every
// other client must drop the deleted member).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
)

// dialAndAuthWS opens a WS connection against srv and completes the auth
// handshake for token, failing the test on any step.
func dialAndAuthWS(t *testing.T, srv *httptest.Server, token string) *websocket.Conn {
	t.Helper()

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
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })

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
	return conn
}

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

	rt := app.StartRuntime(cfg, database, nil)
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)

	newUserSession := func(username string) (int64, string) {
		hash, _ := auth.HashPassword("correctPass1")
		// role_id=4 ("Member") so the last-admin check doesn't block deletion.
		uid, err := database.CreateUser(context.Background(), username, hash, 4)
		if err != nil {
			t.Fatalf("CreateUser(%s): %v", username, err)
		}
		token, err := auth.GenerateToken()
		if err != nil {
			t.Fatalf("GenerateToken: %v", err)
		}
		if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		return uid, token
	}

	doomedUID, doomedToken := newUserSession("routerdeletebroadcast")
	_, observerToken := newUserSession("routerdeletebroadcastobs")

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	// The doomed user connects so the hub also has a socket to force-close;
	// the observer connects to witness the fan-out.
	_ = dialAndAuthWS(t, srv, doomedToken)
	observer := dialAndAuthWS(t, srv, observerToken)

	// Self-delete over the real HTTP handler, same as the client would.
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/account",
		strings.NewReader(`{"password":"correctPass1"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+doomedToken)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE /api/v1/auth/account status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}

	// The hub must fan out member_ban for the deleted user to the observer's
	// still-open connection. Loop with an overall deadline: other broadcasts
	// (presence, member updates) may arrive first.
	deadline := time.Now().Add(10 * time.Second)
	sawMemberBan := false
	for time.Now().Before(deadline) {
		readCtx, readCancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, msg, readErr := observer.Read(readCtx)
		readCancel()
		if readErr != nil {
			break
		}
		var frame struct {
			Type    string `json:"type"`
			Payload struct {
				UserID int64 `json:"user_id"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &frame); err != nil {
			continue
		}
		if frame.Type == "member_ban" && frame.Payload.UserID == doomedUID {
			sawMemberBan = true
			break
		}
	}

	if !sawMemberBan {
		t.Fatal("no member_ban WS broadcast for the deleted user observed on a second client — " +
			"router.go must build service.NewAuthService with the hub as its " +
			"AuthBroadcaster (after ws.NewHub, not before)")
	}
}
