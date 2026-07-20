package ws_test

// reconnect_db_test.go — buffer-miss → DB cold-tier replay integration test.
//
// The hub's ring buffer holds 1000 events. When a reconnecting client's
// last_seq is older than the buffer's oldest entry, EventsSinceFiltered returns
// nil and handleReconnect falls back to the EventStore. This file verifies that
// code path end-to-end against a real httptest WebSocket server.

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
	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// openEventStoreDB opens an in-memory database with the full migration set so
// the events table exists. *db.DB satisfies the hub's EventStore interface
// (D3 removed the store abstraction and its MemStore fake).
func openEventStoreDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// TestReconnect_BufferMiss_FallsBackToDBTier verifies that when a client
// reconnects with a last_seq that is older than the ring buffer's oldest entry,
// the hub falls back to the EventStore (DB tier) and sends the missed events.
//
// Setup:
//   - Ring buffer size = 1000; push seqs 501..1500 → oldestSeq = 501.
//   - The DB event store contains 100 global events at seqs 501..600.
//   - Client reconnects with last_seq = 500.
//   - Buffer: 500 <= 501 → returns nil.
//   - DB: returns seqs > 500 with channelID = 0 (global, no permission filter).
//
// Asserts:
//   - auth_ok is received with replay_source = "db".
//   - hub.ReconnectTierStats() db counter = 1.
func TestReconnect_BufferMiss_FallsBackToDBTier(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()

	// Create a user. role_id=1 intentionally does not exist in the test DB so
	// computeAllowedChannels returns an empty channel set — but events with
	// channelID=0 (global) bypass the per-channel filter in the DB event store
	// and in EventsSinceFiltered, so they are always returned.
	userID, err := database.CreateUser("reconnect-db-user", "hash", 1)
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

	// Pre-populate the event store with 100 global events (seqs 501..600).
	// channelID=0 means "global broadcast" — the DB event store's
	// GetEventsSinceForChannels returns them regardless of the allowed-channel
	// filter.
	eventStore := openEventStoreDB(t)
	bgCtx := context.Background()
	for seq := int64(501); seq <= 600; seq++ {
		payload := []byte(fmt.Sprintf(`{"seq":%d,"type":"broadcast"}`, seq))
		if err := eventStore.PersistEvent(bgCtx, seq, "broadcast", 0, payload); err != nil {
			t.Fatalf("PersistEvent seq=%d: %v", seq, err)
		}
	}

	// Build hub, attach the DB event store as the cold-tier read path.
	hub := ws.NewHub(database, limiter, nil)
	hub.SetEventStore(eventStore)
	go hub.Run()
	defer hub.Stop()

	// Fill the ring buffer with seqs 501..1500 (exactly 1000 entries).
	// After 1000 pushes into a 1000-slot buffer, oldestSeq = 501 (the first
	// entry pushed).  A client with last_seq=500 satisfies 500 <= 501, so
	// EventsSinceFiltered returns nil and the DB tier is invoked.
	rb := hub.ReplayBuffer()
	dummyPayload := []byte(`{"type":"broadcast"}`)
	for seq := uint64(501); seq <= 1500; seq++ {
		rb.Push(seq, 0, dummyPayload)
	}
	if oldest := rb.OldestSeq(); oldest != 501 {
		t.Fatalf("pre-condition: expected oldestSeq=501, got %d", oldest)
	}

	// Spin up a real HTTP+WS server.
	handler := ws.ServeWS(hub, database, []string{"*"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	dialCtx, cancel := context.WithTimeout(bgCtx, 10*time.Second)
	defer cancel()

	// Dial and authenticate with last_seq=500 — this triggers the reconnect
	// path (handleReconnect) rather than the fresh-connect path.
	conn, dialResp, dialErr := websocket.Dial(dialCtx, wsURL, nil)
	if dialResp != nil && dialResp.Body != nil {
		_ = dialResp.Body.Close()
	}
	if dialErr != nil {
		t.Fatalf("websocket.Dial: %v", dialErr)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	authMsg := map[string]any{
		"type": "auth",
		"payload": map[string]any{
			"token":    token,
			"last_seq": uint64(500),
		},
	}
	raw, _ := json.Marshal(authMsg)
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	// The first message back must be auth_ok with replay_source="db".
	_, msg, err := conn.Read(dialCtx)
	if err != nil {
		t.Fatalf("read auth_ok: %v", err)
	}
	var resp map[string]any
	if err := json.Unmarshal(msg, &resp); err != nil {
		t.Fatalf("unmarshal response: %v; raw=%s", err, msg)
	}
	if resp["type"] != "auth_ok" {
		t.Fatalf("expected type=auth_ok, got %v; raw=%s", resp["type"], msg)
	}
	payloadField, _ := resp["payload"].(map[string]any)
	if payloadField["replay_source"] != "db" {
		t.Fatalf("expected replay_source=db, got %v", payloadField["replay_source"])
	}

	// hub.reconnectTierDB is incremented before auth_ok is sent, so the
	// counter is stable by the time we read auth_ok.
	_, dbTier, _ := hub.ReconnectTierStats()
	if dbTier != 1 {
		t.Fatalf("expected db tier count=1, got %d", dbTier)
	}
}
