package admin

import (
	"runtime"
	"time"

	"github.com/J3vb/OwnCord/Server/livekitproc"
	"github.com/J3vb/OwnCord/Server/metrics"
)

// These existing hub counters are local numeric aggregates. In particular,
// collecting them neither probes LiveKit nor discovers the machine's address.
type supportHubMetrics interface {
	VoiceSessionCount() int
	BroadcastDropCount() uint64
	DispatchAlive() bool
	BackpressureStats() (uint64, uint64, uint64)
	ReconnectTierStats() (uint64, uint64, uint64)
	ConnRejectCount() uint64
}

// supportHubLatency is the shipped in-process latency surface (SRE-M1). Kept
// a separate interface so the health snapshot stays usable from a fake that
// predates it.
type supportHubLatency interface {
	TopicShedCount() uint64
	BroadcastMs() metrics.Summary
	DispatchLagMs() metrics.Summary
	ChatAckMs() metrics.Summary
	BroadcastQueueDepth() int
	SeqMuMaxHoldMs() float64
}

// supportHubVoice reports the supervised LiveKit companion's local state.
// Reading it probes nothing and discovers no address — it is the supervisor's
// own running/restart flags, the same values the attention panel reads.
type supportHubVoice interface {
	LiveKitProcessStatus() livekitproc.Status
	LiveKitManaged() bool
}

const supportHealthScope = "database, process and local hub counters; LiveKit is reported from the supervisor's own state, never probed"

// healthSnapshot is health.json in the support bundle and the snapshot on the
// System health page. Fields are in JSON-key order and the ones a hub may not
// report are pointers left nil, so the bundle's bytes match the map this
// replaced: a field the hub cannot report is absent, never a made-up zero.
type healthSnapshot struct {
	BroadcastDrops         *uint64          `json:"broadcast_drops,omitempty"`
	CapturedAt             time.Time        `json:"captured_at"`
	ChatSendAckMs          *metrics.Summary `json:"chat_send_ack_ms,omitempty"`
	ConnectedUsers         *int             `json:"connected_users,omitempty"`
	DatabaseReadable       bool             `json:"database_readable"`
	DispatchAlive          *bool            `json:"dispatch_alive,omitempty"`
	GCCycles               uint32           `json:"gc_cycles"`
	Goroutines             int              `json:"goroutines"`
	HeapAllocBytes         uint64           `json:"heap_alloc_bytes"`
	HighPriorityFallbacks  *uint64          `json:"high_priority_fallbacks,omitempty"`
	HubBroadcastQueueDepth *int             `json:"hub_broadcast_queue_depth,omitempty"`
	HubSeqMuMaxHoldMs      *float64         `json:"hub_seqmu_max_hold_ms,omitempty"`
	LiveKitGaveUp          *bool            `json:"livekit_gave_up,omitempty"`
	LiveKitHealthy         *bool            `json:"livekit_healthy,omitempty"`
	LiveKitManaged         *bool            `json:"livekit_managed,omitempty"`
	LiveKitNextRetryAt     *time.Time       `json:"livekit_next_retry_at,omitempty"`
	LiveKitRestarts        *int             `json:"livekit_restarts,omitempty"`
	LowPriorityDrops       *uint64          `json:"low_priority_drops,omitempty"`
	QueueDisconnects       *uint64          `json:"queue_disconnects,omitempty"`
	ReconnectBuffer        *uint64          `json:"reconnect_buffer,omitempty"`
	ReconnectDatabase      *uint64          `json:"reconnect_database,omitempty"`
	ReconnectFull          *uint64          `json:"reconnect_full,omitempty"`
	Scope                  string           `json:"scope"`
	TopicShedsTotal        *uint64          `json:"topic_sheds_total,omitempty"`
	VoiceSessions          *int             `json:"voice_sessions,omitempty"`
	WSBroadcastMs          *metrics.Summary `json:"ws_broadcast_ms,omitempty"`
	WSConnectionRejects    *uint64          `json:"ws_connection_rejects,omitempty"`
	WSDispatchLagMs        *metrics.Summary `json:"ws_dispatch_lag_ms,omitempty"`
}

func supportHealth(hub HubBroadcaster, at time.Time) healthSnapshot {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	out := healthSnapshot{CapturedAt: at, Scope: supportHealthScope, DatabaseReadable: true, Goroutines: runtime.NumGoroutine(), HeapAllocBytes: mem.HeapAlloc, GCCycles: mem.NumGC}
	if hub != nil {
		out.ConnectedUsers = new(hub.UserCount())
	}
	if h, ok := hub.(supportHubMetrics); ok {
		out.VoiceSessions = new(h.VoiceSessionCount())
		out.WSConnectionRejects = new(h.ConnRejectCount())
		out.DispatchAlive = new(h.DispatchAlive())
		out.BroadcastDrops = new(h.BroadcastDropCount())
		qd, hp, lp := h.BackpressureStats()
		out.QueueDisconnects, out.HighPriorityFallbacks, out.LowPriorityDrops = &qd, &hp, &lp
		rb, rd, rf := h.ReconnectTierStats()
		out.ReconnectBuffer, out.ReconnectDatabase, out.ReconnectFull = &rb, &rd, &rf
	}
	// SRE-M1's shipped latency surface: aggregate distributions and gauges,
	// no per-user labels.
	if h, ok := hub.(supportHubLatency); ok {
		out.TopicShedsTotal = new(h.TopicShedCount())
		out.WSBroadcastMs = new(h.BroadcastMs())
		out.WSDispatchLagMs = new(h.DispatchLagMs())
		out.ChatSendAckMs = new(h.ChatAckMs())
		out.HubBroadcastQueueDepth = new(h.BroadcastQueueDepth())
		out.HubSeqMuMaxHoldMs = new(h.SeqMuMaxHoldMs())
	}
	if v, ok := hub.(supportHubVoice); ok && v.LiveKitManaged() {
		status := v.LiveKitProcessStatus()
		out.LiveKitManaged = new(true)
		out.LiveKitHealthy = new(status.Running)
		out.LiveKitRestarts = new(status.Restarts)
		out.LiveKitGaveUp = new(status.GaveUp)
		if !status.NextRetryAt.IsZero() {
			out.LiveKitNextRetryAt = new(status.NextRetryAt.UTC())
		}
	}
	return out
}
