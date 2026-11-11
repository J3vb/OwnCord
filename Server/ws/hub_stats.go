package ws

import (
	"log/slog"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws/hubstats"
)

// observeSeqMuHold records the current seqMu hold in ms: take start after Lock, then defer the
// unlock and then this (LIFO, so it runs while still held; lock wait is not counted). Every seqMu
// section feeds hub_seqmu_max_hold_ms; a deferred method call, not a closure, so the hot path
// allocates nothing.
func (h *Hub) observeSeqMuHold(start time.Time) {
	h.stats.latency.ObserveSeqMuHold(start)
}

func (h *Hub) observeDispatchLag(enqueuedAt time.Time) {
	h.stats.latency.ObserveDispatchLag(enqueuedAt)
}

func (h *Hub) recordBroadcastLatency(enqueuedAt time.Time) {
	h.stats.latency.ObserveBroadcast(enqueuedAt)
}

// topicLimiterKey is the per-channel, per-sender key allowTopicFrame charges; it depends on bm
// alone, so dispatch builds it before seqMu.
func topicLimiterKey(bm broadcastMsg) string {
	// Counted per sender so a few members cannot use up a channel's budget; server-originated
	// frames (senderID 0) share the channel's own key.
	key := "topic:" + string(ChannelTopic(bm.channelID))
	if bm.senderID != 0 {
		key += ":" + strconv.FormatInt(bm.senderID, 10)
	}
	return key
}

// allowTopicFrame reports whether a channel-scoped broadcast may proceed under the per-channel,
// per-sender rate limit (sliding 1s window via auth.RateLimiter).
// A shed frame is counted (topic_sheds_total). A content-bearing shed also ratchets the visibility
// watermark and marks the channel's subscribers lost (markLoss): it consumed no seq, so replay can
// never carry it; a resuming client takes the full ready and a connected one sees a cseq gap.
// Metadata sheds are neither (a full resync on a metadata burst would be a herd for nothing).
// Caller holds seqMu (markLoss requires it); key is built before the lock.
func (h *Hub) allowTopicFrame(bm broadcastMsg, key string) bool {
	if bm.recipients != nil || bm.channelID == 0 {
		return true
	}
	if h.limiter.Allow(key, topicRateLimitPerSecond, time.Duration(topicRateWindow.Load())) {
		return true
	}
	h.stats.latency.CountTopicShed()
	if bm.nsfwChannelID != 0 {
		h.bumpVisibilityWatermark()
		h.markLoss(lossRoute{channelID: bm.channelID})
		slog.Warn("hub: topic rate limit shed a content frame, forcing resync on reconnect",
			"channel_id", bm.channelID)
	} else {
		slog.Warn("hub: topic rate limit exceeded, dropping message", "channel_id", bm.channelID)
	}
	return false
}

// queueDropState records frames the full broadcast queue dropped in enqueue: dropped counts them,
// applied is how many applyQueueContentDrops has settled into the resync watermark (guarded by
// seqMu).
type queueDropState struct {
	dropped atomic.Uint64
	applied uint64
	// routes are the audiences of drops not yet marked (hub_loss.go); mu is a leaf lock.
	mu             syncutil.Ranked[lockRankLeaf]
	routes         []lossRoute
	routesOverflow bool
	routesPending  atomic.Bool
	lossMarks      atomic.Uint64
}

// recordQueueDrop counts a frame enqueue dropped on a full queue for applyQueueContentDrops to
// settle under seqMu. Any drop is a hole replay cannot fill, metadata included (a lost chat_deleted
// leaves the message on screen); a presence snapshot request is the exception (flushPresenceQueue
// retries it).
func (h *Hub) recordQueueDrop(bm broadcastMsg, kind string) {
	h.stats.BroadcastDrops.Add(1)
	h.noteDropRoute(bm)
	if !bm.presenceSnapshot {
		h.stats.queueDrops.dropped.Add(1)
	}
	slog.Warn("hub: broadcast channel full, dropping "+kind,
		"channel_id", bm.channelID, "msg_len", len(bm.msg))
}

// applyQueueContentDrops recovers from a frame the full queue dropped in enqueue. Its place in the
// seq stream lies behind every frame still queued, so while a drop is unsettled each call ratchets
// the watermark to the current seq, and it settles only once the queue is seen empty. That proof
// holds only on the dispatch goroutine, so deliverGated is the sole caller (under seqMu);
// mustFullResyncAtRegister bumps for an unsettled drop but never settles it.
func (h *Hub) applyQueueContentDrops() {
	h.markDroppedRoutes()
	n := h.stats.queueDrops.dropped.Load()
	if n == h.stats.queueDrops.applied {
		return
	}
	h.bumpVisibilityWatermark()
	// A parked frame (hub_content_gate.go) was dequeued but not sequenced.
	if len(h.broadcast) == 0 && h.gates.parked == 0 {
		h.stats.queueDrops.applied = n
	}
}

// mustFullResyncAtRegister is reconnectRegister's final watermark check under seqMu. A resume takes
// the full ready if a queue drop is unsettled (ratcheted first), a targeted fan-out is in flight, a
// loss was marked for this user since reconnectPrecheck, or a role refresh is pending or running
// for them (role_refresh.go); the last three are per-user so other reconnects still replay.
func (h *Hub) mustFullResyncAtRegister(lastSeq uint64, userID int64, tokenHash string) bool {
	if h.stats.queueDrops.dropped.Load() != h.stats.queueDrops.applied {
		h.bumpVisibilityWatermark()
	}
	// Order matters: a refresh round bumps the watermark and only then stops covering the user, so
	// reading coverage first means a reconnect sees either the coverage or the new watermark.
	// covers runs under seqMu and roleRefresh.mu is a leaf: no new lock edge.
	covered := h.roleRefresh.covers(userID)
	if mustFullResyncMidReadRaceHook != nil {
		mustFullResyncMidReadRaceHook()
	}
	return covered || h.targetedFanouts > 0 || h.mustFullResync(lastSeq) ||
		h.presenceResyncPending(userID, tokenHash)
}

// mustFullResyncMidReadRaceHook runs between the coverage read and the watermark read; test-only,
// pins the order.
var mustFullResyncMidReadRaceHook func()

// BroadcastQueueDepth is the number of frames waiting on the dispatch channel: 0 is healthy, near
// capacity means the loop cannot keep up.
func (h *Hub) BroadcastQueueDepth() int { return len(h.broadcast) }

// SeqMuMaxHoldMs is the longest single seqMu hold observed since start.
func (h *Hub) SeqMuMaxHoldMs() float64 { return h.stats.latency.SeqMuMaxHoldMs() }

// TopicShedCount is the cumulative channel frames dropped by the topic limiter before a seq was
// assigned.
func (h *Hub) TopicShedCount() uint64 { return h.stats.latency.TopicSheds() }

// BroadcastMs returns the current enqueue-to-fanout-done latency distribution.
func (h *Hub) BroadcastMs() metrics.Summary { return h.stats.latency.BroadcastMs() }

// DispatchLagMs returns the current enqueue-to-dispatch lag distribution.
func (h *Hub) DispatchLagMs() metrics.Summary { return h.stats.latency.DispatchLagMs() }

// ChatAckMs returns the current chat send-to-ack latency distribution.
func (h *Hub) ChatAckMs() metrics.Summary { return h.stats.latency.ChatAckMs() }

// VoiceJoinMs returns the per-phase voice join distributions.
func (h *Hub) VoiceJoinMs() hubstats.VoiceJoinPhases { return h.stats.latency.VoiceJoinMs() }

// LatencyCounts reads every histogram's raw counts: atomic loads, no hub lock.
func (h *Hub) LatencyCounts() hubstats.LatencyCounts { return h.stats.latency.Counts() }

// WindowSources lists every figure the windowed metrics block samples; names are the JSON keys
// under /api/v1/metrics "windows". All atomic loads (no hub lock); the slices are fresh and point
// at the hub's own histograms.
func (h *Hub) WindowSources() ([]metrics.NamedHistogram, []metrics.NamedMaxGauge, []metrics.NamedCounter) {
	hists := h.stats.latency.Histograms()
	gauges := h.stats.latency.Gauges()
	counters := []metrics.NamedCounter{
		{Name: "broadcast_drops", Read: h.BroadcastDropCount},
		{Name: "topic_sheds_total", Read: h.TopicShedCount},
		{Name: "reconnect_tier_buffer", Read: h.stats.ReconnectTierBuf.Load},
		{Name: "reconnect_tier_db", Read: h.stats.ReconnectTierDB.Load},
		{Name: "reconnect_tier_full", Read: h.stats.ReconnectTierFull.Load},
		{Name: "reconnect_ring_misses", Read: h.stats.ReconnectRingMiss.Load},
		{Name: "backpressure_queue_disconnects", Read: h.stats.BPQueueDisconnects.Load},
		{Name: "backpressure_high_fallbacks", Read: h.stats.BPHighFallbacks.Load},
		{Name: "backpressure_low_drops", Read: h.stats.BPLowDrops.Load},
		{Name: "backpressure_presence_drops", Read: h.PresenceDropCount},
		{Name: "delivery_loss_marks", Read: h.LossMarkCount},
		{Name: "ws_conn_rejects", Read: h.ConnRejectCount},
	}
	return hists, gauges, counters
}

// IsUserConnected reports whether the user has a live connection.
func (h *Hub) IsUserConnected(userID int64) bool {
	return h.isConnected(userID)
}

// ClientCount returns the number of live connections (an account on two devices counts twice).
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connectionCountLocked()
}

// UserCount returns the number of distinct connected users.
func (h *Hub) UserCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// BroadcastDropCount returns the cumulative messages dropped on a full broadcast channel.
func (h *Hub) BroadcastDropCount() uint64 {
	return h.stats.BroadcastDrops.Load()
}

// DispatchAlive reports whether the dispatch loop is running: true before Run starts (so a startup
// health probe does not flap), false once Run has returned.
func (h *Hub) DispatchAlive() bool {
	return !h.lifecycle.dispatchExited.Load()
}

// BackpressureStats returns per-client counters: connections closed on send-buffer overflow, high-
// priority sends that fell back to normal, and low-priority drops.
func (h *Hub) BackpressureStats() (queueDisconnects, highFallbacks, lowDrops uint64) {
	return h.stats.BPQueueDisconnects.Load(), h.stats.BPHighFallbacks.Load(), h.stats.BPLowDrops.Load()
}

// PresenceDropCount counts presence frames dropped on a full normal buffer, each repaired by a
// snapshot.
func (h *Hub) PresenceDropCount() uint64 { return h.presenceFeed.repair.drops.Load() }

// DeliveryDropCount is the attention panel's delivery-pressure counter: broadcast drops, topic
// sheds and overflow disconnects. Low-priority drops are excluded (they lose nothing).
func (h *Hub) DeliveryDropCount() uint64 {
	return h.stats.BroadcastDrops.Load() + h.stats.latency.TopicSheds() + h.stats.BPQueueDisconnects.Load()
}

// ConnRejectCount returns upgrade requests refused by the max_ws_connections guardrail.
func (h *Hub) ConnRejectCount() uint64 {
	return h.stats.ConnRejects.Load()
}

// EventPersisterStats returns the persister's lifetime counters; ok is false when persistence is
// disabled.
func (h *Hub) EventPersisterStats() (persisted, dropped, flushes, errs uint64, ok bool) {
	p := h.events.eventPersister.Load()
	if p == nil {
		return 0, 0, 0, 0, false
	}
	persisted, dropped, flushes, errs = p.Stats()
	return persisted, dropped, flushes, errs, true
}

const topicRateLimitPerSecond = 100

// topicRateWindow is the window the limit counts over (one second). Atomic so a test can widen it
// while another hub reads it, and a slow runner cannot split a burst across windows.
var topicRateWindow atomic.Int64

func init() { topicRateWindow.Store(int64(time.Second)) }

// hubStats groups the drop, backpressure, reject, reconnect-tier and latency counters. It holds
// atomics and a mutex: never copy it.
type hubStats struct {
	hubstats.Counters
	queueDrops queueDropState // frames the full broadcast queue dropped

	latency hubstats.Latency
}
