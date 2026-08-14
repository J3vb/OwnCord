package ws_test

// reconnect_interior_gap_test.go — regression test for OC-0062: the cold-tier
// replay path checked only for a *prefix* gap (retention pruning ahead of
// last_seq) and a *tail* gap (ring buffer not covering the post-flush tail),
// but never checked for a *hole in the middle* of the persisted range. The
// EventPersister can lose an individual row (a full queue drops silently in
// Enqueue, and a per-row insert failure inside a batch flush is logged but
// never surfaced to the replay path — see event_persister.go), leaving the
// events table with an interior gap. handleReconnect's cold tier must not
// accept that as a complete resume: the client tracks only max(seq), so a
// silently skipped seq can never be requested again.

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
	"github.com/owncord/server/ws"
)

// TestReconnect_InteriorGap_ForcesFullReady locks the guard that must be added
// to handleReconnect's cold-tier branch: when the persisted rows above
// last_seq have a hole somewhere in the middle (not at the very start, which
// the oldest-seq probe already catches), the cold-tier replay must not be
// delivered as a complete "db" resume.
//
// Setup mirrors TestReconnect_BufferMiss_FallsBackToDBTier, but seq 550 is
// never persisted — simulating a single row the EventPersister lost — while
// every other seq in 501..600 is present. The channel-filtered query
// (channelIDs empty, so only channel_id=0 rows are considered — all of ours
// are global) returns a 99-row result that:
//   - is not at the maxColdReplay cap (so the truncation guard doesn't fire)
//   - starts at seq 501, i.e. oldest[0].Seq(501) == lastSeq+1(501), so the
//     prefix-gap probe passes
//   - has its newest row (600) fully covered by the ring buffer tail, so the
//     tail-coverage guard passes
//
// Only an unfiltered contiguity check over (last_seq, max_persisted_seq]
// catches the missing 550.
func TestReconnect_InteriorGap_ForcesFullReady(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()

	userID, err := database.CreateUser(context.Background(), "reconnect-gap-user", "hash", 1)
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

	// Persist 501..600 EXCEPT 550 — simulating one row the EventPersister
	// lost (full-queue drop or a per-row insert failure during flush).
	eventStore := openEventStoreDB(t)
	bgCtx := context.Background()
	for seq := int64(501); seq <= 600; seq++ {
		if seq == 550 {
			continue
		}
		payload := fmt.Appendf(nil, `{"seq":%d,"type":"broadcast"}`, seq)
		if err := eventStore.PersistEvent(bgCtx, seq, "broadcast", 0, payload); err != nil {
			t.Fatalf("PersistEvent seq=%d: %v", seq, err)
		}
	}

	hub := ws.NewHub(database, limiter, nil)
	hub.SetEventStore(eventStore)
	go hub.Run()
	defer hub.Stop()

	// Ring buffer holds 501..1500, so last_seq=500 misses it and the cold
	// tier is consulted; the buffer fully covers everything above the
	// newest persisted row (600), so the tail-coverage guard alone would
	// wrongly let this replay through.
	rb := hub.ReplayBuffer()
	dummyPayload := []byte(`{"type":"broadcast"}`)
	for seq := uint64(501); seq <= 1500; seq++ {
		rb.Push(seq, 0, dummyPayload)
	}
	if oldest := rb.OldestSeq(); oldest != 501 {
		t.Fatalf("pre-condition: expected oldestSeq=501, got %d", oldest)
	}

	handler := ws.ServeWS(hub, database, []string{"*"})
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

	// The first message back must NOT be auth_ok with replay_source="db" —
	// accepting the 99-row result as a complete resume silently skips seq
	// 550 forever, since the client only ever tracks max(seq).
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
			t.Fatalf("reconnect accepted a cold-tier replay with an interior gap (missing seq 550) as a complete db-tier resume: %s", msg)
		}
	}

	_, dbTier, fullTier := hub.ReconnectTierStats()
	if dbTier != 0 {
		t.Errorf("db tier count = %d, want 0: a persisted range with an interior gap was delivered as a complete resume", dbTier)
	}
	if fullTier != 1 {
		t.Errorf("full tier count = %d, want 1: an interior gap in the persisted range must force a full ready re-sync", fullTier)
	}
}
