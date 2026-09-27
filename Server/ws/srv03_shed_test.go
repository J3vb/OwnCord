package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// SRV-03: a committed chat_message whose frame is lost before a seq is
// assigned — shed by the topic limiter, or dropped by a full broadcast queue —
// reached no live client, and replay can never carry it because it consumed no
// seq. Both triggers must force a client resuming from a seq at or behind the
// loss onto the full-ready path, whose history refetch recovers the message
// from the database. Driven end to end: committed rows, EmitEvents through the
// running dispatch loop, and a real auth-frame resume over ServeWS.
func TestContentFrameLoss_ResumingClientTakesFullReadyAndRecoversMessage(t *testing.T) {
	type trigger struct {
		name string
		// lose commits and emits messages until one is lost before
		// sequencing, returning the lost message's id.
		lose func(t *testing.T, ctx context.Context, h *Hub, emit func() int64) int64
	}
	triggers := []trigger{
		{name: "topic limiter above 100 frames/s", lose: func(t *testing.T, ctx context.Context, h *Hub, emit func() int64) int64 {
			go h.Run()
			var last int64
			for range topicRateLimitPerSecond + 5 {
				last = emit()
			}
			waitDispatchDrained(t, ctx, h)
			if got := h.TopicShedCount(); got != 5 {
				t.Fatalf("TopicShedCount = %d, want 5", got)
			}
			return last
		}},
		{name: "full broadcast queue", lose: func(t *testing.T, ctx context.Context, h *Hub, emit func() int64) int64 {
			for range cap(h.broadcast) {
				h.BroadcastToAll([]byte(`{"type":"server_filler"}`))
			}
			lost := emit()
			if got := h.BroadcastDropCount(); got != 1 {
				t.Fatalf("BroadcastDropCount = %d, want 1", got)
			}
			go h.Run()
			waitDispatchDrained(t, ctx, h)
			return lost
		}},
	}

	for _, tc := range triggers {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			database := newTeardownTestDB(t)
			userID, err := database.CreateUser(ctx, "srv03-user", "hash", 4) // Member
			if err != nil {
				t.Fatalf("CreateUser: %v", err)
			}
			chID, err := database.CreateChannel(ctx, "srv03-busy", "text", "", "", 0)
			if err != nil {
				t.Fatalf("CreateChannel: %v", err)
			}
			token, err := auth.GenerateToken()
			if err != nil {
				t.Fatalf("GenerateToken: %v", err)
			}
			if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
				t.Fatalf("CreateSession: %v", err)
			}

			h := newTestHub(t, database, auth.NewRateLimiter(), nil)
			t.Cleanup(h.Stop)

			emit := func() int64 {
				msgID, err := database.CreateMessage(ctx, chID, userID, "srv03", nil)
				if err != nil {
					t.Fatalf("CreateMessage: %v", err)
				}
				payload := fmt.Appendf(nil, `{"type":"chat_message","payload":{"id":%d,"channel_id":%d,"content":"srv03"}}`, msgID, chID)
				h.EmitEvents(ctx, []Event{channelEvt{evType: MsgTypeChatMessage, channelID: chID, payload: payload}})
				return msgID
			}
			lostID := tc.lose(t, ctx, h, emit)

			// The client received every frame that was sequenced, so its
			// last_seq sits exactly at the loss.
			lastSeq := atomic.LoadUint64(&h.seq)
			var sawReady bool
			for _, frame := range dialAndResume(t, h, token, lastSeq) {
				var env struct {
					Type string `json:"type"`
				}
				if json.Unmarshal(frame, &env) == nil && env.Type == MsgTypeReady {
					sawReady = true
				}
			}
			if !sawReady {
				t.Fatalf("resume from last_seq %d after a lost content frame got no ready frame", lastSeq)
			}
			if buffer, db, full := h.ReconnectTierStats(); full != 1 || buffer != 0 || db != 0 {
				t.Fatalf("ReconnectTierStats = (buffer %d, db %d, full %d), want the full tier only", buffer, db, full)
			}

			history, err := database.GetMessagesForAPI(ctx, chID, 0, 200, userID)
			if err != nil {
				t.Fatalf("GetMessagesForAPI: %v", err)
			}
			for _, m := range history {
				if m.ID == lostID {
					return
				}
			}
			t.Fatalf("lost message %d missing from the history a full ready refetches", lostID)
		})
	}
}

// waitDispatchDrained waits for the dispatch loop to start and sequence every
// frame queued so far.
func waitDispatchDrained(t *testing.T, ctx context.Context, h *Hub) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !h.running.Load() {
		if time.Now().After(deadline) {
			t.Fatal("dispatch loop never started")
		}
		time.Sleep(time.Millisecond)
	}
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}
}

// A metadata frame (nsfwChannelID == 0) that is shed must NOT ratchet the
// watermark: metadata kinds are ephemeral or reconstructed by other means, and
// forcing every client through a full resync on a metadata burst would be a
// needless thundering herd.
func TestTopicShed_MetadataFrameDoesNotForceResync(t *testing.T) {
	h := newEmitTestHub()
	send := make(chan []byte, 4096)
	h.clients[1] = NewTestClient(h, 1, send)
	h.pubsub.Subscribe(h.clients[1], ChannelTopic(5))

	for range topicRateLimitPerSecond + 5 {
		h.deliverBroadcast(broadcastMsg{channelID: 5, msg: []byte(`{"type":"chat_deleted"}`)})
	}
	if h.TopicShedCount() != 5 {
		t.Fatalf("TopicShedCount = %d, want 5", h.TopicShedCount())
	}
	lastDelivered := atomic.LoadUint64(&h.seq)
	if h.mustFullResync(lastDelivered) {
		t.Fatalf("a metadata shed must not force a full resync for seq %d", lastDelivered)
	}
}

// A resume that registers while the dispatch loop holds the last frame queued
// ahead of a dropped content frame — dequeued, so the queue reads empty, but
// not yet sequenced — must not settle the drop: that frame is sequenced next,
// and a client that receives it sits exactly at the loss point.
func TestQueueContentDrop_ResumeMidDispatchDoesNotSettleDrop(t *testing.T) {
	h := newEmitTestHub()
	for range 2 {
		h.deliverBroadcast(broadcastMsg{msg: []byte(`{"type":"server_filler"}`)})
	}
	h.queueDrops.dropped.Add(1)

	c := NewTestClient(h, 2, make(chan []byte, 8))
	if _, ok := h.ReconnectRegisterForTest(c, atomic.LoadUint64(&h.seq), nil); ok {
		t.Fatal("a resume at the loss point with a content drop pending must take the full-ready path")
	}

	h.deliverBroadcast(broadcastMsg{msg: []byte(`{"type":"server_filler"}`)})
	if last := atomic.LoadUint64(&h.seq); !h.mustFullResync(last) {
		t.Fatalf("a client that received seq %d, the frame just ahead of the dropped one, must take the full-ready path", last)
	}
}
