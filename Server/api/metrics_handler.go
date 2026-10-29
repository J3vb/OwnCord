package api

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"runtime"
	"slices"
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
	// seq was assigned — replay cannot recover them, so like
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
	// ReconnectRingMisses counts resumes that passed the resync checks but fell
	// behind the in-memory replay ring: the only ones the events table can
	// serve. Usually ends in db or full; not a tier. Hit rate = db / this.
	ReconnectRingMisses uint64 `json:"reconnect_ring_misses"`

	// Per-client send-queue backpressure totals.
	BackpressureQueueDisconnects uint64 `json:"backpressure_queue_disconnects"`
	BackpressureHighFallbacks    uint64 `json:"backpressure_high_fallbacks"`
	BackpressureLowDrops         uint64 `json:"backpressure_low_drops"`
	BackpressurePresenceDrops    uint64 `json:"backpressure_presence_drops"`

	// DeliveryLossMarks counts connected clients told to resync because a
	// sequenced frame meant for them was dropped or withheld (2A-5).
	DeliveryLossMarks uint64 `json:"delivery_loss_marks"`

	// WSConnRejects counts upgrades refused by the max_ws_connections cap.
	WSConnRejects uint64 `json:"ws_conn_rejects"`

	// DiskFreeMB is free space on the data volume; omitted when unknown.
	DiskFreeMB *float64 `json:"disk_free_mb,omitempty"`
	// DiskMinFreeMB is the reserved-headroom floor (server.min_free_disk_mb)
	// the banner, /health and the upload path share; DiskLow is free < floor,
	// present when free is known and a floor is set (a disk pressure signal).
	DiskMinFreeMB float64 `json:"disk_min_free_mb"`
	DiskLow       *bool   `json:"disk_low,omitempty"`
	// UploadStorageUsedMB is every attachment row's size summed — a storage
	// total, not the per-user quota counters (which skip legacy rows with no
	// uploader). Emoji, a bounded exclusion, are not in it. Omitted when the
	// query fails.
	UploadStorageUsedMB *float64 `json:"upload_storage_used_mb,omitempty"`
	// DBWALMB is the SQLite write-ahead log file's size, stat'd once per
	// scrape. A WAL that keeps growing means checkpoints are not keeping up.
	// Omitted when no source is wired or the stat fails.
	DBWALMB *float64 `json:"db_wal_mb,omitempty"`

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

	// Web Push dispatch — aggregate counters only,
	// never per user. Zero on a server with dispatch off, which is the
	// compiled default.
	PushDispatched uint64 `json:"push_dispatched"`
	PushFailed     uint64 `json:"push_failed"`
	PushPruned     uint64 `json:"push_pruned"`

	EventPersister *EventPersisterMetrics `json:"event_persister,omitempty"`

	// Windows holds the same latency, worst-hold and counter figures over the
	// last minute ("1m") and fifteen minutes ("15m"), where every figure above
	// is cumulative since boot. Omitted until the sampler has two
	// samples, and when no windowed source is wired.
	Windows map[string]*WindowMetrics `json:"windows,omitempty"`
}

// metricsWindows are the two windows reported, newest-ending, by JSON key.
var metricsWindows = []struct {
	key string
	d   time.Duration
}{{"1m", time.Minute}, {"15m", 15 * time.Minute}}

// WindowMetrics is one window of ServerMetrics.Windows. The field names repeat
// the top-level keys; the counters are the growth over the window. Seconds is
// what the window really covers (shorter than its name for a young process) and
// AsOf the newest sample it ends at, at most one sampler tick old.
type WindowMetrics struct {
	Seconds float64 `json:"seconds"`
	AsOf    string  `json:"as_of"`

	BroadcastMs    *metrics.Summary    `json:"ws_broadcast_ms,omitempty"`
	DispatchLagMs  *metrics.Summary    `json:"ws_dispatch_lag_ms,omitempty"`
	ChatAckMs      *metrics.Summary    `json:"chat_send_ack_ms,omitempty"`
	VoiceJoinMs    *ws.VoiceJoinPhases `json:"voice_join_ms,omitempty"`
	SeqMuMaxHoldMs float64             `json:"hub_seqmu_max_hold_ms"`

	BroadcastDrops               uint64  `json:"broadcast_drops"`
	TopicSheds                   uint64  `json:"topic_sheds_total"`
	ReconnectTierBuffer          uint64  `json:"reconnect_tier_buffer"`
	ReconnectTierDB              uint64  `json:"reconnect_tier_db"`
	ReconnectTierFull            uint64  `json:"reconnect_tier_full"`
	ReconnectRingMisses          uint64  `json:"reconnect_ring_misses"`
	BackpressureQueueDisconnects uint64  `json:"backpressure_queue_disconnects"`
	BackpressureHighFallbacks    uint64  `json:"backpressure_high_fallbacks"`
	BackpressureLowDrops         uint64  `json:"backpressure_low_drops"`
	BackpressurePresenceDrops    uint64  `json:"backpressure_presence_drops"`
	DeliveryLossMarks            uint64  `json:"delivery_loss_marks"`
	WSConnRejects                uint64  `json:"ws_conn_rejects"`
	DBWriterWaitCount            uint64  `json:"db_writer_wait_count"`
	DBWriterWaitSeconds          float64 `json:"db_writer_wait_seconds"`
	DBReaderWaitCount            uint64  `json:"db_reader_wait_count"`
	DBReaderWaitSeconds          float64 `json:"db_reader_wait_seconds"`
}

// Window source names that are not JSON keys: the database wait time is
// sampled in nanoseconds and reported in seconds.
const (
	windowDBWriterWaitNanos = "db_writer_wait_nanos"
	windowDBReaderWaitNanos = "db_reader_wait_nanos"
)

// NewWindowMetrics maps one snapshot, whose names are the sources' JSON keys,
// onto the response shape. A name the sources did not register stays zero (or
// nil for a summary).
func NewWindowMetrics(s metrics.WindowSnapshot) *WindowMetrics {
	summary := func(name string) *metrics.Summary {
		v, ok := s.Histograms[name]
		if !ok {
			return nil
		}
		return &v
	}
	w := &WindowMetrics{
		Seconds:        s.Seconds,
		AsOf:           s.AsOf.UTC().Format(time.RFC3339),
		BroadcastMs:    summary("ws_broadcast_ms"),
		DispatchLagMs:  summary("ws_dispatch_lag_ms"),
		ChatAckMs:      summary("chat_send_ack_ms"),
		SeqMuMaxHoldMs: s.MaxGauges["hub_seqmu_max_hold_ms"],

		BroadcastDrops:               s.Counters["broadcast_drops"],
		TopicSheds:                   s.Counters["topic_sheds_total"],
		ReconnectTierBuffer:          s.Counters["reconnect_tier_buffer"],
		ReconnectTierDB:              s.Counters["reconnect_tier_db"],
		ReconnectTierFull:            s.Counters["reconnect_tier_full"],
		ReconnectRingMisses:          s.Counters["reconnect_ring_misses"],
		BackpressureQueueDisconnects: s.Counters["backpressure_queue_disconnects"],
		BackpressureHighFallbacks:    s.Counters["backpressure_high_fallbacks"],
		BackpressureLowDrops:         s.Counters["backpressure_low_drops"],
		BackpressurePresenceDrops:    s.Counters["backpressure_presence_drops"],
		DeliveryLossMarks:            s.Counters["delivery_loss_marks"],
		WSConnRejects:                s.Counters["ws_conn_rejects"],
		DBWriterWaitCount:            s.Counters["db_writer_wait_count"],
		DBWriterWaitSeconds:          float64(s.Counters[windowDBWriterWaitNanos]) / float64(time.Second),
		DBReaderWaitCount:            s.Counters["db_reader_wait_count"],
		DBReaderWaitSeconds:          float64(s.Counters[windowDBReaderWaitNanos]) / float64(time.Second),
	}
	// All six phases are registered together; a missing one means no voice
	// source, and the key is left out rather than half filled.
	phases := [6]*metrics.Summary{
		summary("voice_join_ms.precheck"), summary("voice_join_ms.leave"),
		summary("voice_join_ms.persist"), summary("voice_join_ms.token"),
		summary("voice_join_ms.complete"), summary("voice_join_ms.total"),
	}
	if !slices.Contains(phases[:], nil) {
		w.VoiceJoinMs = &ws.VoiceJoinPhases{
			Precheck: *phases[0], Leave: *phases[1], Persist: *phases[2],
			Token: *phases[3], Complete: *phases[4], Total: *phases[5],
		}
	}
	return w
}

// fillWindows adds the windowed block. A window the sampler cannot yet answer
// is left out, so nothing reports a reassuring zero.
func fillWindows(m *ServerMetrics, src MetricsSources) {
	if src.Windows == nil {
		return
	}
	for _, win := range metricsWindows {
		snap, ok := src.Windows(win.d)
		if !ok {
			continue
		}
		if m.Windows == nil {
			m.Windows = make(map[string]*WindowMetrics, len(metricsWindows))
		}
		m.Windows[win.key] = NewWindowMetrics(snap)
	}
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
	ReconnectRingMisses func() uint64
	Backpressure        func() (queueDisconnects, highFallbacks, lowDrops uint64)
	PresenceDrops       func() uint64
	LossMarks           func() uint64
	ConnRejects         func() uint64
	PersisterStats      func() (persisted, dropped, flushes, errs uint64, ok bool)
	DBStats             func() sql.DBStats // writer pool
	DBReaderStats       func() sql.DBStats // reader pool
	PermCache           func() (hits, misses uint64)
	DiskFree            func() (uint64, error)
	DiskMinFree         uint64
	UploadBytes         func(context.Context) (int64, error)
	WALBytes            func() (int64, error) // db.(*DB).WALBytes: one stat per scrape
	// PushCounters is nil when dispatch is off (the compiled default); the
	// three fields stay at their zero value then.
	PushCounters func() (dispatched, failed, pruned uint64)
	// Windows answers a window of the given length ending at the newest
	// sample (metrics.Windows.Snapshot); nil leaves the "windows" key out.
	Windows func(time.Duration) (metrics.WindowSnapshot, bool)
	// LatencyCounts reads the raw counts of every latency histogram for the
	// Prometheus exposition (ws.Hub.LatencyCounts); nil leaves the histogram
	// families out. The JSON endpoint does not use it.
	LatencyCounts func() ws.LatencyCounts
}

// handleMetrics returns an HTTP handler that reports runtime server metrics.
func handleMetrics(src MetricsSources) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, collectMetrics(r.Context(), src))
	}
}

// collectMetrics reads every source once into a ServerMetrics. It is the one
// collector behind both encoders, the JSON handler above and the Prometheus
// handler (metrics_prometheus.go), so the two formats cannot disagree.
func collectMetrics(ctx context.Context, src MetricsSources) ServerMetrics {
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
	fillHubLatency(&metrics, src)
	if src.LiveKitHealth != nil {
		healthy, _ := src.LiveKitHealth(ctx)
		metrics.LiveKitHealthy = &healthy
	}
	fillDelivery(&metrics, src)
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
		if n, err := src.UploadBytes(ctx); err == nil {
			mb := float64(n) / 1024 / 1024
			metrics.UploadStorageUsedMB = &mb
		}
	}
	if src.WALBytes != nil {
		if n, err := src.WALBytes(); err == nil {
			mb := float64(n) / 1024 / 1024
			metrics.DBWALMB = &mb
		} else {
			slog.Debug("metrics: wal size unavailable", "error", err)
		}
	}
	if src.PushCounters != nil {
		metrics.PushDispatched, metrics.PushFailed, metrics.PushPruned = src.PushCounters()
	}

	fillWindows(&metrics, src)

	return metrics
}

// fillHubLatency copies the hub's latency distributions, queue depth, seqMu
// hold and topic sheds into metrics.
// fillDelivery copies the reconnect-tier, send-queue and delivery-loss totals.
func fillDelivery(metrics *ServerMetrics, src MetricsSources) {
	if src.ReconnectTiers != nil {
		metrics.ReconnectTierBuffer, metrics.ReconnectTierDB, metrics.ReconnectTierFull = src.ReconnectTiers()
	}
	if src.ReconnectRingMisses != nil {
		metrics.ReconnectRingMisses = src.ReconnectRingMisses()
	}
	if src.Backpressure != nil {
		metrics.BackpressureQueueDisconnects, metrics.BackpressureHighFallbacks, metrics.BackpressureLowDrops = src.Backpressure()
	}
	if src.PresenceDrops != nil {
		metrics.BackpressurePresenceDrops = src.PresenceDrops()
	}
	if src.LossMarks != nil {
		metrics.DeliveryLossMarks = src.LossMarks()
	}
}

func fillHubLatency(metrics *ServerMetrics, src MetricsSources) {
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
}
