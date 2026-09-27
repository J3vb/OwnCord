package api_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

// buildMetricsRouter creates a chi router with the metrics endpoint behind AdminIPRestrict.
func buildMetricsRouter(allowedCIDRs []string) http.Handler {
	r := chi.NewRouter()
	r.With(api.AdminIPRestrict("server.metrics_allowed_cidrs", allowedCIDRs, nil)).
		Get("/api/v1/metrics", api.HandleMetricsForTest(api.MetricsSources{
			ConnectedUsers: func() int { return 5 },
			VoiceSessions:  func() int { return 2 },
			BroadcastDrops: func() uint64 { return 0 },
			TopicSheds:     func() uint64 { return 3 },
			BroadcastMs: func() metrics.Summary {
				return metrics.Summary{Count: 10, P50: 2, P95: 5, P99: 10, Max: 20}
			},
			DispatchLagMs: func() metrics.Summary { return metrics.Summary{Count: 4, P95: 50, Max: 90} },
			ChatAckMs:     func() metrics.Summary { return metrics.Summary{Count: 8, P95: 12, Max: 30} },
			VoiceJoinMs: func() ws.VoiceJoinPhases {
				return ws.VoiceJoinPhases{Token: metrics.Summary{Count: 2, P95: 20}, Total: metrics.Summary{Count: 2, P95: 50}}
			},
			BroadcastQueueDepth: func() int { return 7 },
			SeqMuMaxHoldMs:      func() float64 { return 210 },
			LiveKitHealth:       func(_ context.Context) (bool, error) { return true, nil },
			ReconnectTiers:      func() (uint64, uint64, uint64) { return 7, 3, 1 },
			Backpressure:        func() (uint64, uint64, uint64) { return 4, 9, 11 },
			PersisterStats:      func() (uint64, uint64, uint64, uint64, bool) { return 100, 2, 10, 1, true },
			DBStats:             func() sql.DBStats { return sql.DBStats{WaitCount: 6, WaitDuration: 1500 * time.Millisecond} },
			DBReaderStats:       func() sql.DBStats { return sql.DBStats{WaitCount: 3, WaitDuration: 700 * time.Millisecond} },
			PermCache:           func() (uint64, uint64) { return 42, 8 },
		}))
	return r
}

func TestHandleMetrics_ReturnsExpectedFields(t *testing.T) {
	router := buildMetricsRouter(nil) // no IP restriction

	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	requiredFields := []string{
		"uptime", "uptime_seconds", "goroutines",
		"heap_alloc_mb", "heap_sys_mb", "num_gc",
		"connected_users", "voice_sessions", "broadcast_drops", "topic_sheds_total",
		"ws_broadcast_ms", "ws_dispatch_lag_ms", "chat_send_ack_ms", "voice_join_ms",
		"hub_broadcast_queue_depth", "hub_seqmu_max_hold_ms", "livekit_healthy",
		"reconnect_tier_buffer", "reconnect_tier_db", "reconnect_tier_full",
		"backpressure_queue_disconnects", "backpressure_high_fallbacks", "backpressure_low_drops",
		"db_writer_wait_count", "db_writer_wait_seconds",
		"db_reader_wait_count", "db_reader_wait_seconds",
		"perm_cache_hits", "perm_cache_misses",
		"event_persister",
	}
	for _, f := range requiredFields {
		if _, ok := resp[f]; !ok {
			t.Errorf("missing field %q in metrics response", f)
		}
	}

	// Verify the callback values are reflected.
	if int(resp["connected_users"].(float64)) != 5 {
		t.Errorf("connected_users = %v, want 5", resp["connected_users"])
	}
	if int(resp["voice_sessions"].(float64)) != 2 {
		t.Errorf("voice_sessions = %v, want 2", resp["voice_sessions"])
	}
	if int(resp["topic_sheds_total"].(float64)) != 3 {
		t.Errorf("topic_sheds_total = %v, want 3", resp["topic_sheds_total"])
	}
	if int(resp["hub_broadcast_queue_depth"].(float64)) != 7 {
		t.Errorf("hub_broadcast_queue_depth = %v, want 7", resp["hub_broadcast_queue_depth"])
	}
	if got := resp["hub_seqmu_max_hold_ms"].(float64); got != 210 {
		t.Errorf("hub_seqmu_max_hold_ms = %v, want 210", got)
	}
	bm, ok := resp["ws_broadcast_ms"].(map[string]any)
	if !ok {
		t.Fatalf("ws_broadcast_ms = %v, want object", resp["ws_broadcast_ms"])
	}
	if int(bm["p95"].(float64)) != 5 || int(bm["count"].(float64)) != 10 {
		t.Errorf("ws_broadcast_ms p95/count = %v/%v, want 5/10", bm["p95"], bm["count"])
	}
	if ack, ok := resp["chat_send_ack_ms"].(map[string]any); !ok || int(ack["p95"].(float64)) != 12 {
		t.Errorf("chat_send_ack_ms = %v, want p95 12", resp["chat_send_ack_ms"])
	}
	vj, ok := resp["voice_join_ms"].(map[string]any)
	if !ok {
		t.Fatalf("voice_join_ms = %v, want object", resp["voice_join_ms"])
	}
	for _, phase := range []string{"precheck", "leave", "persist", "token", "complete", "total"} {
		if _, ok := vj[phase].(map[string]any); !ok {
			t.Errorf("voice_join_ms.%s = %v, want object", phase, vj[phase])
		}
	}
	if total := vj["total"].(map[string]any); int(total["p95"].(float64)) != 50 || int(total["count"].(float64)) != 2 {
		t.Errorf("voice_join_ms.total p95/count = %v/%v, want 50/2", total["p95"], total["count"])
	}
	if resp["livekit_healthy"] != true {
		t.Errorf("livekit_healthy = %v, want true", resp["livekit_healthy"])
	}
	if int(resp["reconnect_tier_buffer"].(float64)) != 7 {
		t.Errorf("reconnect_tier_buffer = %v, want 7", resp["reconnect_tier_buffer"])
	}
	if int(resp["backpressure_low_drops"].(float64)) != 11 {
		t.Errorf("backpressure_low_drops = %v, want 11", resp["backpressure_low_drops"])
	}
	if got := resp["db_writer_wait_seconds"].(float64); got != 1.5 {
		t.Errorf("db_writer_wait_seconds = %v, want 1.5", got)
	}
	if got := resp["db_reader_wait_seconds"].(float64); got != 0.7 {
		t.Errorf("db_reader_wait_seconds = %v, want 0.7", got)
	}
	if int(resp["perm_cache_hits"].(float64)) != 42 {
		t.Errorf("perm_cache_hits = %v, want 42", resp["perm_cache_hits"])
	}
	ep, ok := resp["event_persister"].(map[string]any)
	if !ok {
		t.Fatalf("event_persister = %v, want object", resp["event_persister"])
	}
	if int(ep["persisted"].(float64)) != 100 {
		t.Errorf("event_persister.persisted = %v, want 100", ep["persisted"])
	}
}

func TestHandleMetrics_AdminIPRestrict_BlocksNonAdmin(t *testing.T) {
	router := buildMetricsRouter([]string{"10.0.0.0/8"}) // only 10.x allowed

	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.RemoteAddr = "192.168.1.1:9999" // not in allowed CIDR
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body: %s", rr.Code, rr.Body.String())
	}
}

func TestHandleMetrics_AdminIPRestrict_AllowsAdmin(t *testing.T) {
	router := buildMetricsRouter([]string{"127.0.0.0/8"})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

func TestHandleMetrics_WithoutLiveKitHealthCheck(t *testing.T) {
	r := chi.NewRouter()
	r.Get("/api/v1/metrics", api.HandleMetricsForTest(api.MetricsSources{
		ConnectedUsers: func() int { return 0 },
		VoiceSessions:  func() int { return 0 },
		BroadcastDrops: func() uint64 { return 0 },
		// LiveKitHealth nil — no livekit wired.
		// PersisterStats returning ok=false must omit event_persister.
		PersisterStats: func() (uint64, uint64, uint64, uint64, bool) { return 0, 0, 0, 0, false },
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)

	// livekit_healthy should be absent when no health check is provided.
	if _, ok := resp["livekit_healthy"]; ok {
		t.Errorf("livekit_healthy should be omitted when health check is nil, got %v", resp["livekit_healthy"])
	}
	// event_persister should be absent when the persister reports ok=false.
	if _, ok := resp["event_persister"]; ok {
		t.Errorf("event_persister should be omitted when persistence is disabled, got %v", resp["event_persister"])
	}
}

// TestHandleMetrics_PushCounters proves the three push_* fields (B5-11,
// behind HP-5) surface real values when a PushCounters source is wired, and
// stay at zero — never absent, they are plain uint64s — when it is nil, the
// state of a server with dispatch off (the compiled default).
func TestHandleMetrics_PushCounters(t *testing.T) {
	r := chi.NewRouter()
	r.Get("/api/v1/metrics", api.HandleMetricsForTest(api.MetricsSources{
		PushCounters: func() (uint64, uint64, uint64) { return 7, 2, 1 },
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["push_dispatched"] != float64(7) || resp["push_failed"] != float64(2) || resp["push_pruned"] != float64(1) {
		t.Errorf("push counters = %v/%v/%v, want 7/2/1", resp["push_dispatched"], resp["push_failed"], resp["push_pruned"])
	}

	// Dispatch off: PushCounters nil, the three fields stay at zero.
	r2 := chi.NewRouter()
	r2.Get("/api/v1/metrics", api.HandleMetricsForTest(api.MetricsSources{}))
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req2.RemoteAddr = "127.0.0.1:9999"
	rr2 := httptest.NewRecorder()
	r2.ServeHTTP(rr2, req2)
	var resp2 map[string]any
	if err := json.NewDecoder(rr2.Body).Decode(&resp2); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp2["push_dispatched"] != float64(0) || resp2["push_failed"] != float64(0) || resp2["push_pruned"] != float64(0) {
		t.Errorf("push counters with no source = %v/%v/%v, want 0/0/0", resp2["push_dispatched"], resp2["push_failed"], resp2["push_pruned"])
	}
}
