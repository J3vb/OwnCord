package admin

import (
	"runtime"
	"time"
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

func supportHealth(hub HubBroadcaster, at time.Time) map[string]any {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	out := map[string]any{"captured_at": at, "scope": "database, process and local hub counters; LiveKit and client media paths are not tested", "database_readable": true, "goroutines": runtime.NumGoroutine(), "heap_alloc_bytes": mem.HeapAlloc, "gc_cycles": mem.NumGC}
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
	return out
}
