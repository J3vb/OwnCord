package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
)

// buildMetricsRouter creates a chi router with the metrics endpoint behind AdminIPRestrict.
func buildMetricsRouter(allowedCIDRs []string) http.Handler {
	r := chi.NewRouter()
	r.With(api.AdminIPRestrict(allowedCIDRs, nil)).
		Get("/api/v1/metrics", api.HandleMetricsForTest(
			func() int { return 5 },
			func() int { return 2 },
			func() (bool, error) { return true, nil },
		))
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
		"connected_users", "voice_sessions", "livekit_healthy",
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
	if resp["livekit_healthy"] != true {
		t.Errorf("livekit_healthy = %v, want true", resp["livekit_healthy"])
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
	r.Get("/api/v1/metrics", api.HandleMetricsForTest(
		func() int { return 0 },
		func() int { return 0 },
		nil, // no livekit
	))

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
}
