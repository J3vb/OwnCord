package api_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/ws"
)

func fullMetricsSources() api.MetricsSources {
	return api.MetricsSources{
		ConnectedUsers:      func() int { return 5 },
		VoiceSessions:       func() int { return 2 },
		BroadcastDrops:      func() uint64 { return 1 },
		TopicSheds:          func() uint64 { return 3 },
		BroadcastMs:         func() metrics.Summary { return metrics.Summary{Count: 10, P50: 2, P95: 5, P99: 10, Max: 20} },
		DispatchLagMs:       func() metrics.Summary { return metrics.Summary{Count: 4, P95: 50, Max: 90} },
		ChatAckMs:           func() metrics.Summary { return metrics.Summary{Count: 8, P95: 12, Max: 30} },
		VoiceJoinMs:         func() ws.VoiceJoinPhases { return ws.VoiceJoinPhases{Total: metrics.Summary{Count: 2}} },
		BroadcastQueueDepth: func() int { return 7 },
		SeqMuMaxHoldMs:      func() float64 { return 210 },
		LiveKitHealth:       func(context.Context) (bool, error) { return true, nil },
		ReconnectTiers:      func() (uint64, uint64, uint64) { return 7, 3, 1 },
		Backpressure:        func() (uint64, uint64, uint64) { return 4, 9, 11 },
		PresenceDrops:       func() uint64 { return 5 },
		LossMarks:           func() uint64 { return 6 },
		ConnRejects:         func() uint64 { return 8 },
		PersisterStats:      func() (uint64, uint64, uint64, uint64, bool) { return 100, 2, 10, 1, true },
		DBStats:             func() sql.DBStats { return sql.DBStats{WaitCount: 6, WaitDuration: 1500 * time.Millisecond} },
		DBReaderStats:       func() sql.DBStats { return sql.DBStats{WaitCount: 3, WaitDuration: 700 * time.Millisecond} },
		PermCache:           func() (uint64, uint64) { return 42, 8 },
		DiskFree:            func() (uint64, error) { return 5 << 30, nil },
		DiskMinFree:         1 << 30,
		UploadBytes:         func(context.Context) (int64, error) { return 3 << 20, nil },
		PushCounters:        func() (uint64, uint64, uint64) { return 1, 2, 3 },
	}
}

func getMetrics(t *testing.T, src api.MetricsSources) map[string]any {
	t.Helper()
	rr := httptest.NewRecorder()
	api.HandleMetricsForTest(src).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp
}

// windowFixture is a fake sampler answering both windows, 1m shorter than 15m.
func windowFixture(d time.Duration) (metrics.WindowSnapshot, bool) {
	asOf := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	scale := uint64(d / time.Minute)
	return metrics.WindowSnapshot{
		Seconds: d.Seconds(),
		AsOf:    asOf,
		Histograms: map[string]metrics.Summary{
			"ws_broadcast_ms":        {Count: 52 * scale, P50: 1, P95: 5, P99: 20, Max: 18.4},
			"ws_dispatch_lag_ms":     {Count: 4},
			"chat_send_ack_ms":       {Count: 8},
			"voice_join_ms.precheck": {Count: 1},
			"voice_join_ms.leave":    {Count: 1},
			"voice_join_ms.persist":  {Count: 1},
			"voice_join_ms.token":    {Count: 1},
			"voice_join_ms.complete": {Count: 1},
			"voice_join_ms.total":    {Count: 1, P95: 50},
		},
		MaxGauges: map[string]float64{"hub_seqmu_max_hold_ms": 3.1},
		Counters: map[string]uint64{
			"broadcast_drops":                scale,
			"topic_sheds_total":              2,
			"reconnect_tier_buffer":          2,
			"db_writer_wait_count":           4,
			"db_writer_wait_nanos":           2_500_000_000,
			"db_reader_wait_nanos":           500_000_000,
			"backpressure_presence_drops":    9,
			"backpressure_queue_disconnects": 1,
		},
	}, true
}

func TestHandleMetrics_WindowsBlock(t *testing.T) {
	src := fullMetricsSources()
	src.Windows = windowFixture
	resp := getMetrics(t, src)

	wins, ok := resp["windows"].(map[string]any)
	if !ok || len(wins) != 2 {
		t.Fatalf("windows = %v, want the 1m and 15m keys", resp["windows"])
	}
	w1, ok1 := wins["1m"].(map[string]any)
	w15, ok15 := wins["15m"].(map[string]any)
	if !ok1 || !ok15 {
		t.Fatalf("windows keys = %v, want 1m and 15m", wins)
	}
	if w1["seconds"] != 60.0 || w15["seconds"] != 900.0 {
		t.Errorf("seconds = %v/%v, want 60/900", w1["seconds"], w15["seconds"])
	}
	if w1["as_of"] != "2026-10-17T12:00:00Z" {
		t.Errorf("as_of = %v", w1["as_of"])
	}
	if bm := w1["ws_broadcast_ms"].(map[string]any); bm["count"] != 52.0 || bm["max"] != 18.4 {
		t.Errorf("1m ws_broadcast_ms = %v", bm)
	}
	if bm := w15["ws_broadcast_ms"].(map[string]any); bm["count"] != 780.0 {
		t.Errorf("15m ws_broadcast_ms count = %v, want 780", bm["count"])
	}
	if w1["hub_seqmu_max_hold_ms"] != 3.1 {
		t.Errorf("hub_seqmu_max_hold_ms = %v", w1["hub_seqmu_max_hold_ms"])
	}
	if w1["db_writer_wait_seconds"] != 2.5 || w1["db_reader_wait_seconds"] != 0.5 || w1["db_writer_wait_count"] != 4.0 {
		t.Errorf("db wait = %v/%v/%v, want 2.5/0.5/4", w1["db_writer_wait_seconds"], w1["db_reader_wait_seconds"], w1["db_writer_wait_count"])
	}
	vj := w1["voice_join_ms"].(map[string]any)
	if len(vj) != 6 || vj["total"].(map[string]any)["p95"] != 50.0 {
		t.Errorf("voice_join_ms = %v, want six phases", vj)
	}

	// The window block repeats top-level key names: each of its keys, apart
	// from the window's own seconds and as_of, is a top-level key too.
	for k := range w1 {
		if k == "seconds" || k == "as_of" {
			continue
		}
		if _, ok := resp[k]; !ok {
			t.Errorf("window key %q has no top-level counterpart", k)
		}
	}
}

func TestHandleMetrics_WindowsOmittedWithoutSource(t *testing.T) {
	if _, ok := getMetrics(t, fullMetricsSources())["windows"]; ok {
		t.Fatal("windows present with no windowed source")
	}
	// A source that is not ready (fewer than two samples) leaves it out too.
	src := fullMetricsSources()
	src.Windows = func(time.Duration) (metrics.WindowSnapshot, bool) { return metrics.WindowSnapshot{}, false }
	if _, ok := getMetrics(t, src)["windows"]; ok {
		t.Fatal("windows present before the sampler has two samples")
	}
	// A young process: only the windows that can answer appear.
	src.Windows = func(d time.Duration) (metrics.WindowSnapshot, bool) {
		if d > time.Minute {
			return metrics.WindowSnapshot{}, false
		}
		return windowFixture(d)
	}
	wins := getMetrics(t, src)["windows"].(map[string]any)
	if _, ok := wins["15m"]; ok || wins["1m"] == nil {
		t.Fatalf("windows = %v, want only 1m", wins)
	}
}

// TestHandleMetrics_LegacyKeysUnchanged pins every existing top-level key and
// its JSON type, including each one the k6 observer (scripts/k6/ws-load.js)
// reads, and proves that adding the windows block changes none of them.
func TestHandleMetrics_LegacyKeysUnchanged(t *testing.T) {
	const (
		num     = "number"
		str     = "string"
		obj     = "object"
		boolean = "bool"
	)
	golden := map[string]string{
		"uptime": str, "uptime_seconds": num, "goroutines": num, "heap_alloc_mb": num,
		"heap_sys_mb": num, "num_gc": num, "connected_users": num, "voice_sessions": num,
		"broadcast_drops": num, "topic_sheds_total": num, "livekit_healthy": boolean,
		"ws_broadcast_ms": obj, "ws_dispatch_lag_ms": obj, "chat_send_ack_ms": obj, "voice_join_ms": obj,
		"hub_broadcast_queue_depth": num, "hub_seqmu_max_hold_ms": num,
		"reconnect_tier_buffer": num, "reconnect_tier_db": num, "reconnect_tier_full": num,
		"backpressure_queue_disconnects": num, "backpressure_high_fallbacks": num,
		"backpressure_low_drops": num, "backpressure_presence_drops": num,
		"delivery_loss_marks": num, "ws_conn_rejects": num,
		"disk_free_mb": num, "disk_min_free_mb": num, "disk_low": boolean,
		"upload_storage_used_mb": num,
		"db_writer_wait_count":   num, "db_writer_wait_seconds": num,
		"db_reader_wait_count": num, "db_reader_wait_seconds": num,
		"perm_cache_hits": num, "perm_cache_misses": num,
		"push_dispatched": num, "push_failed": num, "push_pruned": num,
		"event_persister": obj,
	}
	typeOf := func(v any) string {
		switch v.(type) {
		case float64:
			return num
		case string:
			return str
		case bool:
			return boolean
		case map[string]any:
			return obj
		}
		return reflect.TypeOf(v).String()
	}

	without := getMetrics(t, fullMetricsSources())
	src := fullMetricsSources()
	src.Windows = windowFixture
	with := getMetrics(t, src)

	for name, resp := range map[string]map[string]any{"without windows": without, "with windows": with} {
		for key, want := range golden {
			v, ok := resp[key]
			if !ok {
				t.Errorf("%s: key %q missing", name, key)
				continue
			}
			if got := typeOf(v); got != want {
				t.Errorf("%s: key %q is %s, want %s", name, key, got, want)
			}
		}
		for key := range resp {
			if _, ok := golden[key]; !ok && key != "windows" {
				t.Errorf("%s: unexpected new top-level key %q", name, key)
			}
		}
	}
	// Same values either way (uptime and heap vary with the clock and the GC).
	volatile := map[string]bool{"uptime": true, "uptime_seconds": true, "goroutines": true,
		"heap_alloc_mb": true, "heap_sys_mb": true, "num_gc": true, "windows": true}
	for key, v := range without {
		if volatile[key] {
			continue
		}
		if !reflect.DeepEqual(v, with[key]) {
			t.Errorf("key %q changed with the windows block: %v vs %v", key, v, with[key])
		}
	}
}

// A snapshot missing a voice phase leaves voice_join_ms out instead of
// panicking on a nil dereference.
func TestHandleMetrics_WindowsWithoutAllVoicePhases(t *testing.T) {
	src := fullMetricsSources()
	src.Windows = func(d time.Duration) (metrics.WindowSnapshot, bool) {
		s, _ := windowFixture(d)
		delete(s.Histograms, "voice_join_ms.leave")
		return s, true
	}
	w := getMetrics(t, src)["windows"].(map[string]any)["1m"].(map[string]any)
	if _, ok := w["voice_join_ms"]; ok {
		t.Fatalf("voice_join_ms present with a phase missing: %v", w["voice_join_ms"])
	}
	if _, ok := w["ws_broadcast_ms"]; !ok {
		t.Fatal("the rest of the window should still be reported")
	}
}
