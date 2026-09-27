package api

import (
	"context"
	"database/sql"
	"net/http"
	"runtime"
	"time"

	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/ws"
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
	// TopicSheds counts channel frames dropped by the topic limiter before a
	// seq was assigned (SRV-03) — replay cannot recover them, so like
	// broadcast_drops any growth is worth alerting on.
	TopicSheds     uint64 `json:"topic_sheds_total"`
	LiveKitHealthy *bool  `json:"livekit_healthy,omitempty"`

	// Shipped in-process latency distributions (SRE-M1). These exist in every
	// build, unlike the OpenTelemetry instruments, which compile only with
	// -tags otel.
	BroadcastMs   *metrics.Summary `json:"ws_broadcast_ms,omitempty"`
	DispatchLagMs *metrics.Summary `json:"ws_dispatch_lag_ms,omitempty"`
	ChatAckMs     *metrics.Summary `json:"chat_send_ack_ms,omitempty"`
	// VoiceJoinMs is each phase of a completed voice join (voice_join_ms).
	VoiceJoinMs *ws.VoiceJoinPhases `json:"voice_join_ms,omitempty"`

	// BroadcastQueueDepth is the hub dispatch channel's current depth; the
	// max-seqMu-hold gauge is the worst single critical-section hold.
	BroadcastQueueDepth int     `json:"hub_broadcast_queue_depth"`
	SeqMuMaxHoldMs      float64 `json:"hub_seqmu_max_hold_ms"`

	// Reconnect replay tier hits. A rising full-resync share means the replay
	// budget (ring size / cold cap) is too small for observed disconnect gaps.
	ReconnectTierBuffer uint64 `json:"reconnect_tier_buffer"`
	ReconnectTierDB     uint64 `json:"reconnect_tier_db"`
	ReconnectTierFull   uint64 `json:"reconnect_tier_full"`

	// Per-client send-queue backpressure totals.
	BackpressureQueueDisconnects uint64 `json:"backpressure_queue_disconnects"`
	BackpressureHighFallbacks    uint64 `json:"backpressure_high_fallbacks"`
	BackpressureLowDrops         uint64 `json:"backpressure_low_drops"`

	// WSConnRejects counts upgrades refused by the max_ws_connections cap.
	WSConnRejects uint64 `json:"ws_conn_rejects"`

	// DiskFreeMB is free space on the data volume; omitted when unknown.
	DiskFreeMB *float64 `json:"disk_free_mb,omitempty"`
	// DiskMinFreeMB is the reserved-headroom floor (server.min_free_disk_mb)
	// the banner, /health and the upload path share; DiskLow is free < floor,
	// present when free is known and a floor is set (B5-2 pressure signal).
	DiskMinFreeMB float64 `json:"disk_min_free_mb"`
	DiskLow       *bool   `json:"disk_low,omitempty"`
	// UploadStorageUsedMB is every attachment row's size summed — a storage
	// total, not the per-user quota counters (which skip legacy rows with no
	// uploader). Emoji, a bounded exclusion, are not in it. Omitted when the
	// query fails.
	UploadStorageUsedMB *float64 `json:"upload_storage_used_mb,omitempty"`

	// SQLite writer-pool saturation: time spent queueing for the single write
	// connection. The most direct signal for the documented single-writer
	// bottleneck.
	DBWriterWaitCount   int64   `json:"db_writer_wait_count"`
	DBWriterWaitSeconds float64 `json:"db_writer_wait_seconds"`

	// SQLite reader-pool saturation: time spent queueing for a reader
	// connection (max_readers per pool). On in-memory databases reader ==
	// writer, so this duplicates the writer pair there.
	DBReaderWaitCount   int64   `json:"db_reader_wait_count"`
	DBReaderWaitSeconds float64 `json:"db_reader_wait_seconds"`

	// Permission cache effectiveness.
	PermCacheHits   uint64 `json:"perm_cache_hits"`
	PermCacheMisses uint64 `json:"perm_cache_misses"`

	// Web Push dispatch (B5-11, behind HP-5) — aggregate counters only,
	// never per user. Zero on a server with dispatch off, which is the
	// compiled default.
	PushDispatched uint64 `json:"push_dispatched"`
	PushFailed     uint64 `json:"push_failed"`
	PushPruned     uint64 `json:"push_pruned"`

	EventPersister *EventPersisterMetrics `json:"event_persister,omitempty"`
}

// MetricsSources provides the live data feeds for handleMetrics. Any nil
// field is skipped, leaving that metric at its zero value (or absent for
// pointer-typed output), so tests and partial wirings stay cheap.
type MetricsSources struct {
	ConnectedUsers func() int
	VoiceSessions  func() int
	BroadcastDrops func() uint64
	// TopicSheds, BroadcastMs, DispatchLagMs, ChatAckMs, VoiceJoinMs,
	// BroadcastQueueDepth and SeqMuMaxHoldMs are the shipped in-process metrics (SRE-M1). Nil
	// fields are skipped, so tests and partial wirings stay cheap.
	TopicSheds          func() uint64
	BroadcastMs         func() metrics.Summary
	DispatchLagMs       func() metrics.Summary
	ChatAckMs           func() metrics.Summary
	VoiceJoinMs         func() ws.VoiceJoinPhases
	BroadcastQueueDepth func() int
	SeqMuMaxHoldMs      func() float64
	LiveKitHealth       func(context.Context) (bool, error)
	ReconnectTiers      func() (buffer, db, full uint64)
	Backpressure        func() (queueDisconnects, highFallbacks, lowDrops uint64)
	ConnRejects         func() uint64
	PersisterStats      func() (persisted, dropped, flushes, errs uint64, ok bool)
	DBStats             func() sql.DBStats // writer pool
	DBReaderStats       func() sql.DBStats // reader pool
	PermCache           func() (hits, misses uint64)
	DiskFree            func() (uint64, error)
	DiskMinFree         uint64
	UploadBytes         func(context.Context) (int64, error)
	// PushCounters is nil when dispatch is off (the compiled default); the
	// three fields stay at their zero value then.
	PushCounters func() (dispatched, failed, pruned uint64)
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
		if src.TopicSheds != nil {
			metrics.TopicSheds = src.TopicSheds()
		}
		if src.BroadcastMs != nil {
			s := src.BroadcastMs()
			metrics.BroadcastMs = &s
		}
		if src.DispatchLagMs != nil {
			s := src.DispatchLagMs()
			metrics.DispatchLagMs = &s
		}
		if src.ChatAckMs != nil {
			s := src.ChatAckMs()
			metrics.ChatAckMs = &s
		}
		if src.VoiceJoinMs != nil {
			v := src.VoiceJoinMs()
			metrics.VoiceJoinMs = &v
		}
		if src.BroadcastQueueDepth != nil {
			metrics.BroadcastQueueDepth = src.BroadcastQueueDepth()
		}
		if src.SeqMuMaxHoldMs != nil {
			metrics.SeqMuMaxHoldMs = src.SeqMuMaxHoldMs()
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
		if src.DBReaderStats != nil {
			st := src.DBReaderStats()
			metrics.DBReaderWaitCount = st.WaitCount
			metrics.DBReaderWaitSeconds = st.WaitDuration.Seconds()
		}
		if src.PermCache != nil {
			metrics.PermCacheHits, metrics.PermCacheMisses = src.PermCache()
		}
		if src.ConnRejects != nil {
			metrics.WSConnRejects = src.ConnRejects()
		}
		metrics.DiskMinFreeMB = float64(src.DiskMinFree) / 1024 / 1024
		if src.DiskFree != nil {
			if free, err := src.DiskFree(); err == nil {
				mb := float64(free) / 1024 / 1024
				metrics.DiskFreeMB = &mb
				if src.DiskMinFree > 0 {
					low := free < src.DiskMinFree
					metrics.DiskLow = &low
				}
			}
		}
		if src.UploadBytes != nil {
			if n, err := src.UploadBytes(r.Context()); err == nil {
				mb := float64(n) / 1024 / 1024
				metrics.UploadStorageUsedMB = &mb
			}
		}
		if src.PushCounters != nil {
			metrics.PushDispatched, metrics.PushFailed, metrics.PushPruned = src.PushCounters()
		}

		writeJSON(w, http.StatusOK, metrics)
	}
}
