package ws

import (
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/metrics"
)

// Hub accessor and stats methods split out of hub.go (OC-0400) to keep it
// under the B3-5 guardrail (invariants/file_sizes.go). No behavior change —
// moved verbatim.

// hubLatencyMetrics is the shipped in-process metrics surface (SRE-M1). The
// zero value is fully usable, so NewHub needs no initializer and the struct
// adds no allocation to the hot path. These figures exist in every build,
// unlike the OpenTelemetry instruments in Server/telemetry, which compile only
// under -tags otel — the release and Docker builds use no build tags, so an
// OTel-only latency figure is invisible to the operators who run them.
type hubLatencyMetrics struct {
	// broadcast is enqueue→fanout-done: the whole time a frame spent queued
	// behind other broadcasts plus its own delivery.
	broadcast metrics.Histogram
	// dispatchLag is enqueue→dispatch-start: how long a frame waited for the
	// single dispatch goroutine to reach it. The direct signal for a
	// contended dispatch loop (SRV-04).
	dispatchLag metrics.Histogram
	// chatAck is a client's chat_send receipt→its chat_send_ok being queued:
	// the round trip inside the server, which the load run compares against
	// k6's client-side figure.
	chatAck metrics.Histogram
	// seqMuHold is the longest single hold of the broadcast-sequence mutex,
	// in milliseconds. The purge's full scan (SRV-01) shows up here.
	seqMuHold metrics.MaxGauge
	// topicSheds counts channel frames the topic limiter dropped before a
	// seq was assigned (SRV-03). Distinct from broadcastDrops, which is the
	// hub-wide queue, and from low-priority drops, which lose nothing.
	topicSheds atomic.Uint64
}

// observeSeqMuHold records how long the current seqMu critical section was
// held, in milliseconds. Call the sequence:
//
//	start := time.Now()
//	h.seqMu.Lock()
//	defer h.seqMu.Unlock()
//	defer h.observeSeqMuHold(start)
//
// Defers are LIFO, so observeSeqMuHold runs BEFORE the unlock — the hold is
// measured while it is still held. Every seqMu critical section — seq
// allocation and fan-out, replay purge, visibility bumps, reconnect
// registration — feeds hub_seqmu_max_hold_ms through this. It is a deferred
// method call, not a returned closure, so the hot path allocates nothing.
func (h *Hub) observeSeqMuHold(start time.Time) {
	h.latency.seqMuHold.Observe(float64(time.Since(start)) / float64(time.Millisecond))
}

// observeDispatchLag records enqueue→dispatch-start for a frame, in
// milliseconds. Zero enqueuedAt (test-constructed messages) is skipped.
func (h *Hub) observeDispatchLag(enqueuedAt time.Time) {
	if enqueuedAt.IsZero() {
		return
	}
	h.latency.dispatchLag.Observe(float64(time.Since(enqueuedAt)) / float64(time.Millisecond))
}

// recordBroadcastLatency records enqueue→fanout-done for a delivered frame, in
// milliseconds. Zero enqueuedAt is skipped.
func (h *Hub) recordBroadcastLatency(enqueuedAt time.Time) {
	if enqueuedAt.IsZero() {
		return
	}
	h.latency.broadcast.Observe(float64(time.Since(enqueuedAt)) / float64(time.Millisecond))
}

// allowTopicFrame reports whether bm, a channel-scoped broadcast, may proceed
// under the per-channel topic rate limit. The limit is a sliding 1s window via
// the shared auth.RateLimiter (the deleted TopicRateLimiter was a token bucket
// with a full refill at each window boundary — sliding is stricter on
// boundary-straddling bursts, the same sustained rate). A shed frame is
// counted here (topic_sheds_total, SRE-M1); SRV-03's follow-up recovery
// (forcing a resync on a content shed) layers onto this same site.
func (h *Hub) allowTopicFrame(bm broadcastMsg) bool {
	if bm.recipients != nil || bm.channelID == 0 {
		return true
	}
	if h.limiter.Allow("topic:"+string(ChannelTopic(bm.channelID)), topicRateLimitPerSecond, time.Second) {
		return true
	}
	h.latency.topicSheds.Add(1)
	slog.Warn("hub: topic rate limit exceeded, dropping message", "channel_id", bm.channelID)
	return false
}

// BroadcastQueueDepth is the number of frames currently waiting on the hub's
// dispatch channel — 0 is healthy, approaching the channel's capacity means
// the dispatch loop cannot keep up. Safe to call from any goroutine.
func (h *Hub) BroadcastQueueDepth() int { return len(h.broadcast) }

// SeqMuMaxHoldMs is the longest single seqMu hold observed since start.
func (h *Hub) SeqMuMaxHoldMs() float64 { return h.latency.seqMuHold.Millis() }

// TopicShedCount is the cumulative number of channel frames dropped by the
// topic limiter before a sequence number was assigned.
func (h *Hub) TopicShedCount() uint64 { return h.latency.topicSheds.Load() }

// BroadcastMs, DispatchLagMs and ChatAckMs return the current latency
// distributions for the metrics endpoint and the load run.
func (h *Hub) BroadcastMs() metrics.Summary   { return h.latency.broadcast.Snapshot() }
func (h *Hub) DispatchLagMs() metrics.Summary { return h.latency.dispatchLag.Snapshot() }
func (h *Hub) ChatAckMs() metrics.Summary     { return h.latency.chatAck.Snapshot() }

// IsUserConnected returns true if a client with the given userID is already
// registered in the hub. Safe to call from any goroutine.
func (h *Hub) IsUserConnected(userID int64) bool {
	h.mu.RLock()
	_, ok := h.clients[userID]
	h.mu.RUnlock()
	return ok
}

// GetClient returns the client for userID, or nil if not connected.
// Safe to call from any goroutine.
func (h *Hub) GetClient(userID int64) *Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.clients[userID]
}

// ClientCount returns the number of currently registered clients (test helper).
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// BroadcastDropCount returns the cumulative number of messages dropped due to a
// full broadcast channel. Safe to call from any goroutine.
func (h *Hub) BroadcastDropCount() uint64 {
	return h.broadcastDrops.Load()
}

// DispatchAlive reports whether the hub's dispatch loop is still running.
// It is true before Run starts (so a health probe racing startup does not
// flap) and false once Run has returned — normal shutdown or the panic
// breaker. Safe to call from any goroutine.
func (h *Hub) DispatchAlive() bool {
	return !h.dispatchExited.Load()
}

// BackpressureStats returns the process-lifetime per-client backpressure
// counters: connections closed due to send-buffer overflow, high-priority
// sends that fell back to the normal buffer, and low-priority messages
// silently dropped. Safe to call from any goroutine.
func (h *Hub) BackpressureStats() (queueDisconnects, highFallbacks, lowDrops uint64) {
	return h.bpQueueDisconnects.Load(), h.bpHighFallbacks.Load(), h.bpLowDrops.Load()
}

// DeliveryDropCount is the attention panel's delivery-pressure counter: hub
// broadcast drops, topic-limiter sheds, and send-queue overflow disconnects.
// Low-priority drops are excluded because they lose nothing and disconnect
// nobody; a topic shed loses a sequenced frame, so it belongs here (SRV-03).
func (h *Hub) DeliveryDropCount() uint64 {
	return h.broadcastDrops.Load() + h.latency.topicSheds.Load() + h.bpQueueDisconnects.Load()
}

// ConnRejectCount returns how many WebSocket upgrade requests were refused by
// the max_ws_connections capacity guardrail. Safe to call from any goroutine.
func (h *Hub) ConnRejectCount() uint64 {
	return h.connRejects.Load()
}

// EventPersisterStats returns the attached persister's lifetime counters.
// ok is false when event persistence is disabled (no persister attached).
func (h *Hub) EventPersisterStats() (persisted, dropped, flushes, errs uint64, ok bool) {
	p := h.eventPersister.Load()
	if p == nil {
		return 0, 0, 0, 0, false
	}
	persisted, dropped, flushes, errs = p.Stats()
	return persisted, dropped, flushes, errs, true
}

// topicRateLimitPerSecond is the default maximum messages per second for any
// single channel topic. Prevents a busy channel from saturating the broadcast
// loop and starving other channels.
const topicRateLimitPerSecond = 100
