package admin

import (
	"runtime"
	"time"

	"github.com/J3vb/OwnCord/Server/ws"
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

// supportHubVoice reports the supervised LiveKit companion's local state.
// Reading it probes nothing and discovers no address — it is the supervisor's
// own running/restart flags, the same values the attention panel reads.
type supportHubVoice interface {
	LiveKitProcessStatus() ws.LiveKitProcessStatus
	LiveKitManaged() bool
}

func supportHealth(hub HubBroadcaster, at time.Time) map[string]any {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	out := map[string]any{"captured_at": at, "scope": "database, process and local hub counters; LiveKit is reported from the supervisor's own state, never probed", "database_readable": true, "goroutines": runtime.NumGoroutine(), "heap_alloc_bytes": mem.HeapAlloc, "gc_cycles": mem.NumGC}
	if hub != nil {
		out["connected_users"] = hub.ClientCount()
	}
	if h, ok := hub.(supportHubMetrics); ok {
		out["voice_sessions"] = h.VoiceSessionCount()
		out["broadcast_drops"] = h.BroadcastDropCount()
		out["dispatch_alive"] = h.DispatchAlive()
		out["ws_connection_rejects"] = h.ConnRejectCount()
		out["queue_disconnects"], out["high_priority_fallbacks"], out["low_priority_drops"] = h.BackpressureStats()
		out["reconnect_buffer"], out["reconnect_database"], out["reconnect_full"] = h.ReconnectTierStats()
	}
	if v, ok := hub.(supportHubVoice); ok && v.LiveKitManaged() {
		status := v.LiveKitProcessStatus()
		out["livekit_managed"] = true
		out["livekit_healthy"] = status.Running
		out["livekit_restarts"] = status.Restarts
		out["livekit_gave_up"] = status.GaveUp
	}
	return out
}
