package ws

import (
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/metrics"
)

// A channel frame shed by the topic limiter must be counted, and counted
// separately from the hub-wide dispatch-queue drops: operators alert on
// either, and SRV-03's follow-up recovery starts from this counter (SRE-M1).
func TestTopicSheds_CountedAboveTheTopicRateLimit(t *testing.T) {
	h := newEmitTestHub()
	send := make(chan []byte, 4096)
	h.clients[1] = NewTestClient(h, 1, send)
	h.pubsub.Subscribe(h.clients[1], ChannelTopic(5))

	total := topicRateLimitPerSecond + 20
	for range total {
		h.deliverBroadcast(broadcastMsg{channelID: 5, msg: []byte(`{"type":"chat_message"}`)})
	}

	sheds := h.TopicShedCount()
	if sheds != 20 {
		t.Fatalf("TopicShedCount = %d, want 20 (%d frames into a %d/s limit)", sheds, total, topicRateLimitPerSecond)
	}
	if h.BroadcastDropCount() != 0 {
		t.Fatalf("BroadcastDropCount = %d, want 0 — a topic shed is not a dispatch-queue drop", h.BroadcastDropCount())
	}
	// The attention panel's delivery-pressure source sums both, so a shed
	// must raise it.
	if h.DeliveryDropCount() != 20 {
		t.Fatalf("DeliveryDropCount = %d, want 20", h.DeliveryDropCount())
	}
}

// A hold of seqMu longer than 200 ms must be visible as at least 200 on the
// max-hold gauge (SRE-M1's acceptance): SRV-01's retention purge holds seqMu
// across a full scan, and this is the figure that promotes it to a fix.
func TestSeqMuMaxHold_ReadsTheLongestHold(t *testing.T) {
	h := newEmitTestHub()

	start := time.Now()
	h.seqMu.Lock()
	time.Sleep(200 * time.Millisecond)
	h.observeSeqMuHold(start)
	h.seqMu.Unlock()

	if got := h.SeqMuMaxHoldMs(); got < 200 {
		t.Fatalf("SeqMuMaxHoldMs = %v, want >= 200", got)
	}
	// A shorter hold must not lower the max.
	start = time.Now()
	h.seqMu.Lock()
	h.observeSeqMuHold(start)
	h.seqMu.Unlock()
	if got := h.SeqMuMaxHoldMs(); got < 200 {
		t.Fatalf("SeqMuMaxHoldMs = %v after a short hold, want it to stay >= 200", got)
	}
}

// BroadcastQueueDepth reports the dispatch channel's live depth.
func TestBroadcastQueueDepth_TracksEnqueuedFrames(t *testing.T) {
	h := newEmitTestHub() // 64-slot broadcast channel
	if got := h.BroadcastQueueDepth(); got != 0 {
		t.Fatalf("empty queue depth = %d, want 0", got)
	}
	for i := 0; i < 5; i++ {
		h.broadcast <- broadcastMsg{channelID: 0}
	}
	if got := h.BroadcastQueueDepth(); got != 5 {
		t.Fatalf("queue depth = %d, want 5", got)
	}
}

// A completed voice join records every phase once, and a refused join records
// none, so each phase's count is the number of joins that reached the joiner
// (SRE-M1's voice_join_ms, the server half of RT-4).
func TestVoiceJoinMs_RecordsEachPhaseOfACompletedJoin(t *testing.T) {
	h, _, c, chID := newVoiceTraceHub(t, "joinms")

	joinVoiceForTrace(t, h, c, chID)
	// A re-join of the same channel is refused (ALREADY_JOINED) and must not
	// be counted.
	h.handleMessage(c, voiceFrame(t, "voice_join", "again", map[string]any{"channel_id": chID}))

	got := h.VoiceJoinMs()
	for name, s := range map[string]metrics.Summary{
		"precheck": got.Precheck, "leave": got.Leave, "persist": got.Persist,
		"token": got.Token, "complete": got.Complete, "total": got.Total,
	} {
		if s.Count != 1 {
			t.Errorf("voice_join_ms.%s count = %d, want 1", name, s.Count)
		}
	}
	if got.Total.Max < got.Persist.Max {
		t.Errorf("voice_join_ms.total max %v < persist max %v; total must span every phase", got.Total.Max, got.Persist.Max)
	}
}
