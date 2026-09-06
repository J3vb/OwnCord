package api_test

// dm_request_router_test.go drives B5-6's REST decision through the real
// production wiring (api.NewRouter, a real *ws.Hub, a real WebSocket
// connection) — the "other devices" half of the multi-device requirement:
// bob decides over REST, which is not a WebSocket session at all, and his
// one live WS connection (the only "device" the hub can fan out to — see
// message_request_test.go's own note on the hub's single-connection-per-user
// model) must still receive the push. Modelled on
// router_delete_account_broadcast_test.go, the existing worked example of
// this pattern.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
)

// readUntil polls conn until frameType arrives (unmarshalling into want) or
// the deadline elapses, returning whether it was found. Other frames
// (presence, member_join, ready) are skipped — this rig has no control over
// their timing relative to the frame under test.
func readUntil(t *testing.T, conn *websocket.Conn, frameType string, want any, deadline time.Time) bool {
	t.Helper()
	for time.Now().Before(deadline) {
		readCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, msg, err := conn.Read(readCtx)
		cancel()
		if err != nil {
			return false
		}
		var frame struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(msg, &frame); err != nil {
			continue
		}
		if frame.Type != frameType {
			continue
		}
		if want != nil {
			if err := json.Unmarshal(frame.Payload, want); err != nil {
				t.Fatalf("decode %s payload: %v", frameType, err)
			}
		}
		return true
	}
	return false
}

func TestNewRouter_DMRequestTransition_ReachesLiveConnection(t *testing.T) {
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
			Name: "Test Server", Port: 8443, DataDir: t.TempDir(), AllowedOrigins: []string{"*"},
		},
	}
	rt, rtErr := app.StartRuntime(cfg, database, nil)
	if rtErr != nil {
		t.Fatalf("app.StartRuntime: %v", rtErr)
	}
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)

	newUserSession := func(username string) (int64, string) {
		hash, _ := auth.HashPassword("correctPass1")
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
	aliceID, aliceToken := newUserSession("dmreqrouteralice")
	_, bobToken := newUserSession("dmreqrouterbob")

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	aliceWS := dialAndAuthWS(t, srv, aliceToken)
	bobWS := dialAndAuthWS(t, srv, bobToken) // bob's one live "device"

	ch, _, err := database.GetOrCreateDMChannel(context.Background(), aliceID, mustUserID(t, database, "dmreqrouterbob"))
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	sendMsg := map[string]any{
		"type":    "chat_send",
		"id":      "req-1",
		"payload": map[string]any{"channel_id": ch.ID, "content": "hi bob"},
	}
	raw, _ := json.Marshal(sendMsg)
	if err := aliceWS.Write(context.Background(), websocket.MessageText, raw); err != nil {
		t.Fatalf("write chat_send: %v", err)
	}

	deadline := time.Now().Add(10 * time.Second)
	var created struct {
		ID int64 `json:"id"`
	}
	if !readUntil(t, bobWS, "dm_request", &created, deadline) {
		t.Fatal("bob's live connection never saw the creation dm_request")
	}
	if created.ID == 0 {
		t.Fatal("dm_request payload carried no id")
	}

	// Decide over REST — not a WebSocket session at all.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/dm-requests/"+strconv.FormatInt(created.ID, 10)+"/ignore", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("POST .../ignore = %d, body=%s", rr.Code, rr.Body.String())
	}

	var transitioned struct {
		State string `json:"state"`
	}
	if !readUntil(t, bobWS, "dm_request", &transitioned, time.Now().Add(10*time.Second)) {
		t.Fatal("bob's live connection never saw the transition dm_request")
	}
	if transitioned.State != "ignored" {
		t.Errorf("transition dm_request state = %q, want ignored", transitioned.State)
	}
}
