package ws

import (
	"sync/atomic"
	"testing"
)

// SRV-03: a CONTENT-bearing frame shed by the topic limiter is committed in
// the database but reached no live client, and because it consumed no seq the
// replay tiers cannot recover it either — a resuming client's last_seq sits at
// or above it and never asks. The mitigation is to ratchet the resync watermark
// on such a shed, so the next reconnect for every client at or behind it takes
// the full-ready path, which rebuilds state from the database and thereby
// delivers the shed message.
func TestTopicShed_ContentFrameForcesFullResyncForOlderClients(t *testing.T) {
	h := newEmitTestHub()
	send := make(chan []byte, 4096)
	h.clients[1] = NewTestClient(h, 1, send)
	h.pubsub.Subscribe(h.clients[1], ChannelTopic(5))

	// Drain the limit with content-bearing frames: nsfwChannelID != 0 marks the
	// contentBearingKinds (chat_message and friends).
	total := topicRateLimitPerSecond + 5
	for range total {
		h.deliverBroadcast(broadcastMsg{channelID: 5, nsfwChannelID: 5, msg: []byte(`{"type":"chat_message"}`)})
	}
	if h.TopicShedCount() != 5 {
		t.Fatalf("TopicShedCount = %d, want 5", h.TopicShedCount())
	}

	// A client whose last_seq is at or before the last delivered seq must be
	// forced onto the full-ready path: the shed contents exist only in the DB.
	lastDelivered := atomic.LoadUint64(&h.seq)
	if !h.mustFullResync(lastDelivered) {
		t.Fatalf("a client resuming from seq %d after a content shed must take the full-ready path", lastDelivered)
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
