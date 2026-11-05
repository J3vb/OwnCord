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
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// openEventStoreDB opens an in-memory database with the full migration set so
// the events table exists. *db.DB satisfies the hub's EventStore interface
// (D3 removed the store abstraction and its MemStore fake).
func openEventStoreDB(t *testing.T) *db.DB {
	t.Helper()
	return openMigratedDB(t)
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
	// channelID=0 means "global broadcast" — the DB event store's
	// GetEventsSinceForChannels returns them regardless of the allowed-channel
	// filter. role_id=1 intentionally does not exist in the test DB so
	// computeAllowedChannels returns an empty channel set; global events
	// bypass the per-channel filter, so they are always returned.
	store := openEventStoreDB(t)
	persistBroadcasts(t, store, 501, 600)
	rig := newWSRigWithStore(t, store)
	_, token := rig.seedUser(t, "reconnect-db-user", 1)

	// After 1000 pushes into a 1000-slot buffer, oldestSeq = 501 (the first
	// entry pushed). A client with last_seq=500 satisfies 500 <= 501, so
	// EventsSinceFiltered returns nil and the DB tier is invoked.
	fillRingBuffer(t, rig.hub, 501, 1500)

	// last_seq=500 triggers the reconnect path (handleReconnect) rather than
	// the fresh-connect path; the first message back must be auth_ok with
	// replay_source="db".
	_, resp := rig.dialResume(t, testCtx(t, 10*time.Second), token, 500)
	if resp["type"] != "auth_ok" {
		t.Fatalf("expected type=auth_ok, got %v; raw=%v", resp["type"], resp)
	}
	payloadField, _ := resp["payload"].(map[string]any)
	if payloadField["replay_source"] != "db" {
		t.Fatalf("expected replay_source=db, got %v", payloadField["replay_source"])
	}

	// hub.reconnectTierDB is incremented before auth_ok is sent, so the
	// counter is stable by the time we read auth_ok.
	_, dbTier, _ := rig.hub.ReconnectTierStats()
	if dbTier != 1 {
		t.Fatalf("expected db tier count=1, got %d", dbTier)
	}
	// WP 4.6a: the same resume is one ring miss — the denominator of the
	// events table's hit rate.
	if misses := rig.hub.ReconnectRingMissCount(); misses != 1 {
		t.Fatalf("expected ring miss count=1, got %d", misses)
	}
}

// TestReconnect_ColdTierAtRowLimit_ForcesFullReady locks the truncation guard.
//
// GetEventsSinceForChannels is "ORDER BY seq ASC LIMIT n", so a gap larger than
// the cap returns the OLDEST n rows and silently drops the newest. Replaying
// that as a successful resume looks complete to the client — it tracks only
// max(seq) and cannot detect the hole — so the dropped range is lost until some
// later full resync. State events (channel/role/member changes) in that range
// are never repaired by REST history fetches.
//
// Setup mirrors TestReconnect_BufferMiss_FallsBackToDBTier, but seeds 100 more
// events than the cap so the query comes back exactly full.
func TestReconnect_ColdTierAtRowLimit_ForcesFullReady(t *testing.T) {
	// Seed seqs 501..(500+cap+100): the query caps at `cap` rows, so the newest
	// 100 are dropped — the exact overflow condition.
	store := openEventStoreDB(t)
	const overflow = 100
	events := make([]db.PersistedEvent, 0, ws.MaxColdReplayForTest+overflow)
	for i := range ws.MaxColdReplayForTest + overflow {
		seq := int64(501 + i)
		events = append(events, db.PersistedEvent{
			Seq:       seq,
			EventType: "broadcast",
			ChannelID: 0,
			Payload:   fmt.Appendf(nil, `{"seq":%d,"type":"broadcast"}`, seq),
		})
	}
	if n, err := store.PersistEvents(context.Background(), events); err != nil || n != len(events) {
		t.Fatalf("PersistEvents: persisted %d/%d, err=%v", n, len(events), err)
	}
	rig := newWSRigWithStore(t, store)
	_, token := rig.seedUser(t, "reconnect-overflow-user", 1)

	// Ring buffer holds 501..1500, so last_seq=500 misses it and the cold tier
	// is consulted.
	fillRingBuffer(t, rig.hub, 501, 1500)

	// Reading the first frame guarantees the handshake picked a tier.
	rig.dialResume(t, testCtx(t, 30*time.Second), token, 500)

	_, dbTier, fullTier := rig.hub.ReconnectTierStats()
	if dbTier != 0 {
		t.Errorf("db tier count = %d, want 0: a truncated cold-tier replay was delivered as a complete resume", dbTier)
	}
	if fullTier != 1 {
		t.Errorf("full tier count = %d, want 1: an over-cap gap must force a full ready re-sync", fullTier)
	}
}

// TestReconnect_ColdTierMergesRingBufferTail locks the flush-lag hole: the
// EventPersister flushes asynchronously (~100ms batches), so cold rows can lag
// the live seq. Events broadcast after the last flush sit only in the ring
// buffer — a cold replay built from persisted rows alone presents an
// incomplete resume as complete (the client tracks only max(seq) and cannot
// detect the hole), which the maxColdReplay cap in the same function exists
// to prevent.
//
// Setup: cold rows 501..700; ring buffer holds 601..710 (so the buffer cannot
// serve last_seq=500 itself, but can serve everything past the newest
// persisted row). The replay must deliver 501..710 — the 200 cold rows plus
// the 10-event buffer tail.
func TestReconnect_ColdTierMergesRingBufferTail(t *testing.T) {
	store := openEventStoreDB(t)
	persistBroadcasts(t, store, 501, 700)
	rig := newWSRigWithStore(t, store)
	_, token := rig.seedUser(t, "reconnect-tail-user", 1)

	rb := rig.hub.ReplayBuffer()
	for seq := uint64(601); seq <= 710; seq++ {
		rb.Push(seq, 0, fmt.Appendf(nil, `{"seq":%d,"type":"broadcast"}`, seq))
	}

	ctx := testCtx(t, 15*time.Second)
	conn, resp := rig.dialResume(t, ctx, token, 500)
	if resp["type"] != "auth_ok" {
		t.Fatalf("expected auth_ok, got %v", resp)
	}

	// Count replayed frames; the highest seq seen must reach the buffer tail.
	var replayed int
	var maxSeq float64
	for {
		readCtx, readCancel := context.WithTimeout(ctx, 500*time.Millisecond)
		_, evt, readErr := conn.Read(readCtx)
		readCancel()
		if readErr != nil {
			break
		}
		var frame map[string]any
		if json.Unmarshal(evt, &frame) == nil && frame["type"] == "broadcast" {
			replayed++
			if s, ok := frame["seq"].(float64); ok && s > maxSeq {
				maxSeq = s
			}
		}
	}
	if replayed != 210 {
		t.Errorf("replayed %d events, want 210 (200 cold rows + 10 ring-buffer tail)", replayed)
	}
	if maxSeq != 710 {
		t.Errorf("max replayed seq = %.0f, want 710 — events after the last persister flush were silently dropped", maxSeq)
	}
}
