// Declared application metrics, built lazily against the global Provider.
// Hot-path callers should cache the instrument: these helpers take a RWMutex.

package telemetry

import (
	"sync"
	"sync/atomic"
)

const (
	scopeWS      = "github.com/J3vb/OwnCord/Server/ws"
	scopeService = "github.com/J3vb/OwnCord/Server/service"
	scopeVoice   = "github.com/J3vb/OwnCord/Server/voice"
)

// AppMetrics is the bundle of meters used across the server; build it once with NewAppMetrics().
type AppMetrics struct {
	WSMessagesTotal        Counter
	WSActiveConnections    Gauge
	WSBroadcastLatency     Histogram
	WSReconnectTierTotal   Counter
	WSEventsPersisted      Counter
	WSEventsDropped        Counter
	WSEventsPersistErrors  Counter
	VoiceActiveSessions    Gauge
	VoiceParticipants      Gauge
	ServiceCallDurationSec Histogram
}

var (
	appMetricsMu   sync.Mutex // serializes construction and reset
	appMetricsInst atomic.Pointer[AppMetrics]
)

// NewAppMetrics returns the process-wide AppMetrics, bound to the current
// global provider; it is the same instance until resetAppMetricsForInit (Init
// calls it after swapping providers). The steady state is one atomic load
// because service-method defers call it per request; a sync.Once cannot be
// re-armed, hence the pointer plus construction mutex.
func NewAppMetrics() *AppMetrics {
	if m := appMetricsInst.Load(); m != nil {
		return m
	}
	appMetricsMu.Lock()
	defer appMetricsMu.Unlock()
	if m := appMetricsInst.Load(); m != nil {
		return m
	}
	ws := GlobalMeter(scopeWS)
	svc := GlobalMeter(scopeService)
	voice := GlobalMeter(scopeVoice)
	m := &AppMetrics{
		WSMessagesTotal:        ws.Counter("ws_messages_total", "WebSocket messages broadcast"),
		WSActiveConnections:    ws.Gauge("ws_active_connections", "Currently connected WebSocket clients"),
		WSBroadcastLatency:     ws.Histogram("ws_broadcast_latency_seconds", "Wall-clock seconds from enqueue to fanout completion", "s"),
		WSReconnectTierTotal:   ws.Counter("ws_reconnect_tier_total", "Reconnection replay tier hits, attribute tier=buffer|db|full"),
		WSEventsPersisted:      ws.Counter("ws_events_persisted_total", "Events written to the cold-tier event log"),
		WSEventsDropped:        ws.Counter("ws_events_dropped_total", "Events dropped because the persister queue was full"),
		WSEventsPersistErrors:  ws.Counter("ws_events_persist_errors_total", "PersistEvent calls that returned an error from the underlying store"),
		VoiceActiveSessions:    voice.Gauge("voice_active_sessions", "Active LiveKit rooms"),
		VoiceParticipants:      voice.Gauge("voice_participants", "Connected LiveKit participants across all rooms"),
		ServiceCallDurationSec: svc.Histogram("service_call_duration_seconds", "Service-layer method execution time", "s"),
	}
	appMetricsInst.Store(m)
	return m
}

// resetAppMetricsForInit drops the cached bundle so the next NewAppMetrics
// re-binds to the now-global provider (the real Init migrates off the no-op one).
func resetAppMetricsForInit() { //nolint:unused // called by otel-tagged build only
	appMetricsMu.Lock()
	defer appMetricsMu.Unlock()
	appMetricsInst.Store(nil)
}
