package ws

import (
	"log/slog"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// hubLatencyMetrics is the shipped in-process metrics surface. The zero value is
// usable, so NewHub needs no initializer. Unlike the OpenTelemetry instruments in
// Server/telemetry (compiled only under -tags otel), these exist in every build,
// including the untagged release and Docker builds.
type hubLatencyMetrics struct {
	// broadcast is enqueue to fanout-done: time queued behind other broadcasts plus delivery.
	broadcast metrics.Histogram
	// dispatchLag is enqueue to dispatch-start: how long a frame waited for the single
	// dispatch goroutine; the direct signal for a contended loop.
	dispatchLag metrics.Histogram
	// chatAck is chat_send receipt to its chat_send_ok being queued: the in-server
	// round trip, compared against k6's client-side figure.
	chatAck metrics.Histogram
	// seqMuHold is the longest single hold of the broadcast-sequence mutex, in ms.
	seqMuHold metrics.MaxGauge
	// topicSheds counts channel frames the topic limiter dropped before a seq was
	// assigned (distinct from broadcastDrops, the hub-wide queue).
	topicSheds atomic.Uint64
	// voiceJoin is voice_join_ms: each phase of a completed voice join.
	voiceJoin voiceJoinMetrics
}

// voiceJoinMetrics times the phases of handleVoiceJoin for joins that reach the
// joiner; a refused or rolled-back join records nothing, so every phase shares
// one count.
type voiceJoinMetrics struct {
	precheck, leave, persist, token, complete, total metrics.Histogram
}

// observe records one completed join from the timestamps taken as each phase ended.
func (m *voiceJoinMetrics) observe(start, precheckDone, leaveDone, persistDone, tokenDone, completeDone time.Time) {
	ms := func(from, to time.Time) float64 { return float64(to.Sub(from)) / float64(time.Millisecond) }
	m.precheck.Observe(ms(start, precheckDone))
	m.leave.Observe(ms(precheckDone, leaveDone))
	m.persist.Observe(ms(leaveDone, persistDone))
	m.token.Observe(ms(persistDone, tokenDone))
	m.complete.Observe(ms(tokenDone, completeDone))
	m.total.Observe(ms(start, completeDone))
}

// VoiceJoinPhases is the voice_join_ms snapshot: precheck, leave (previous channel
// on a switch), persist, token, complete and total.
type VoiceJoinPhases struct {
	Precheck metrics.Summary `json:"precheck"`
	Leave    metrics.Summary `json:"leave"`
	Persist  metrics.Summary `json:"persist"`
	Token    metrics.Summary `json:"token"`
	Complete metrics.Summary `json:"complete"`
	Total    metrics.Summary `json:"total"`
}

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
	h.latency.seqMuHold.Observe(float64(time.Since(start)) / float64(time.Millisecond))
}

// observeDispatchLag records enqueue to dispatch-start in ms; a zero enqueuedAt is skipped.
func (h *Hub) observeDispatchLag(enqueuedAt time.Time) {
	if enqueuedAt.IsZero() {
		return
	}
	h.latency.dispatchLag.Observe(float64(time.Since(enqueuedAt)) / float64(time.Millisecond))
}

// recordBroadcastLatency records enqueue to fanout-done in ms; a zero enqueuedAt is skipped.
func (h *Hub) recordBroadcastLatency(enqueuedAt time.Time) {
	if enqueuedAt.IsZero() {
		return
	}
	h.latency.broadcast.Observe(float64(time.Since(enqueuedAt)) / float64(time.Millisecond))
}

// allowTopicFrame reports whether bm, a channel-scoped broadcast, may proceed under
// the per-channel, per-sender topic rate limit: a sliding 1s window via the shared
// auth.RateLimiter (stricter than a token bucket on boundary-straddling bursts,
// same sustained rate).
//
// A shed frame is counted (topic_sheds_total). For a content-bearing frame
// (nsfwChannelID; contentBearingKinds) it also ratchets the visibility watermark,
// so a client resuming from a seq at or before this point takes the full-ready
// path and recovers the message from the database: the shed frame consumed no seq,
// so replay can never carry it. Metadata sheds are not ratcheted (ephemeral or
// reconstructed elsewhere; a full resync on a metadata burst would be a herd for
// nothing). bumpVisibilityWatermark is lock-free, so this is safe under seqMu.
func (h *Hub) allowTopicFrame(bm broadcastMsg) bool {
	if bm.recipients != nil || bm.channelID == 0 {
		return true
	}
	// Counted per sender, so a few members cannot use up a channel's budget and
	// suppress live delivery for everyone else; server-originated frames (senderID 0)
	// share the channel's own key.
	key := "topic:" + string(ChannelTopic(bm.channelID))
	if bm.senderID != 0 {
		key += ":" + strconv.FormatInt(bm.senderID, 10)
	}
	if h.limiter.Allow(key, topicRateLimitPerSecond, time.Duration(topicRateWindow.Load())) {
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
	h.broadcastDrops.Add(1)
	h.noteDropRoute(bm)
	if !bm.presenceSnapshot {
		h.queueDrops.dropped.Add(1)
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
	n := h.queueDrops.dropped.Load()
	if n == h.queueDrops.applied {
		return
	}
	h.bumpVisibilityWatermark()
	// A parked frame (hub_content_gate.go) was dequeued but not sequenced.
	if len(h.broadcast) == 0 && h.gates.parked == 0 {
		h.queueDrops.applied = n
	}
}

// mustFullResyncAtRegister is reconnectRegister's final watermark check, run under
// seqMu. An unsettled queue drop ratchets the watermark first, so a resume racing
// the dispatch of earlier frames takes the full-ready path. So does a targeted
// fan-out in flight (beginTargetedFanout), a loss marked for this user (markLoss)
// since reconnectPrecheck, and a role refresh pending or running for this user
// (role_refresh.go), scoped to the affected users so other reconnects still replay.
func (h *Hub) mustFullResyncAtRegister(lastSeq uint64, userID int64, tokenHash string) bool {
	if h.queueDrops.dropped.Load() != h.queueDrops.applied {
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
func (h *Hub) SeqMuMaxHoldMs() float64 { return h.latency.seqMuHold.Millis() }

// TopicShedCount is the cumulative channel frames dropped by the topic limiter
// before a sequence number was assigned.
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

// LatencyCounts holds the raw cumulative counts of every shipped latency
// histogram keyed by JSON name ("ws_broadcast_ms", "ws_dispatch_lag_ms",
// "chat_send_ack_ms", "voice_join_ms.<phase>"), as WindowSources registers them.
type LatencyCounts map[string]metrics.Counts

// LatencyCounts reads every histogram's raw counts: atomic loads, no hub lock.
func (h *Hub) LatencyCounts() LatencyCounts {
	hists, _, _ := h.WindowSources()
	out := make(LatencyCounts, len(hists))
	for _, nh := range hists {
		out[nh.Name] = nh.H.Counts()
	}
	return out
}

// WindowSources lists every figure the windowed metrics block samples; names are the
// JSON keys under /api/v1/metrics "windows". Every counter is an atomic load, so
// the sampler takes no hub lock. The slices are fresh and point at the hub's own
// histograms.
func (h *Hub) WindowSources() ([]metrics.NamedHistogram, []metrics.NamedMaxGauge, []metrics.NamedCounter) {
	v := &h.latency.voiceJoin
	hists := []metrics.NamedHistogram{
		{Name: "ws_broadcast_ms", H: &h.latency.broadcast},
		{Name: "ws_dispatch_lag_ms", H: &h.latency.dispatchLag},
		{Name: "chat_send_ack_ms", H: &h.latency.chatAck},
		{Name: "voice_join_ms.precheck", H: &v.precheck},
		{Name: "voice_join_ms.leave", H: &v.leave},
		{Name: "voice_join_ms.persist", H: &v.persist},
		{Name: "voice_join_ms.token", H: &v.token},
		{Name: "voice_join_ms.complete", H: &v.complete},
		{Name: "voice_join_ms.total", H: &v.total},
	}
	gauges := []metrics.NamedMaxGauge{
		{Name: "hub_seqmu_max_hold_ms", G: &h.latency.seqMuHold},
	}
	counters := []metrics.NamedCounter{
		{Name: "broadcast_drops", Read: h.BroadcastDropCount},
		{Name: "topic_sheds_total", Read: h.TopicShedCount},
		{Name: "reconnect_tier_buffer", Read: h.reconnectTierBuf.Load},
		{Name: "reconnect_tier_db", Read: h.reconnectTierDB.Load},
		{Name: "reconnect_tier_full", Read: h.reconnectTierFull.Load},
		{Name: "reconnect_ring_misses", Read: h.reconnectRingMiss.Load},
		{Name: "backpressure_queue_disconnects", Read: h.bpQueueDisconnects.Load},
		{Name: "backpressure_high_fallbacks", Read: h.bpHighFallbacks.Load},
		{Name: "backpressure_low_drops", Read: h.bpLowDrops.Load},
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
	return h.broadcastDrops.Load()
}

// DispatchAlive reports whether the dispatch loop is running: true before Run
// starts (so a health probe racing startup does not flap), false once Run has
// returned (shutdown or the panic breaker). Safe from any goroutine.
func (h *Hub) DispatchAlive() bool {
	return !h.dispatchExited.Load()
}

// BackpressureStats returns process-lifetime per-client counters: connections
// closed on send-buffer overflow, high-priority sends that fell back to the normal
// buffer, and low-priority messages dropped. Safe from any goroutine.
func (h *Hub) BackpressureStats() (queueDisconnects, highFallbacks, lowDrops uint64) {
	return h.bpQueueDisconnects.Load(), h.bpHighFallbacks.Load(), h.bpLowDrops.Load()
}

// PresenceDropCount is the process-lifetime count of presence frames dropped on a
// full normal buffer, each repaired by a snapshot (Client.sendPresenceMsg).
func (h *Hub) PresenceDropCount() uint64 { return h.presenceRepair.drops.Load() }

// DeliveryDropCount is the attention panel's delivery-pressure counter: broadcast
// drops, topic-limiter sheds and send-queue overflow disconnects. Low-priority
// drops are excluded (they lose nothing); a topic shed loses a sequenced frame.
func (h *Hub) DeliveryDropCount() uint64 {
	return h.broadcastDrops.Load() + h.latency.topicSheds.Load() + h.bpQueueDisconnects.Load()
}

// ConnRejectCount returns upgrade requests refused by the max_ws_connections guardrail.
func (h *Hub) ConnRejectCount() uint64 {
	return h.connRejects.Load()
}

// EventPersisterStats returns the persister's lifetime counters; ok is false when
// persistence is disabled.
func (h *Hub) EventPersisterStats() (persisted, dropped, flushes, errs uint64, ok bool) {
	p := h.eventPersister.Load()
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
