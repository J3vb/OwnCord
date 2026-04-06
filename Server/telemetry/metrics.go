// Phase B Step 8 — declared application metrics.
//
// Instruments are constructed lazily against the global Provider so callers
// don't need to thread a Meter through every constructor. Hot-path callers
// should cache the returned instrument in a struct field rather than calling
// these helpers per request — they take a sync.RWMutex to read the global
// provider and the cost adds up at high throughput.
package telemetry

import "sync"

const (
	scopeWS      = "github.com/owncord/server/ws"
	scopeService = "github.com/owncord/server/service"
	scopeDB      = "github.com/owncord/server/db"
	scopeVoice   = "github.com/owncord/server/voice"
)

// AppMetrics is the canonical bundle of meters used across the server. Build
// it once at startup with NewAppMetrics() and stash it on the relevant
// long-lived structs (Hub, services, etc).
type AppMetrics struct {
	WSMessagesTotal        Counter
	WSActiveConnections    Gauge
	WSBroadcastLatency     Histogram
	WSReconnectTierTotal   Counter
	WSEventsPersisted      Counter
	WSEventsDropped        Counter
	WSEventsPersistErrors  Counter
	DBQueryDurationSec     Histogram
	VoiceActiveSessions    Gauge
	VoiceParticipants      Gauge
	ServiceCallDurationSec Histogram
}

var (
	appMetricsMu   sync.Mutex
	appMetricsInst *AppMetrics
)

// NewAppMetrics returns a process-wide AppMetrics, lazily constructed against
// the current global provider. Calling it multiple times returns the same
// instance until resetAppMetricsForInit() is called (which Init uses after
// swapping the global provider so instruments re-bind to the new meter).
func NewAppMetrics() *AppMetrics {
	appMetricsMu.Lock()
	defer appMetricsMu.Unlock()
	if appMetricsInst != nil {
		return appMetricsInst
	}
	ws := GlobalMeter(scopeWS)
	svc := GlobalMeter(scopeService)
	db := GlobalMeter(scopeDB)
	voice := GlobalMeter(scopeVoice)
	appMetricsInst = &AppMetrics{
		WSMessagesTotal:        ws.Counter("ws_messages_total", "WebSocket messages broadcast"),
		WSActiveConnections:    ws.Gauge("ws_active_connections", "Currently connected WebSocket clients"),
		WSBroadcastLatency:     ws.Histogram("ws_broadcast_latency_seconds", "Wall-clock seconds from enqueue to fanout completion", "s"),
		WSReconnectTierTotal:   ws.Counter("ws_reconnect_tier_total", "Reconnection replay tier hits, attribute tier=buffer|db|full"),
		WSEventsPersisted:      ws.Counter("ws_events_persisted_total", "Events written to the cold-tier event log"),
		WSEventsDropped:        ws.Counter("ws_events_dropped_total", "Events dropped because the persister queue was full"),
		WSEventsPersistErrors:  ws.Counter("ws_events_persist_errors_total", "PersistEvent calls that returned an error from the underlying store"),
		DBQueryDurationSec:     db.Histogram("db_query_duration_seconds", "Per-query wall time", "s"),
		VoiceActiveSessions:    voice.Gauge("voice_active_sessions", "Active LiveKit rooms"),
		VoiceParticipants:      voice.Gauge("voice_participants", "Connected LiveKit participants across all rooms"),
		ServiceCallDurationSec: svc.Histogram("service_call_duration_seconds", "Service-layer method execution time", "s"),
	}
	return appMetricsInst
}

// resetAppMetricsForInit drops the cached AppMetrics bundle so the next
// NewAppMetrics() call re-binds instruments against whatever provider is now
// global. The real OTel Init uses this to migrate from the no-op provider
// installed by the package-level init() to the SDK-backed one.
func resetAppMetricsForInit() {
	appMetricsMu.Lock()
	defer appMetricsMu.Unlock()
	appMetricsInst = nil
}
