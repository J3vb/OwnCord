package ws_test

// reconnect_pruned_prefix_test.go — regression test for the retention-pruning
// gap (finding v000): PruneEventsOlderThan deletes cold-tier rows purely by
// created_at with no seq-floor coordination, so a client whose last_seq
// predates the retention cutoff can see a channel-filtered cold-tier query
// return a non-empty *suffix* of rows that starts well after last_seq+1.
// handleReconnect must detect that gap with an unfiltered oldest-seq probe
// and force a full ready re-sync rather than replaying the surviving suffix
// as if it were a complete resume.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/ws"
)

// TestReconnect_PrunedPrefix_ForcesFullReady locks the guard added in
// handleReconnect's cold-tier branch: when retention pruning has deleted the
// events immediately after last_seq, the surviving suffix returned by
// GetEventsSinceForChannels must NOT be accepted as a complete resume.
//
// Setup mirrors TestReconnect_BufferMiss_FallsBackToDBTier, but simulates a
// pruned prefix: only seqs 1000..1100 are persisted (as if 1..999 were
// pruned by PruneEventsOlderThan), and the ring buffer only covers the same
// range (as if it, too, has rolled past the pruned events). A client
// reconnecting with last_seq=500 has a store that is unfiltered-non-empty but
// whose oldest surviving seq (1000) is far past last_seq+1 (501) — the exact
// condition the oldest-seq probe (es.GetEventsSince(ctx, 0, 1)) must catch.
func TestReconnect_PrunedPrefix_ForcesFullReady(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()

	userID, err := database.CreateUser(context.Background(), "reconnect-pruned-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Only seqs 1000..1100 survive in the cold-tier store — everything from
	// 1..999 has already been pruned by PruneEventsOlderThan, which deletes by
	// created_at with no seq-floor coordination.
	eventStore := openEventStoreDB(t)
	bgCtx := context.Background()
	for seq := int64(1000); seq <= 1100; seq++ {
		payload := fmt.Appendf(nil, `{"seq":%d,"type":"broadcast"}`, seq)
		if err := eventStore.PersistEvent(bgCtx, seq, "broadcast", 0, payload); err != nil {
			t.Fatalf("PersistEvent seq=%d: %v", seq, err)
		}
	}

	hub := newTestHubDeps(t, database, limiter, nil)
	hub.SetEventStore(eventStore)
	go hub.Run()
	defer hub.Stop()

	// The ring buffer has also rolled past the pruned range: only 1000..1100
	// are present, so a client at last_seq=500 misses the buffer entirely and
	// the cold tier is consulted.
	rb := hub.ReplayBuffer()
	dummyPayload := []byte(`{"type":"broadcast"}`)
	for seq := uint64(1000); seq <= 1100; seq++ {
		rb.Push(seq, 0, dummyPayload)
	}
	if oldest := rb.OldestSeq(); oldest != 1000 {
		t.Fatalf("pre-condition: expected oldestSeq=1000, got %d", oldest)
	}

	handler := ws.ServeWS(hub, []string{"*"}, 0)
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	dialCtx, cancel := context.WithTimeout(bgCtx, 10*time.Second)
	defer cancel()

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

	// The first message back must be the full ready payload (type "ready"),
	// NOT auth_ok with replay_source="db" — accepting the surviving suffix as
	// a complete resume would silently skip every event between last_seq and
	// the pruning cutoff.
	_, msg, err := conn.Read(dialCtx)
	if err != nil {
		t.Fatalf("read handshake response: %v", err)
	}
	var resp map[string]any
	if err := json.Unmarshal(msg, &resp); err != nil {
		t.Fatalf("unmarshal response: %v; raw=%s", err, msg)
	}
	if resp["type"] == "auth_ok" {
		if payloadField, _ := resp["payload"].(map[string]any); payloadField["replay_source"] == "db" {
			t.Fatalf("reconnect accepted a pruned-prefix suffix as a complete db-tier resume: %s", msg)
		}
	}

	_, dbTier, fullTier := hub.ReconnectTierStats()
	if dbTier != 0 {
		t.Errorf("db tier count = %d, want 0: a suffix left behind by retention pruning was delivered as a complete resume", dbTier)
	}
	if fullTier != 1 {
		t.Errorf("full tier count = %d, want 1: a gap before last_seq left by retention pruning must force a full ready re-sync", fullTier)
	}
}
