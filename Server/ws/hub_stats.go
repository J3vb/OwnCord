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

// observeSeqMuHold records how long the current seqMu critical section was held,
// in milliseconds. Call it as:
//
//	h.seqMu.Lock()
//	start := time.Now()
//	defer h.seqMu.Unlock()
//	defer h.observeSeqMuHold(start)
//
// start is taken after Lock returns, so lock wait is not counted. Defers are LIFO,
// so it runs before the unlock and measures the hold while still held. Every
// seqMu section feeds hub_seqmu_max_hold_ms through this. It is a deferred method
// call, not a returned closure, so the hot path allocates nothing.
func (h *Hub) observeSeqMuHold(start time.Time) {
	h.stats.latency.ObserveSeqMuHold(start)
}

// observeDispatchLag records enqueue to dispatch-start in ms; a zero enqueuedAt is skipped.
func (h *Hub) observeDispatchLag(enqueuedAt time.Time) {
	h.stats.latency.ObserveDispatchLag(enqueuedAt)
}

// recordBroadcastLatency records enqueue to fanout-done in ms; a zero enqueuedAt is skipped.
func (h *Hub) recordBroadcastLatency(enqueuedAt time.Time) {
	h.stats.latency.ObserveBroadcast(enqueuedAt)
}

// topicLimiterKey is the per-channel, per-sender key allowTopicFrame charges.
// It depends on bm alone, so the dispatch goroutine builds it before seqMu.
func topicLimiterKey(bm broadcastMsg) string {
	// Counted per sender, so a few members cannot use up a channel's budget and
	// suppress live delivery for everyone else; server-originated frames (senderID 0)
	// share the channel's own key.
	key := "topic:" + string(ChannelTopic(bm.channelID))
	if bm.senderID != 0 {
		key += ":" + strconv.FormatInt(bm.senderID, 10)
	}
	return key
}

// allowTopicFrame reports whether bm, a channel-scoped broadcast, may proceed under
// the per-channel, per-sender topic rate limit: a sliding 1s window via the shared
// auth.RateLimiter (stricter than a token bucket on boundary-straddling bursts,
// same sustained rate).
//
// A shed frame is counted (topic_sheds_total). For a content-bearing frame
// (nsfwChannelID; contentBearingKinds) it also ratchets the visibility watermark
// and marks the channel's subscribers as having lost a frame (markLoss), as the
// unconfirmed-gate path does: the shed frame consumed no seq, so replay can never
// carry it, a client resuming from a seq at or before this point takes the
// full-ready path and recovers the message from the database, and a connected
// subscriber sees a cseq gap and resumes. Metadata sheds are neither ratcheted nor
// marked (ephemeral or reconstructed elsewhere; a full resync on a metadata burst
// would be a herd for nothing). The caller holds seqMu, which markLoss requires;
// bumpVisibilityWatermark is lock-free. key is topicLimiterKey(bm), built by the
// caller before the lock.
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

// queueDropState records frames the full broadcast queue dropped in enqueue:
// dropped counts them, applied is how many applyQueueContentDrops has settled into
// the resync watermark. applied is guarded by seqMu.
type queueDropState struct {
	dropped atomic.Uint64
	applied uint64
	// routes are the audiences of drops not yet marked (hub_loss.go); guarded by mu, a leaf lock.
	mu             syncutil.Ranked[lockRankLeaf]
	routes         []lossRoute
	routesOverflow bool
	routesPending  atomic.Bool
	lossMarks      atomic.Uint64
}

// recordQueueDrop counts a frame enqueue dropped on a full broadcast queue and
// leaves it for applyQueueContentDrops to settle into the resync watermark under
// seqMu. Every queued frame would have been sequenced and replayable, so any drop
// is a hole replay cannot fill, metadata included (a lost chat_deleted leaves the
// message on screen). A presence snapshot request is the exception: it carries no
// frame and flushPresenceQueue retries it.
func (h *Hub) recordQueueDrop(bm broadcastMsg, kind string) {
	h.stats.BroadcastDrops.Add(1)
	h.noteDropRoute(bm)
	if !bm.presenceSnapshot {
		h.stats.queueDrops.dropped.Add(1)
	}
	slog.Warn("hub: broadcast channel full, dropping "+kind,
		"channel_id", bm.channelID, "msg_len", len(bm.msg))
}

// applyQueueContentDrops is the recovery for a frame the full broadcast queue
// dropped in enqueue. Unlike a topic shed, that frame's place in the seq stream
// lies behind every frame still queued ahead of it, so while a drop is unsettled
// every call ratchets the watermark to the current seq, and the drop settles only
// once the queue is seen empty (every earlier frame has been sequenced). That
// proof holds only on the dispatch goroutine, so deliverGated is the sole caller,
// under seqMu after each frame; mustFullResyncAtRegister bumps for an unsettled
// drop but never settles it.
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

// mustFullResyncAtRegister is reconnectRegister's final watermark check, run under
// seqMu. An unsettled queue drop ratchets the watermark first, so a resume racing
// the dispatch of earlier frames takes the full-ready path. So does a targeted
// fan-out in flight (beginTargetedFanout), a loss marked for this user (markLoss)
// since reconnectPrecheck, and a role refresh pending or running for this user
// (role_refresh.go), scoped to the affected users so other reconnects still replay.
func (h *Hub) mustFullResyncAtRegister(lastSeq uint64, userID int64, tokenHash string) bool {
	if h.stats.queueDrops.dropped.Load() != h.stats.queueDrops.applied {
		h.bumpVisibilityWatermark()
	}
	// Order matters: a refresh round bumps the watermark and only then stops covering
	// the user. Reading covers first means a reconnect sees either the user still
	// covered or the new watermark. covers runs under seqMu and roleRefresh.mu is a
	// leaf, so the lock order is unchanged.
	covered := h.roleRefresh.covers(userID)
	if mustFullResyncMidReadRaceHook != nil {
		mustFullResyncMidReadRaceHook()
	}
	return covered || h.targetedFanouts > 0 || h.mustFullResync(lastSeq) ||
		h.presenceResyncPending(userID, tokenHash)
}

// mustFullResyncMidReadRaceHook, when non-nil, runs between the coverage read and
// the watermark read in mustFullResyncAtRegister. Test-only; pins the order.
var mustFullResyncMidReadRaceHook func()

// BroadcastQueueDepth is the number of frames waiting on the dispatch channel: 0
// is healthy, near capacity means the loop cannot keep up. Safe from any goroutine.
func (h *Hub) BroadcastQueueDepth() int { return len(h.broadcast) }

// SeqMuMaxHoldMs is the longest single seqMu hold observed since start.
func (h *Hub) SeqMuMaxHoldMs() float64 { return h.stats.latency.SeqMuMaxHoldMs() }

// TopicShedCount is the cumulative channel frames dropped by the topic limiter
// before a sequence number was assigned.
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

// WindowSources lists every figure the windowed metrics block samples; names are the
// JSON keys under /api/v1/metrics "windows". Every counter is an atomic load, so
// the sampler takes no hub lock. The slices are fresh and point at the hub's own
// histograms.
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

// IsUserConnected reports whether the user has a live connection. Safe from any goroutine.
func (h *Hub) IsUserConnected(userID int64) bool {
	return h.isConnected(userID)
}

// ClientCount returns the number of live connections: an account on two devices counts twice.
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

// BroadcastDropCount returns the cumulative messages dropped on a full broadcast
// channel. Safe from any goroutine.
func (h *Hub) BroadcastDropCount() uint64 {
	return h.stats.BroadcastDrops.Load()
}

// DispatchAlive reports whether the dispatch loop is running: true before Run
// starts (so a health probe racing startup does not flap), false once Run has
// returned (shutdown or the panic breaker). Safe from any goroutine.
func (h *Hub) DispatchAlive() bool {
	return !h.lifecycle.dispatchExited.Load()
}

// BackpressureStats returns process-lifetime per-client counters: connections
// closed on send-buffer overflow, high-priority sends that fell back to the normal
// buffer, and low-priority messages dropped. Safe from any goroutine.
func (h *Hub) BackpressureStats() (queueDisconnects, highFallbacks, lowDrops uint64) {
	return h.stats.BPQueueDisconnects.Load(), h.stats.BPHighFallbacks.Load(), h.stats.BPLowDrops.Load()
}

// PresenceDropCount is the process-lifetime count of presence frames dropped on a
// full normal buffer, each repaired by a snapshot (Client.sendPresenceMsg).
func (h *Hub) PresenceDropCount() uint64 { return h.presenceFeed.repair.drops.Load() }

// DeliveryDropCount is the attention panel's delivery-pressure counter: broadcast
// drops, topic-limiter sheds and send-queue overflow disconnects. Low-priority
// drops are excluded (they lose nothing); a topic shed loses a sequenced frame.
func (h *Hub) DeliveryDropCount() uint64 {
	return h.stats.BroadcastDrops.Load() + h.stats.latency.TopicSheds() + h.stats.BPQueueDisconnects.Load()
}

// ConnRejectCount returns upgrade requests refused by the max_ws_connections guardrail.
func (h *Hub) ConnRejectCount() uint64 {
	return h.stats.ConnRejects.Load()
}

// EventPersisterStats returns the persister's lifetime counters; ok is false when
// persistence is disabled.
func (h *Hub) EventPersisterStats() (persisted, dropped, flushes, errs uint64, ok bool) {
	p := h.events.eventPersister.Load()
	if p == nil {
		return 0, 0, 0, 0, false
	}
	persisted, dropped, flushes, errs = p.Stats()
	return persisted, dropped, flushes, errs, true
}

// topicRateLimitPerSecond is the default per-sender message cap per channel topic,
// so a busy channel cannot saturate the broadcast loop.
const topicRateLimitPerSecond = 100

// topicRateWindow is the window topicRateLimitPerSecond counts over (one second).
// Atomic so a test can widen it while another hub still reads it, and a slow
// runner cannot spread a burst across two windows.
var topicRateWindow atomic.Int64

func init() { topicRateWindow.Store(int64(time.Second)) }

// hubStats groups the hub's drop, backpressure, reject, reconnect-tier and latency
// counters. It holds atomics and a mutex, so it must not be copied.
type hubStats struct {
	hubstats.Counters
	queueDrops queueDropState // frames the full broadcast queue dropped

	// latency is the shipped in-process metrics surface; the zero value is usable.
	latency hubstats.Latency
}
