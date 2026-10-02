package ws

import (
	"log/slog"
	"strconv"
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
	// voiceJoin is voice_join_ms: each phase of a completed voice join.
	voiceJoin voiceJoinMetrics
}

// voiceJoinMetrics times the phases of handleVoiceJoin for joins that reach
// the joiner; a refused or rolled-back join records nothing, so every phase
// shares one count.
type voiceJoinMetrics struct {
	precheck, leave, persist, token, complete, total metrics.Histogram
}

// observe records one completed join from the timestamps taken as each phase
// ended.
func (m *voiceJoinMetrics) observe(start, precheckDone, leaveDone, persistDone, tokenDone, completeDone time.Time) {
	ms := func(from, to time.Time) float64 { return float64(to.Sub(from)) / float64(time.Millisecond) }
	m.precheck.Observe(ms(start, precheckDone))
	m.leave.Observe(ms(precheckDone, leaveDone))
	m.persist.Observe(ms(leaveDone, persistDone))
	m.token.Observe(ms(persistDone, tokenDone))
	m.complete.Observe(ms(tokenDone, completeDone))
	m.total.Observe(ms(start, completeDone))
}

// VoiceJoinPhases is the voice_join_ms snapshot: precheck (rate limit,
// permission and channel gates), leave (leaving the previous channel on a
// switch), persist (the voice_states write and moderator-flag restore), token
// (minting and sending voice_token), complete (subscription, voice_state
// fan-out, existing states and voice_config) and total.
type VoiceJoinPhases struct {
	Precheck metrics.Summary `json:"precheck"`
	Leave    metrics.Summary `json:"leave"`
	Persist  metrics.Summary `json:"persist"`
	Token    metrics.Summary `json:"token"`
	Complete metrics.Summary `json:"complete"`
	Total    metrics.Summary `json:"total"`
}

// observeSeqMuHold records how long the current seqMu critical section was
// held, in milliseconds. Call the sequence:
//
//	h.seqMu.Lock()
//	start := time.Now()
//	defer h.seqMu.Unlock()
//	defer h.observeSeqMuHold(start)
//
// start is taken after Lock returns, so time spent waiting for the lock is
// not counted as a hold. Defers are LIFO, so observeSeqMuHold runs BEFORE the
// unlock — the hold is measured while it is still held. Every seqMu critical section — seq
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
// under the topic rate limit, counted per channel and sender. The limit is a
// sliding 1s window via the shared auth.RateLimiter (the deleted TopicRateLimiter was a token bucket
// with a full refill at each window boundary — sliding is stricter on
// boundary-straddling bursts, the same sustained rate).
//
// A shed frame is counted (topic_sheds_total, SRE-M1). SRV-03: for a
// CONTENT-bearing frame (nsfwChannelID marks the kinds in contentBearingKinds)
// it also ratchets the visibility watermark, so a client resuming from a seq at
// or before this point takes the full-ready path and recovers the message from
// the database — the shed frame consumed no seq, so replay can never carry it.
// Metadata sheds are not ratcheted: they are ephemeral or reconstructed
// elsewhere, and forcing a full resync on a metadata burst would be a herd for
// nothing. bumpVisibilityWatermark is lock-free, so this is safe to call while
// holding seqMu.
func (h *Hub) allowTopicFrame(bm broadcastMsg) bool {
	if bm.recipients != nil || bm.channelID == 0 {
		return true
	}
	// Counted per sender, so a few members cannot use up a channel's budget
	// and suppress live delivery for everyone else in it; server-originated
	// frames (senderID 0) share the channel's own key.
	key := "topic:" + string(ChannelTopic(bm.channelID))
	if bm.senderID != 0 {
		key += ":" + strconv.FormatInt(bm.senderID, 10)
	}
	if h.limiter.Allow(key, topicRateLimitPerSecond, time.Second) {
		return true
	}
	h.latency.topicSheds.Add(1)
	if bm.nsfwChannelID != 0 {
		h.bumpVisibilityWatermark()
		slog.Warn("hub: topic rate limit shed a content frame, forcing resync on reconnect",
			"channel_id", bm.channelID)
	} else {
		slog.Warn("hub: topic rate limit exceeded, dropping message", "channel_id", bm.channelID)
	}
	return false
}

// queueDropState records content-bearing frames the full broadcast queue
// dropped in enqueue (SRV-03): dropped counts them, applied is how many
// applyQueueContentDrops has settled into the resync watermark. applied is
// guarded by seqMu.
type queueDropState struct {
	dropped atomic.Uint64
	applied uint64
}

// recordQueueDrop counts a frame enqueue dropped on a full broadcast queue. A
// content-bearing one, or a presence_batch window, is also left for
// applyQueueContentDrops to settle into the resync watermark under seqMu
// (SRV-03).
func (h *Hub) recordQueueDrop(bm broadcastMsg, kind string) {
	h.broadcastDrops.Add(1)
	if bm.nsfwChannelID != 0 || bm.presence != nil {
		h.queueDrops.dropped.Add(1)
	}
	slog.Warn("hub: broadcast channel full, dropping "+kind,
		"channel_id", bm.channelID, "msg_len", len(bm.msg))
}

// applyQueueContentDrops is SRV-03's recovery for a content-bearing frame the
// full broadcast queue dropped in enqueue. Unlike a topic shed, that frame's
// place in the seq stream lies behind every frame still queued ahead of it, so
// while such a drop is unsettled every call ratchets the watermark to the
// current seq, and the drop only counts as settled once the queue is seen
// empty — every frame queued before it has been sequenced by then. That proof
// holds only on the dispatch goroutine, so deliverBroadcast is the sole caller,
// under seqMu after each frame; mustFullResyncAtRegister bumps for an
// unsettled drop but never settles it.
func (h *Hub) applyQueueContentDrops() {
	n := h.queueDrops.dropped.Load()
	if n == h.queueDrops.applied {
		return
	}
	h.bumpVisibilityWatermark()
	if len(h.broadcast) == 0 {
		h.queueDrops.applied = n
	}
}

// mustFullResyncAtRegister is reconnectRegister's final watermark check, run
// under seqMu. An unsettled queue drop (SRV-03) ratchets the watermark first,
// so a resume racing the dispatch of the frames ahead of it still takes the
// full-ready path.
func (h *Hub) mustFullResyncAtRegister(lastSeq uint64) bool {
	if h.queueDrops.dropped.Load() != h.queueDrops.applied {
		h.bumpVisibilityWatermark()
	}
	return h.mustFullResync(lastSeq)
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

// BroadcastMs returns the current enqueue-to-fanout-done latency distribution.
func (h *Hub) BroadcastMs() metrics.Summary { return h.latency.broadcast.Snapshot() }

// DispatchLagMs returns the current enqueue-to-dispatch lag distribution.
func (h *Hub) DispatchLagMs() metrics.Summary { return h.latency.dispatchLag.Snapshot() }

// ChatAckMs returns the current chat send-to-ack latency distribution.
func (h *Hub) ChatAckMs() metrics.Summary { return h.latency.chatAck.Snapshot() }

// VoiceJoinMs returns the per-phase voice join distributions.
func (h *Hub) VoiceJoinMs() VoiceJoinPhases {
	v := &h.latency.voiceJoin
	return VoiceJoinPhases{
		Precheck: v.precheck.Snapshot(),
		Leave:    v.leave.Snapshot(),
		Persist:  v.persist.Snapshot(),
		Token:    v.token.Snapshot(),
		Complete: v.complete.Snapshot(),
		Total:    v.total.Snapshot(),
	}
}

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

// wakeBlocked is wakeBlockedLocked for a caller that does not hold h.mu.
func (h *Hub) wakeBlocked(c *Client) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.wakeBlockedLocked(c)
}

// wakeBlockedLocked reports whether c is a wake reconnect (U4) while another
// device — a DIFFERENT session (token hash) of the same account — holds the
// session: its live connection, or the call it parked in the RT-8 grace
// window. A same-session match is this device's own stale socket or parked
// call, not another device. Caller holds h.mu (h.mu -> voiceGrace.mu is the
// order registerNow's inheritParkedVoice already takes).
func (h *Hub) wakeBlockedLocked(c *Client) bool {
	if !c.wakeReconnect {
		return false
	}
	if old, ok := h.clients[c.userID]; ok && old.tokenHash != c.tokenHash {
		return true
	}
	e := h.voiceGrace.get(c.userID)
	return e != nil && e.client.tokenHash != c.tokenHash
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

// PresenceDropCount is the process-lifetime count of presence frames dropped
// on a full normal buffer, each repaired by a snapshot rather than a
// disconnect (Client.sendPresenceMsg). Safe to call from any goroutine.
func (h *Hub) PresenceDropCount() uint64 { return h.presenceRepair.drops.Load() }

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
// single channel topic, per sender. Prevents a busy channel from saturating
// the broadcast loop and starving other channels.
const topicRateLimitPerSecond = 100
