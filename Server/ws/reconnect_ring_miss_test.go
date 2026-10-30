package ws

// reconnect_ring_miss_test.go — WP 4.6a: the reconnect ring-miss counter.
//
// reconnectRingMiss counts a resume only when the in-memory replay ring cannot
// serve it because the client is BEHIND the ring (the one case the events
// table can rescue). An empty ring, a client ahead of the ring, a resync
// watermark and a ring hit must all leave it at zero.

import (
	"context"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

const ringMissRingSize = 10

type ringMissEnv struct {
	hub    *Hub
	db     *db.DB
	userID int64
	user   *db.User
	token  string
}

// newRingMissEnv builds a hub with a ringMissRingSize-slot ring, one Member
// with a live session, and (when withStore) the database attached as the
// cold-tier EventStore.
func newRingMissEnv(t *testing.T, withStore bool) *ringMissEnv {
	t.Helper()
	database := newTeardownTestDB(t)
	ctx := context.Background()
	userID, err := database.CreateUser(ctx, "ring-miss-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByID(ctx, userID)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	hub := newTestHubWith(t, HubOptions{DB: database, Limiter: auth.NewRateLimiter(), ReplayRingSize: ringMissRingSize})
	if withStore {
		hub.SetEventStore(database)
	}
	go hub.Run()
	t.Cleanup(hub.Stop)
	return &ringMissEnv{hub: hub, db: database, userID: userID, user: user, token: token}
}

// pushRing fills the ring with global frames from..to inclusive.
func (e *ringMissEnv) pushRing(from, to uint64) {
	for seq := from; seq <= to; seq++ {
		e.hub.ReplayBuffer().Push(seq, 0, fmt.Appendf(nil, `{"seq":%d,"type":"broadcast"}`, seq))
	}
}

// persist writes global rows from..to inclusive to the events table.
func (e *ringMissEnv) persist(t *testing.T, from, to int64) {
	t.Helper()
	for seq := from; seq <= to; seq++ {
		if err := e.db.PersistEvent(context.Background(), seq, "broadcast", 0, fmt.Appendf(nil, `{"seq":%d,"type":"broadcast"}`, seq)); err != nil {
			t.Fatalf("PersistEvent seq=%d: %v", seq, err)
		}
	}
}

func (e *ringMissEnv) tiers() (buffer, dbTier, full, misses uint64) {
	buffer, dbTier, full = e.hub.ReconnectTierStats()
	return buffer, dbTier, full, e.hub.ReconnectRingMissCount()
}

// Edge case 1: the ring misses and the cold tier qualifies, then the ring
// tail is evicted before register. The resume ends as a full ready: miss +1,
// full +1, db +0 (tier db counts only after a successful register).
func TestReconnect_RingMiss_TailEvictedBeforeRegisterCountsFull(t *testing.T) {
	e := newRingMissEnv(t, true)
	ctx := context.Background()
	e.persist(t, 11, 15)
	e.pushRing(11, 20) // oldest = 11, so lastSeq 10 is behind the ring

	c := NewTestClient(e.hub, e.userID, make(chan []byte, 8))
	c.user = e.user
	allowed, readable, ok := e.hub.reconnectPrecheck(ctx, c, 10)
	if !ok {
		t.Fatal("reconnectPrecheck refused the resume")
	}
	events, source, tail, maxSeq := e.hub.reconnectSelectReplay(ctx, c, 10, allowed, readable)
	if events == nil || source != "db" {
		t.Fatalf("select = %d events from %q, want the db tier", len(events), source)
	}

	e.pushRing(21, 30) // evicts every frame at or below the persisted tail
	if _, ok := e.hub.reconnectRegister(ctx, c, 10, allowed, readable, source, tail, maxSeq); ok {
		t.Fatal("reconnectRegister succeeded although the ring no longer covers the tail")
	}
	buffer, dbTier, full, misses := e.tiers()
	if misses != 1 || full != 1 || dbTier != 0 || buffer != 0 {
		t.Fatalf("buffer/db/full/misses = %d/%d/%d/%d, want 0/0/1/1", buffer, dbTier, full, misses)
	}
}

// Edge case 2: persistence off, a resume behind the ring. No EventStore, so
// the resume takes a full ready: miss +1, full +1.
func TestReconnect_RingMiss_CountedWithoutEventStore(t *testing.T) {
	t.Parallel()
	e := newRingMissEnv(t, false)
	e.pushRing(11, 20)

	dialAndResume(t, e.hub, e.token, 10)
	buffer, dbTier, full, misses := e.tiers()
	if misses != 1 || full != 1 || dbTier != 0 || buffer != 0 {
		t.Fatalf("buffer/db/full/misses = %d/%d/%d/%d, want 0/0/1/1", buffer, dbTier, full, misses)
	}
}

// A resync watermark past last_seq forces a full ready before any tier is
// tried, so the ring is never consulted and nothing is counted as a miss.
func TestReconnect_RingMiss_NotCountedWhenWatermarkForcesFull(t *testing.T) {
	t.Parallel()
	e := newRingMissEnv(t, true)
	e.pushRing(11, 20)
	e.hub.SeedSeq(30)
	e.hub.MarkVisibilityChanged() // watermark 30 >= last_seq 10

	dialAndResume(t, e.hub, e.token, 10)
	buffer, dbTier, full, misses := e.tiers()
	if misses != 0 || full != 1 || dbTier != 0 || buffer != 0 {
		t.Fatalf("buffer/db/full/misses = %d/%d/%d/%d, want 0/0/1/0", buffer, dbTier, full, misses)
	}
}

// The ring also returns nil for an empty ring and for a client ahead of it;
// the events table cannot serve either, so neither is a miss. A client at or
// behind the oldest entry is.
func TestReconnect_RingMiss_NotCountedForClientAheadOrEmptyRing(t *testing.T) {
	e := newRingMissEnv(t, false)
	ctx := context.Background()
	c := NewTestClient(e.hub, e.userID, make(chan []byte, 8))
	c.user = e.user
	allowed := map[int64]bool{}

	if events, _, _, _ := e.hub.reconnectSelectReplay(ctx, c, 5, allowed, allowed); events != nil {
		t.Fatal("empty ring served a resume")
	}
	if got := e.hub.ReconnectRingMissCount(); got != 0 {
		t.Fatalf("empty ring counted %d misses, want 0", got)
	}

	e.pushRing(11, 20)
	if events, _, _, _ := e.hub.reconnectSelectReplay(ctx, c, 25, allowed, allowed); events != nil {
		t.Fatal("ring served a client ahead of it")
	}
	if got := e.hub.ReconnectRingMissCount(); got != 0 {
		t.Fatalf("client ahead of the ring counted %d misses, want 0", got)
	}

	// Boundary: last_seq == oldest is behind the ring (the ring needs
	// lastSeq > oldest), and so is anything below it.
	for i, lastSeq := range []uint64{11, 3} {
		if events, _, _, _ := e.hub.reconnectSelectReplay(ctx, c, lastSeq, allowed, allowed); events != nil {
			t.Fatalf("ring served last_seq %d at or behind its oldest entry", lastSeq)
		}
		if got := e.hub.ReconnectRingMissCount(); got != uint64(i+1) {
			t.Fatalf("after last_seq %d: %d misses, want %d", lastSeq, got, i+1)
		}
	}
}

// A ring hit is a buffer-tier resume and never a miss.
func TestReconnect_RingMiss_NotCountedOnBufferHit(t *testing.T) {
	t.Parallel()
	e := newRingMissEnv(t, true)
	e.pushRing(11, 20)

	dialAndResume(t, e.hub, e.token, 15)
	buffer, dbTier, full, misses := e.tiers()
	if buffer != 1 || misses != 0 || dbTier != 0 || full != 0 {
		t.Fatalf("buffer/db/full/misses = %d/%d/%d/%d, want 1/0/0/0", buffer, dbTier, full, misses)
	}
}

// TestWindowSources_IncludesRingMisses pins that the windowed sampler reads the
// same atomic the lifetime accessor does.
func TestWindowSources_IncludesRingMisses(t *testing.T) {
	e := newRingMissEnv(t, false)
	e.hub.reconnectRingMiss.Add(3)
	_, _, counters := e.hub.WindowSources()
	for _, nc := range counters {
		if nc.Name != "reconnect_ring_misses" {
			continue
		}
		if got := nc.Read(); got != 3 {
			t.Fatalf("window source reads %d, want 3", got)
		}
		if got := e.hub.ReconnectRingMissCount(); got != 3 {
			t.Fatalf("ReconnectRingMissCount = %d, want 3", got)
		}
		return
	}
	t.Fatal("reconnect_ring_misses is not a registered window source")
}
