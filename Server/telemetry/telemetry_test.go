// Phase B Step 8 — telemetry default-build smoke test.
//
// In the default build (no -tags otel) the package installs a no-op provider
// that satisfies every API surface. The test confirms Init returns a non-nil
// shutdown closer, the Global() helper returns a usable provider, and that a
// pass-through HTTP middleware leaves the wrapped handler intact.
package telemetry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

func TestInitNoOpReturnsShutdown(t *testing.T) {
	shutdown, err := Init(context.Background(), config.TelemetryConfig{Enabled: false})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if shutdown == nil {
		t.Fatal("expected non-nil shutdown")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}

func TestGlobalReturnsUsableProvider(t *testing.T) {
	p := Global()
	if p == nil {
		t.Fatal("Global returned nil")
	}
	tracer := p.Tracer("test")
	_, span := tracer.Start(context.Background(), "noop")
	span.SetAttributes(String("k", "v"))
	span.End()
	meter := p.Meter("test")
	meter.Counter("c", "").Add(context.Background(), 1)
	meter.Histogram("h", "", "s").Record(context.Background(), 1.0)
	meter.Gauge("g", "").Set(context.Background(), 0.5)
}

func TestHTTPMiddlewareIsPassThrough(t *testing.T) {
	called := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusTeapot)
	})
	wrapped := HTTPMiddleware()(handler)
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if !called {
		t.Fatal("inner handler not called")
	}
	if rec.Code != http.StatusTeapot {
		t.Fatalf("status: got %d want %d", rec.Code, http.StatusTeapot)
	}
}

func TestPrometheusHandlerNilByDefault(t *testing.T) {
	if PrometheusHandler() != nil {
		t.Fatal("expected nil Prometheus handler in no-op build")
	}
}
