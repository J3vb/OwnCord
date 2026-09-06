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
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
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

// readSeqFrame reads one frame and returns its "seq" field (0 if absent) —
// enough to track a client's lastSeq the way a real client would for resume.
func readSeqFrame(t *testing.T, conn *websocket.Conn) (frameType string, seq uint64) {
	t.Helper()
	readCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, msg, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var frame struct {
		Type string `json:"type"`
		Seq  uint64 `json:"seq"`
	}
	if err := json.Unmarshal(msg, &frame); err != nil {
		t.Fatalf("decode frame: %v; raw=%s", err, msg)
	}
	return frame.Type, frame.Seq
}

// TestNewRouter_MessageRequest_CreationAndSendDoNotLeakToReplay is Codex
// P1-1's end-to-end regression: neither POST /api/v1/dms nor an untrusted
// sender's first message may become visible to the recipient through
// reconnect replay. bob is online long enough to earn a real lastSeq from
// his own connect broadcast, then drops; while he is away, alice creates the
// DM and sends into it; bob's resume must replay neither a dm_channel_open
// nor the chat_message — his only signal is the dm_request his REST inbox
// already carries independently of replay.
func TestNewRouter_MessageRequest_CreationAndSendDoNotLeakToReplay(t *testing.T) {
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
	_, aliceToken := newUserSession("replayleakalice")
	bobID, bobToken := newUserSession("replayleakbob")

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	// bob connects first and earns a real lastSeq from his own connect
	// broadcast (member_join, then presence — both sequenced), then
	// disconnects. Everything else in this test happens while he is away.
	bobWS := dialAndAuthWS(t, srv, bobToken)
	// ready (frame 1) carries no seq; member_join (frame 2) is the ring
	// buffer's very first entry ever, seq 1. EventsSinceFiltered treats a
	// resume AT that oldest seq as unprovable (afterSeq <= oldestSeq) and
	// forces a full ready — reading connect presence (frame 3, also
	// sequenced) too gives a lastSeq of 2, past the buffer's floor, so the
	// resume below actually exercises the ring-buffer replay tier.
	var bobLastSeq uint64
	for range 3 {
		if _, seq := readSeqFrame(t, bobWS); seq > bobLastSeq {
			bobLastSeq = seq
		}
	}
	if bobLastSeq < 2 {
		t.Fatalf("bob's lastSeq = %d, want >= 2 so the resume below is not at the buffer's floor", bobLastSeq)
	}
	if err := bobWS.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("closing bob's connection: %v", err)
	}

	// alice creates the DM and sends the first message while bob is offline
	// and still untrusted.
	createBody, _ := json.Marshal(map[string]any{"recipient_id": bobID})
	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/dms", bytes.NewReader(createBody))
	createReq.Header.Set("Content-Type", "application/json")
	createReq.Header.Set("Authorization", "Bearer "+aliceToken)
	createReq.RemoteAddr = "127.0.0.1:9999"
	createRR := httptest.NewRecorder()
	handler.ServeHTTP(createRR, createReq)
	if createRR.Code != http.StatusCreated {
		t.Fatalf("POST /dms = %d, body=%s", createRR.Code, createRR.Body.String())
	}
	var created struct {
		ChannelID int64 `json:"channel_id"`
	}
	if err := json.Unmarshal(createRR.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}

	aliceWS := dialAndAuthWS(t, srv, aliceToken)
	sendMsg := map[string]any{
		"type":    "chat_send",
		"id":      "req-leak-1",
		"payload": map[string]any{"channel_id": created.ChannelID, "content": "hi bob"},
	}
	raw, _ := json.Marshal(sendMsg)
	if err := aliceWS.Write(context.Background(), websocket.MessageText, raw); err != nil {
		t.Fatalf("write chat_send: %v", err)
	}
	if !readUntil(t, aliceWS, "chat_message", nil, time.Now().Add(10*time.Second)) {
		t.Fatal("alice never saw her own chat_message — the send itself must succeed (decision 5)")
	}

	// bob resumes with the lastSeq from before he went away. Read every
	// frame the resume produces (auth_ok, replay, presence) and fail on the
	// first sign of the withheld conversation.
	bobResumeCtx, bobResumeCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer bobResumeCancel()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/ws"
	bobResume, resumeResp, dialErr := websocket.Dial(bobResumeCtx, wsURL, nil)
	if resumeResp != nil && resumeResp.Body != nil {
		defer resumeResp.Body.Close() //nolint:errcheck // test cleanup
	}
	if dialErr != nil {
		t.Fatalf("websocket.Dial (resume): %v", dialErr)
	}
	t.Cleanup(func() { _ = bobResume.Close(websocket.StatusNormalClosure, "") })
	authMsg, _ := json.Marshal(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": bobToken, "last_seq": bobLastSeq},
	})
	if err := bobResume.Write(bobResumeCtx, websocket.MessageText, authMsg); err != nil {
		t.Fatalf("write resume auth: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		readCtx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
		_, msg, readErr := bobResume.Read(readCtx)
		cancel()
		if readErr != nil {
			break
		}
		var frame struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(msg, &frame); err != nil {
			continue
		}
		if frame.Type == "dm_channel_open" || frame.Type == "chat_message" {
			t.Fatalf("bob's resume replayed %q — the withheld conversation leaked: %s", frame.Type, msg)
		}
	}
}
