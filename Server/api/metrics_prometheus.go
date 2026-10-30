package api

import (
	"net/http"

	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/ws"
)

// The Prometheus exposition of GET /api/v1/metrics/prometheus. It is
// hand-written (metrics.PromText) so the default build, which no release or
// image compiles with -tags otel, carries no prometheus client library. The
// figures come from the same collectMetrics call as the JSON, converted to base
// units: milliseconds become seconds and megabytes become bytes. The windowed
// deltas and the p50/p95/p99 summaries are not exported, because rate() and
// histogram_quantile() derive them; the windowed maxima are, because no query
// can (owncord_latency_max_seconds).

// promVoicePhases are the voice_join_ms phases, in the order the JSON lists
// them; they are the "phase" label values of owncord_voice_join_seconds and the
// suffix of the "voice_join_<phase>" values of owncord_latency_max_seconds.
var promVoicePhases = [...]string{"precheck", "leave", "persist", "token", "complete", "total"}

// handlePrometheusMetrics serves the Prometheus text exposition. Mount it
// behind the same AdminIPRestrict as the JSON endpoint.
func handlePrometheusMetrics(src MetricsSources) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m := collectMetrics(r.Context(), src)
		var counts ws.LatencyCounts
		if src.LatencyCounts != nil {
			counts = src.LatencyCounts()
		}
		body := encodePrometheus(&m, counts)
		w.Header().Set("Content-Type", metrics.PromContentType)
		w.WriteHeader(http.StatusOK)
		// A failed write means the scraper went away; there is nobody to tell.
		_, _ = w.Write(body)
	}
}

type promSample struct {
	label string
	value float64
}

type promEncoder struct{ t metrics.PromText }

func (e *promEncoder) scalar(name, typ, help string, v float64) {
	e.t.Family(name, typ, help)
	e.t.Sample(nil, v)
}

func (e *promEncoder) counters(name, help, labelName string, samples []promSample) {
	e.t.Family(name, metrics.PromCounter, help)
	for _, s := range samples {
		e.t.Sample([]metrics.PromLabel{{Name: labelName, Value: s.label}}, s.value)
	}
}

func boolGauge(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// encodePrometheus renders m, and the raw histogram counts, as text. A family
// whose source is absent (no LiveKit probe, no event persister, no disk
// reading, no histogram counts) is left out, as the JSON leaves the key out.
func encodePrometheus(m *ServerMetrics, counts ws.LatencyCounts) []byte {
	var e promEncoder
	const (
		counter = metrics.PromCounter
		gauge   = metrics.PromGauge
	)

	e.scalar("owncord_uptime_seconds", gauge, "Seconds since the server process started.", m.UptimeSeconds)
	e.scalar("owncord_goroutines", gauge, "Goroutines in the server process.", float64(m.GoRoutines))
	e.scalar("owncord_heap_alloc_bytes", gauge, "Bytes of allocated heap objects.", m.HeapAllocMB*1024*1024)
	e.scalar("owncord_heap_sys_bytes", gauge, "Bytes of heap memory obtained from the operating system.", m.HeapSysMB*1024*1024)
	e.scalar("owncord_gc_cycles_total", counter, "Completed garbage collection cycles.", float64(m.NumGC))
	e.scalar("owncord_connected_users", gauge, "Users with a live WebSocket connection.", float64(m.ConnectedUsers))
	e.scalar("owncord_voice_sessions", gauge, "Users currently in a voice channel.", float64(m.VoiceSessions))
	e.scalar("owncord_broadcast_drops_total", counter, "Messages dropped because the hub-wide broadcast queue was full. Any growth means sequenced events were lost before delivery.", float64(m.BroadcastDrops))
	e.scalar("owncord_topic_sheds_total", counter, "Channel frames dropped by the per-channel rate limit before a sequence number was assigned.", float64(m.TopicSheds))
	e.scalar("owncord_delivery_loss_marks_total", counter, "Connected clients told to resync because a sequenced frame meant for them was dropped or withheld.", float64(m.DeliveryLossMarks))
	e.scalar("owncord_ws_conn_rejects_total", counter, "WebSocket upgrades refused by the max_ws_connections cap.", float64(m.WSConnRejects))

	encodePromHistograms(&e, counts)
	encodePromLatencyMax(&e, m)

	e.scalar("owncord_hub_broadcast_queue_depth", gauge, "Frames waiting on the hub dispatch channel.", float64(m.BroadcastQueueDepth))
	e.counters("owncord_reconnect_tier_total", "Reconnects by the replay tier that served them.", "tier", []promSample{
		{"buffer", float64(m.ReconnectTierBuffer)},
		{"db", float64(m.ReconnectTierDB)},
		{"full", float64(m.ReconnectTierFull)},
	})
	e.scalar("owncord_reconnect_ring_misses_total", counter, "Resumes that passed the resync checks but fell behind the in-memory replay ring; the events table can serve only these.", float64(m.ReconnectRingMisses))
	e.counters("owncord_backpressure_total", "Per-client send-queue backpressure events by kind.", "kind", []promSample{
		{"queue_disconnect", float64(m.BackpressureQueueDisconnects)},
		{"high_fallback", float64(m.BackpressureHighFallbacks)},
		{"low_drop", float64(m.BackpressureLowDrops)},
		{"presence_drop", float64(m.BackpressurePresenceDrops)},
	})
	e.counters("owncord_db_wait_total", "Times a caller queued for a database connection, by pool.", "pool", []promSample{
		{"writer", float64(m.DBWriterWaitCount)},
		{"reader", float64(m.DBReaderWaitCount)},
	})
	e.counters("owncord_db_wait_seconds_total", "Seconds spent queueing for a database connection, by pool.", "pool", []promSample{
		{"writer", m.DBWriterWaitSeconds},
		{"reader", m.DBReaderWaitSeconds},
	})
	e.counters("owncord_perm_cache_lookups_total", "Permission cache lookups by result.", "result", []promSample{
		{"hit", float64(m.PermCacheHits)},
		{"miss", float64(m.PermCacheMisses)},
	})
	e.counters("owncord_push_total", "Web Push deliveries by result; zero while dispatch is off.", "result", []promSample{
		{"dispatched", float64(m.PushDispatched)},
		{"failed", float64(m.PushFailed)},
		{"pruned", float64(m.PushPruned)},
	})
	if ep := m.EventPersister; ep != nil {
		e.counters("owncord_event_persister_total", "Event persister activity by kind; present only when event persistence is on.", "kind", []promSample{
			{"persisted", float64(ep.Persisted)},
			{"dropped", float64(ep.Dropped)},
			{"flushes", float64(ep.Flushes)},
			{"errors", float64(ep.Errors)},
		})
	}
	if m.LiveKitHealthy != nil {
		e.scalar("owncord_livekit_healthy", gauge, "1 when the LiveKit server answered its health probe, else 0.", boolGauge(*m.LiveKitHealthy))
	}
	if m.DiskFreeMB != nil {
		e.scalar("owncord_disk_free_bytes", gauge, "Free bytes on the data volume.", *m.DiskFreeMB*1024*1024)
	}
	e.scalar("owncord_disk_min_free_bytes", gauge, "Reserved free-space floor (server.min_free_disk_mb), in bytes.", m.DiskMinFreeMB*1024*1024)
	if m.DiskLow != nil {
		e.scalar("owncord_disk_low", gauge, "1 when free disk space is below the reserved floor, else 0.", boolGauge(*m.DiskLow))
	}
	if m.UploadStorageUsedMB != nil {
		e.scalar("owncord_upload_storage_used_bytes", gauge, "Bytes of attachments stored, summed over every attachment row.", *m.UploadStorageUsedMB*1024*1024)
	}
	if m.DBWALMB != nil {
		e.scalar("owncord_db_wal_bytes", gauge, "Size of the SQLite write-ahead log file, in bytes.", *m.DBWALMB*1024*1024)
	}
	return e.t.Bytes()
}

// encodePromHistograms writes the latency histogram families from the raw
// counts. A histogram missing from counts is skipped.
func encodePromHistograms(e *promEncoder, counts ws.LatencyCounts) {
	for _, h := range []struct{ family, key, help string }{
		{"owncord_ws_broadcast_seconds", "ws_broadcast_ms", "Time from a frame being queued to its fan-out finishing."},
		{"owncord_ws_dispatch_lag_seconds", "ws_dispatch_lag_ms", "Time a frame waited for the dispatch goroutine."},
		{"owncord_chat_send_ack_seconds", "chat_send_ack_ms", "Time from a chat_send arriving to its acknowledgement being queued."},
	} {
		c, ok := counts[h.key]
		if !ok {
			continue
		}
		e.t.Family(h.family, metrics.PromHistogram, h.help)
		e.t.Histogram(nil, c)
	}

	headed := false
	for _, phase := range promVoicePhases {
		c, ok := counts["voice_join_ms."+phase]
		if !ok {
			continue
		}
		if !headed {
			e.t.Family("owncord_voice_join_seconds", metrics.PromHistogram, "Time spent in each phase of a completed voice join.")
			headed = true
		}
		e.t.Histogram([]metrics.PromLabel{{Name: "phase", Value: phase}}, c)
	}
}

// encodePromLatencyMax writes owncord_latency_max_seconds: the largest
// observation of each latency over the last minute, the last fifteen minutes
// and the process lifetime. A window the sampler cannot yet answer is absent
// from m.Windows and so from here, never a reassuring zero.
func encodePromLatencyMax(e *promEncoder, m *ServerMetrics) {
	type maxSample struct {
		metric, window string
		ms             float64
	}
	var out []maxSample
	add := func(window string, broadcast, dispatch, ack *metrics.Summary, voice *ws.VoiceJoinPhases, seqMuMs float64) {
		if broadcast != nil {
			out = append(out, maxSample{"ws_broadcast", window, broadcast.Max})
		}
		if dispatch != nil {
			out = append(out, maxSample{"ws_dispatch_lag", window, dispatch.Max})
		}
		if ack != nil {
			out = append(out, maxSample{"chat_send_ack", window, ack.Max})
		}
		if voice != nil {
			for i, s := range [...]metrics.Summary{voice.Precheck, voice.Leave, voice.Persist, voice.Token, voice.Complete, voice.Total} {
				out = append(out, maxSample{"voice_join_" + promVoicePhases[i], window, s.Max})
			}
		}
		out = append(out, maxSample{"hub_seqmu_hold", window, seqMuMs})
	}
	for _, win := range metricsWindows {
		if w := m.Windows[win.key]; w != nil {
			add(win.key, w.BroadcastMs, w.DispatchLagMs, w.ChatAckMs, w.VoiceJoinMs, w.SeqMuMaxHoldMs)
		}
	}
	add("lifetime", m.BroadcastMs, m.DispatchLagMs, m.ChatAckMs, m.VoiceJoinMs, m.SeqMuMaxHoldMs)

	e.t.Family("owncord_latency_max_seconds", metrics.PromGauge,
		"Largest single observation of each latency over the last minute (1m), fifteen minutes (15m) or the process lifetime. The one figure rate() and histogram_quantile() cannot derive.")
	for _, s := range out {
		e.t.Sample([]metrics.PromLabel{{Name: "metric", Value: s.metric}, {Name: "window", Value: s.window}}, s.ms/1000)
	}
}
