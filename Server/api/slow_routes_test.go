package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/metrics"
)

// The request logger records each request under its full route pattern, a
// mounted sub-router included, so ids never reach the card. Routes the request
// deadline exempts (a stream held open for minutes, the WebSocket) and paths
// no route matched are left out, so they cannot crowd out real slowness.
func TestRequestLogger_FeedsSlowRoutes(t *testing.T) {
	slow := metrics.NewSlowRoutes(time.Now)
	r := chi.NewRouter()
	r.Use(requestLogger(nil, slow))
	r.Get("/api/v1/channels/{id}/messages", func(http.ResponseWriter, *http.Request) {})
	r.Get("/api/v1/ws", func(http.ResponseWriter, *http.Request) { time.Sleep(20 * time.Millisecond) })
	sub := chi.NewRouter()
	sub.Get("/system/stats", func(http.ResponseWriter, *http.Request) {})
	sub.Get("/logs/stream", func(http.ResponseWriter, *http.Request) { time.Sleep(20 * time.Millisecond) })
	r.Mount("/admin/api", sub)

	for _, p := range []string{
		"/api/v1/channels/123/messages",
		"/api/v1/channels/456/messages",
		"/admin/api/system/stats",
		"/admin/api/logs/stream",
		"/api/v1/ws",
		"/api/v1/nope",
	} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, p, nil))
	}

	got := map[string]uint64{}
	for _, row := range slow.Slowest(10) {
		got[row.Method+" "+row.Route] = row.Count
	}
	want := map[string]uint64{
		"GET /api/v1/channels/{id}/messages": 2,
		"GET /admin/api/system/stats":        1,
	}
	if len(got) != len(want) {
		t.Fatalf("rows = %v, want %v", got, want)
	}
	for k, n := range want {
		if got[k] != n {
			t.Errorf("%s count = %d, want %d (rows %v)", k, got[k], n, got)
		}
	}
}
