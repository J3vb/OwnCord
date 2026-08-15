package ws

// Internal tests for the 2026-08-06 harvest ws findings: kickClient ordering,
// topic-limiter seq consumption, limiter bucket pruning, dm_channel_open
// resync watermark, DM-lookup error propagation, writePump drain, and the
// failed-handshake presence teardown.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// A Subscribe racing kickClient (the channel_focus applier runs on the
// readPump goroutine concurrently with sweep/DisconnectUser kicks) must never
// leave the dead client holding the topic: nothing cleans it up afterwards
// and the user silently loses that channel's stream. registerNow documents
// the required ordering — closeSend BEFORE UnsubscribeAll — because
// Subscribe's only re-take guard is isSendClosed.
func TestKickClient_SubscribeRaceCannotLeaveDeadSubscriber(t *testing.T) {
	for range 300 {
		h := newEmitTestHub()
		c := NewTestClient(h, 1, make(chan []byte, 8))
		h.clients[1] = c
		h.pubsub.Subscribe(c, ChannelTopic(3))

		done := make(chan struct{})
		go func() {
			h.pubsub.Subscribe(c, ChannelTopic(3))
			close(done)
		}()
		h.kickClient(c)
		<-done

		h.pubsub.mu.RLock()
		sub := h.pubsub.topics[ChannelTopic(3)][1]
		h.pubsub.mu.RUnlock()
		if sub != nil {
			t.Fatal("a Subscribe racing kickClient left a dead client holding the topic — its user silently loses the channel stream")
		}
	}
}

// A frame shed by the topic rate limiter must not have consumed a sequence
// number: the client tracks only max(seq), so a seq that was buffered but
// never published is permanently invisible to replay — the codebase states
// this invariant twice (sendSequencedToUsers, the maxColdReplay cap comment).
func TestDeliverBroadcast_ShedFrameLeavesNoSeqGap(t *testing.T) {
	h := newEmitTestHub()
	send := make(chan []byte, 4096)
	c := NewTestClient(h, 1, send)
	h.clients[1] = c
	h.pubsub.Subscribe(c, ChannelTopic(5))

	total := topicRateLimitPerSecond + 20
	for range total {
		h.deliverBroadcast(broadcastMsg{channelID: 5, msg: []byte(`{"type":"chat_message"}`)})
	}

	deliveredSeqs := make(map[uint64]bool)
readLoop:
	for {
		select {
		case msg := <-send:
			var frame struct {
				Seq uint64 `json:"seq"`
			}
			if err := json.Unmarshal(msg, &frame); err == nil {
				deliveredSeqs[frame.Seq] = true
			}
		default:
			break readLoop
		}
	}

	// Walk the ring buffer directly (single-threaded here): every seq it
	// holds must also have been delivered live.
	for _, e := range h.replayBuf.entries {
		if e.seq == 0 {
			continue
		}
		if !deliveredSeqs[e.seq] {
			t.Fatalf("seq %d sits in the replay buffer but was never published live — a shed frame consumed it, and no client can ever request it back", e.seq)
		}
	}
	if len(deliveredSeqs) == 0 {
		t.Fatal("test broken: nothing was delivered at all")
	}
}

// The per-channel token buckets are created on first broadcast and were never
// pruned in production — Cleanup existed but had no caller. The stale-client
// tick is the natural place.
func TestStaleTick_PrunesIdleTopicLimiterBuckets(t *testing.T) {
	h := newEmitTestHub()
	h.topicLimiter.Allow(ChannelTopic(9))

	h.topicLimiter.mu.Lock()
	h.topicLimiter.buckets[ChannelTopic(9)].lastReset = time.Now().Add(-time.Hour)
	h.topicLimiter.mu.Unlock()

	h.onStaleTick()

	h.topicLimiter.mu.Lock()
	_, exists := h.topicLimiter.buckets[ChannelTopic(9)]
	h.topicLimiter.mu.Unlock()
	if exists {
		t.Error("idle topic bucket survived the stale tick — the bucket map grows for the process lifetime")
	}
}

// dm_channel_open is unsequenced and targeted: an addressee mid-reconnect
// never receives it, while the DM's sequenced chat_message replays fine —
// leaving an unreachable channel until the next full ready. Emitting one must
// bump the visibility watermark so any client resuming from a seq at or
// before the open takes the full-ready path (whose payload includes DMs).
func TestEmitEvents_DMChannelOpenForcesFullResyncForOlderClients(t *testing.T) {
	h := newEmitTestHub()
	atomic.StoreUint64(&h.seq, 40)

	h.EmitEvents(context.Background(), []Event{
		DMChannelOpenEvent{targetUserID: 7, payload: []byte(`{"type":"dm_channel_open"}`)},
	})

	if !h.mustFullResync(40) {
		t.Error("a client resuming from a seq at or before a dm_channel_open must be forced onto the full-ready path")
	}
	if h.mustFullResync(41) {
		t.Error("clients past the open must keep replaying normally")
	}
}

// computeAllowedChannels treated a DM-channel lookup failure as non-fatal,
// silently stripping every DM event from the replay while the client's
// lastSeq advances past them — a permanent hole. Its three sibling lookups
// in the same function are fatal, and handleReconnect's error path already
// falls back to the safe full-ready resync.
func TestComputeAllowedChannels_DMLookupErrorIsFatal(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	userID, _ := database.CreateUser(context.Background(), "dm-lookup-err", "hash", 1)
	user, _ := database.GetUserByID(context.Background(), userID)
	h := NewHub(database, auth.NewRateLimiter(), nil)

	// Fault-inject exactly the DM lookup; the earlier role/channel lookups
	// keep working.
	if _, err := database.ExecContext(context.Background(), `DROP TABLE dm_open_state`); err != nil {
		t.Fatalf("drop dm_open_state: %v", err)
	}

	if _, err := h.computeAllowedChannels(context.Background(), database, user); err == nil {
		t.Error("a failed DM-channel lookup must be an error (forcing full ready), not a silently DM-stripped replay")
	}
}

// The kick paths queue their reason frame (e.g. the BANNED error that makes
// the client clear its credentials) on c.send and then close all send
// channels, relying on writePump to drain remaining messages — serve.go and
// hub_broadcast.go both document that contract. A pump that returns the
// moment it sees a closed channel drops the frame.
func TestWritePump_DrainsQueuedFramesAfterCloseSend(t *testing.T) {
	frame := []byte(`{"type":"error","payload":{"code":"BANNED"}}`)
	c := &Client{
		userID:   1,
		send:     make(chan []byte, 8),
		sendHigh: make(chan []byte, 8),
		sendLow:  make(chan []byte, 8),
	}
	c.send <- frame
	c.closeSend()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, acceptErr := websocket.Accept(w, r, nil)
		if acceptErr != nil {
			return
		}
		writePump(r.Context(), conn, c)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if resp != nil && resp.Body != nil {
		resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	_, msg, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("kick frame was dropped instead of drained: %v", err)
	}
	if !bytes.Contains(msg, []byte("BANNED")) {
		t.Fatalf("unexpected frame before close: %s", msg)
	}
}

// When a post-registerNow handshake write fails, no readPump ever starts for
// the new connection, and the replaced old connection's defer already ran
// (skipping teardown because the new client held the slot) — so nobody marks
// the user offline. The failure path must run the standard disconnect
// teardown itself whenever unregisterNow reports no replacement holds the
// slot.
func TestFailedHandshake_MarksUserOfflineWhenNoReplacementRemains(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	userID, _ := database.CreateUser(context.Background(), "handshake-fail", "hash", 1)
	if err := database.UpdateUserStatus(context.Background(), userID, "online"); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}
	h := NewHub(database, auth.NewRateLimiter(), nil)

	// Old connection A holds the slot; B replaces it (registerNow kicks A);
	// A's readPump defer runs while B holds the slot → teardown skipped.
	oldClient := NewTestClient(h, userID, make(chan []byte, 8))
	oldClient.user = &db.User{ID: userID, Status: "online"}
	h.clients[userID] = oldClient

	newClient := NewTestClient(h, userID, make(chan []byte, 8))
	newClient.user = &db.User{ID: userID, Status: "online"}
	newClient.lastSeq = 1
	h.registerNow(newClient, nil)
	if replaced := h.unregisterNow(oldClient); !replaced {
		t.Fatal("precondition: old client's defer must see itself replaced")
	}

	// B's auth_ok/ready write fails; the handshake failure path runs.
	h.unregisterFailedHandshake(context.Background(), newClient)

	user, err := database.GetUserByID(context.Background(), userID)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if user.Status == "online" {
		t.Error("user stuck online after a failed handshake with no surviving connection")
	}

	// The other clients must hear about it too. Presence goes through the
	// QueuePresence coalescer now — force the flush instead of waiting out
	// the window.
	h.flushPresenceQueue()
	select {
	case bm := <-h.broadcast:
		if !bytes.Contains(bm.msg, []byte("presence")) {
			t.Errorf("expected a presence broadcast, got %s", bm.msg)
		}
	default:
		t.Error("no presence broadcast queued after the failed handshake teardown")
	}
}
