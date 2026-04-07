//go:build otel

// Phase B Step 8 — tests for the real OpenTelemetry provider. Only compiled
// under `-tags otel`, alongside telemetry_otel.go. These tests exercise the
// behavioural contract the no-op build cannot: that Init actually wires a
// Prometheus exporter, that spans created via the adapter reach the SDK, and
// that Shutdown flushes cleanly.
package telemetry

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/owncord/server/config"
)

func TestOtelInitPrometheusExporter(t *testing.T) {
	resetGlobalForTest(t)
	shutdown, err := Init(context.Background(), config.TelemetryConfig{
		Enabled:     true,
		Exporter:    "prometheus",
		ServiceName: "owncord-test",
	})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	t.Cleanup(func() { _ = shutdown(context.Background()) })

	p := Global()
	if p == nil {
		t.Fatal("Global is nil after Init")
	}
	handler := p.PrometheusHandler()
	if handler == nil {
		t.Fatal("PrometheusHandler is nil after prometheus Init")
	}

	// Record one metric and scrape the exporter; the metric must appear in
	// the /metrics response body.
	ctx := context.Background()
	meter := p.Meter("telemetry_test")
	counter := meter.Counter("otel_test_counter_total", "test counter")
	counter.Add(ctx, 3, String("fixture", "init"))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	body := rec.Body.String()
	if rec.Code != http.StatusOK {
		t.Fatalf("prometheus handler status: got %d, body=%s", rec.Code, body)
	}
	if !strings.Contains(body, "otel_test_counter_total") {
		t.Fatalf("expected otel_test_counter_total in exporter body:\n%s", body)
	}
}

func TestOtelInitNoneReturnsNoopProvider(t *testing.T) {
	resetGlobalForTest(t)
	shutdown, err := Init(context.Background(), config.TelemetryConfig{
		Enabled:  true,
		Exporter: "none",
	})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	t.Cleanup(func() { _ = shutdown(context.Background()) })
	if _, ok := Global().(noopProvider); !ok {
		t.Fatalf("expected noopProvider, got %T", Global())
	}
}

func TestOtelInitDisabledReturnsNoopProvider(t *testing.T) {
	resetGlobalForTest(t)
	shutdown, err := Init(context.Background(), config.TelemetryConfig{Enabled: false})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	t.Cleanup(func() { _ = shutdown(context.Background()) })
	if _, ok := Global().(noopProvider); !ok {
		t.Fatalf("expected noopProvider, got %T", Global())
	}
}

func TestOtelTracerRecordsSpan(t *testing.T) {
	resetGlobalForTest(t)
	shutdown, err := Init(context.Background(), config.TelemetryConfig{
		Enabled:     true,
		Exporter:    "prometheus",
		ServiceName: "owncord-test",
	})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	t.Cleanup(func() { _ = shutdown(context.Background()) })

	tracer := Global().Tracer("telemetry_test")
	ctx, span := tracer.Start(context.Background(), "unit_test",
		String("attr_string", "v"),
		Int64("attr_int", 42),
		Float64("attr_float", 1.5),
	)
	span.SetAttributes(String("late", "ok"))
	span.RecordError(errors.New("boom"))
	span.End()
	_ = ctx
}

func TestOtelHistogramRecordsSeconds(t *testing.T) {
	resetGlobalForTest(t)
	shutdown, err := Init(context.Background(), config.TelemetryConfig{
		Enabled:     true,
		Exporter:    "prometheus",
		ServiceName: "owncord-test",
	})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	t.Cleanup(func() { _ = shutdown(context.Background()) })

	h := Global().Meter("telemetry_test").Histogram("otel_test_latency_seconds", "test", "s")
	TimeSince(context.Background(), h, time.Now().Add(-250*time.Millisecond))
}

func TestOtelShutdownIdempotent(t *testing.T) {
	resetGlobalForTest(t)
	shutdown, err := Init(context.Background(), config.TelemetryConfig{
		Enabled:     true,
		Exporter:    "prometheus",
		ServiceName: "owncord-test",
	})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("first shutdown: %v", err)
	}
	// Second call must not panic or error.
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("second shutdown: %v", err)
	}
}

// resetGlobalForTest restores a fresh no-op provider between tests that each
// call Init. We cannot cleanly tear down and re-register the otel globals in
// all cases, so tests that run back-to-back must start from the no-op state.
func resetGlobalForTest(t *testing.T) {
	t.Helper()
	SetGlobal(noopProvider{})
	resetAppMetricsForInit()
}

func TestOtelConvertAttrsUint64OverflowFallsBackToString(t *testing.T) {
	const tooBig = uint64(1<<63) + 7 // > math.MaxInt64
	attrs := convertAttrs([]Attr{{Key: "huge", Value: tooBig}})
	if len(attrs) != 1 {
		t.Fatalf("expected 1 attr, got %d", len(attrs))
	}
	if got := attrs[0].Value.Type().String(); got != "STRING" {
		t.Fatalf("overflowing uint64 should become STRING attr to avoid wrap, got %s", got)
	}
}

func TestOtelConvertAttrsHandlesUnsignedInts(t *testing.T) {
	attrs := convertAttrs([]Attr{
		{Key: "u64", Value: uint64(1 << 40)},
		{Key: "u32", Value: uint32(7)},
		{Key: "u", Value: uint(42)},
		{Key: "i", Value: int(-1)},
		{Key: "i64", Value: int64(-1 << 40)},
		{Key: "f32", Value: float32(2.5)},
		{Key: "b", Value: true},
		{Key: "s", Value: "hello"},
	})
	if len(attrs) != 8 {
		t.Fatalf("expected 8 attrs, got %d", len(attrs))
	}
	// uint64 must become an Int64 attribute, not a string.
	if got := attrs[0].Value.Type().String(); got != "INT64" {
		t.Fatalf("u64 attr type = %s, want INT64", got)
	}
	if got := attrs[0].Value.AsInt64(); got != int64(1<<40) {
		t.Fatalf("u64 attr value = %d, want %d", got, int64(1<<40))
	}
}

func TestOtelAppMetricsRebindsAfterInit(t *testing.T) {
	resetGlobalForTest(t)
	// Build once against the noop global; verify the bundle is the no-op
	// counter type, then swap providers and verify NewAppMetrics returns a
	// re-bound bundle.
	before := NewAppMetrics()
	if _, ok := before.WSMessagesTotal.(noopCounter); !ok {
		t.Fatalf("expected noopCounter before Init, got %T", before.WSMessagesTotal)
	}

	shutdown, err := Init(context.Background(), config.TelemetryConfig{
		Enabled:     true,
		Exporter:    "prometheus",
		ServiceName: "owncord-test",
	})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	t.Cleanup(func() { _ = shutdown(context.Background()) })

	after := NewAppMetrics()
	if _, ok := after.WSMessagesTotal.(noopCounter); ok {
		t.Fatalf("WSMessagesTotal is still a noopCounter after OTel Init — AppMetrics cache was not reset")
	}
}
