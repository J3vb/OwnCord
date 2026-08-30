//go:build otel

package api

// OC-0346: the recovered-panic log record must carry the request's trace_id.
// Only the otel build can produce one (telemetry_default.go's
// TraceIDFromContext is hard-wired to ""), so this file is tagged and CI's
// untagged test run does not see it. Run it with
//
//	go test -tags otel -count=1 -run TestRecoverer_PanicLogCarriesTraceID ./api/

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// TestRecoverer_PanicLogCarriesTraceID drives a panicking handler through the
// real routerMiddleware stack with tracing on and asserts the panic record
// carries the span's trace id. Before the fix recoverer was mounted ahead of
// telemetry.HTTPMiddleware, so it captured the trace id from a context that
// had no span yet and the attribute was always dropped.
func TestRecoverer_PanicLogCarriesTraceID(t *testing.T) {
	shutdown, err := telemetry.Init(context.Background(), config.TelemetryConfig{
		Enabled:     true,
		Exporter:    "prometheus", // a real tracer provider, no network exporter
		ServiceName: "recoverer-test",
	})
	if err != nil {
		t.Fatalf("telemetry.Init: %v", err)
	}
	t.Cleanup(func() { _ = shutdown(context.Background()) })

	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	r := chi.NewRouter()
	routerMiddleware(r, &config.Config{})
	r.Get("/boom", func(http.ResponseWriter, *http.Request) { panic("boom") })

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/boom", nil))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (panic not recovered)", rr.Code)
	}

	var rec map[string]any
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) == nil && m["msg"] == "http handler panic recovered" {
			rec = m
			break
		}
	}
	if rec == nil {
		t.Fatalf("no recovered-panic record in logs:\n%s", logs.String())
	}
	traceID, _ := rec["trace_id"].(string)
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(traceID) {
		t.Fatalf("panic record trace_id = %q, want the span's 32-hex trace id; record = %v", traceID, rec)
	}
}
