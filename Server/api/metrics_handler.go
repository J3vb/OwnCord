package api

import (
	"context"
	"database/sql"
	"net/http"
	"runtime"
	"time"
)

// EventPersisterMetrics is the nested event-persistence block of ServerMetrics.
// Present only when event persistence is enabled.
type EventPersisterMetrics struct {
	Persisted uint64 `json:"persisted"`
	Dropped   uint64 `json:"dropped"`
	Flushes   uint64 `json:"flushes"`
	Errors    uint64 `json:"errors"`
}

// ServerMetrics holds runtime metrics for the /api/v1/metrics endpoint.
// The shape is documented in docs/deployment.md — keep the two in sync.
type ServerMetrics struct {
	Uptime         string  `json:"uptime"`
	UptimeSeconds  float64 `json:"uptime_seconds"`
	GoRoutines     int     `json:"goroutines"`
	HeapAllocMB    float64 `json:"heap_alloc_mb"`
	HeapSysMB      float64 `json:"heap_sys_mb"`
	NumGC          uint32  `json:"num_gc"`
	ConnectedUsers int     `json:"connected_users"`
	VoiceSessions  int     `json:"voice_sessions"`
	// BroadcastDrops counts messages dropped because the hub-wide broadcast
	// queue was full — a hub-level overload signal, distinct from the
	// per-client backpressure counters below. Any nonzero growth here means
	// sequenced events were lost before delivery and is worth alerting on.
	BroadcastDrops uint64 `json:"broadcast_drops"`
	LiveKitHealthy *bool  `json:"livekit_healthy,omitempty"`

	// Reconnect replay tier hits. A rising full-resync share means the replay
	// budget (ring size / cold cap) is too small for observed disconnect gaps.
	ReconnectTierBuffer uint64 `json:"reconnect_tier_buffer"`
	ReconnectTierDB     uint64 `json:"reconnect_tier_db"`
	ReconnectTierFull   uint64 `json:"reconnect_tier_full"`

	// Per-client send-queue backpressure totals.
	BackpressureQueueDisconnects uint64 `json:"backpressure_queue_disconnects"`
	BackpressureHighFallbacks    uint64 `json:"backpressure_high_fallbacks"`
	BackpressureLowDrops         uint64 `json:"backpressure_low_drops"`

	// SQLite writer-pool saturation: time spent queueing for the single write
	// connection. The most direct signal for the documented single-writer
	// bottleneck.
	DBWriterWaitCount   int64   `json:"db_writer_wait_count"`
	DBWriterWaitSeconds float64 `json:"db_writer_wait_seconds"`

	// Permission cache effectiveness.
	PermCacheHits   uint64 `json:"perm_cache_hits"`
	PermCacheMisses uint64 `json:"perm_cache_misses"`

	EventPersister *EventPersisterMetrics `json:"event_persister,omitempty"`
}

// MetricsSources provides the live data feeds for handleMetrics. Any nil
// field is skipped, leaving that metric at its zero value (or absent for
// pointer-typed output), so tests and partial wirings stay cheap.
type MetricsSources struct {
	ConnectedUsers func() int
	VoiceSessions  func() int
	BroadcastDrops func() uint64
	LiveKitHealth  func(context.Context) (bool, error)
	ReconnectTiers func() (buffer, db, full uint64)
	Backpressure   func() (queueDisconnects, highFallbacks, lowDrops uint64)
	PersisterStats func() (persisted, dropped, flushes, errs uint64, ok bool)
	DBStats        func() sql.DBStats // writer pool
	PermCache      func() (hits, misses uint64)
}

// handleMetrics returns an HTTP handler that reports runtime server metrics.
func handleMetrics(src MetricsSources) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)

		uptime := time.Since(serverStartTime)
		metrics := ServerMetrics{
			Uptime:        uptime.Truncate(time.Second).String(),
			UptimeSeconds: uptime.Seconds(),
			GoRoutines:    runtime.NumGoroutine(),
			HeapAllocMB:   float64(m.HeapAlloc) / 1024 / 1024,
			HeapSysMB:     float64(m.HeapSys) / 1024 / 1024,
			NumGC:         m.NumGC,
		}

		if src.ConnectedUsers != nil {
			metrics.ConnectedUsers = src.ConnectedUsers()
		}
		if src.VoiceSessions != nil {
			metrics.VoiceSessions = src.VoiceSessions()
		}
		if src.BroadcastDrops != nil {
			metrics.BroadcastDrops = src.BroadcastDrops()
		}
		if src.LiveKitHealth != nil {
			healthy, _ := src.LiveKitHealth(r.Context())
			metrics.LiveKitHealthy = &healthy
		}
		if src.ReconnectTiers != nil {
			metrics.ReconnectTierBuffer, metrics.ReconnectTierDB, metrics.ReconnectTierFull = src.ReconnectTiers()
		}
		if src.Backpressure != nil {
			metrics.BackpressureQueueDisconnects, metrics.BackpressureHighFallbacks, metrics.BackpressureLowDrops = src.Backpressure()
		}
		if src.PersisterStats != nil {
			if persisted, dropped, flushes, errs, ok := src.PersisterStats(); ok {
				metrics.EventPersister = &EventPersisterMetrics{
					Persisted: persisted,
					Dropped:   dropped,
					Flushes:   flushes,
					Errors:    errs,
				}
			}
		}
		if src.DBStats != nil {
			st := src.DBStats()
			metrics.DBWriterWaitCount = st.WaitCount
			metrics.DBWriterWaitSeconds = st.WaitDuration.Seconds()
		}
		if src.PermCache != nil {
			metrics.PermCacheHits, metrics.PermCacheMisses = src.PermCache()
		}

		writeJSON(w, http.StatusOK, metrics)
	}
}
