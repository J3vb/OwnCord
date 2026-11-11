package hubstats

import "sync/atomic"

// Counters are the hub's process-lifetime totals for the metrics endpoint: plain atomics
// that callers Add and Load directly. Must not be copied.
type Counters struct {
	// BroadcastDrops counts messages dropped because the broadcast channel was full.
	BroadcastDrops atomic.Uint64
	// Aggregate backpressure counters: the per-client drop count is lost at disconnect; these survive as process
	// totals.
	BPQueueDisconnects atomic.Uint64 // clients disconnected because send (or high+send) overflowed
	BPHighFallbacks    atomic.Uint64 // high-priority sends that fell back to the normal buffer
	BPLowDrops         atomic.Uint64 // low-priority messages silently dropped on overflow

	ConnRejects atomic.Uint64 // upgrades refused by the max_ws_connections guardrail

	// Reconnection tier metrics, incremented per resume.
	ReconnectTierBuf  atomic.Uint64
	ReconnectTierDB   atomic.Uint64
	ReconnectTierFull atomic.Uint64
	ReconnectRingMiss atomic.Uint64 // resumes behind the ring; usually ends in db or full
}
