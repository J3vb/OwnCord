package telemetry_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/telemetry"
)

// The no-op provider is what runs in every build without -tags otel — i.e. the
// default binary and all of CI. Its methods had no coverage, so nothing caught
// a nil-pointer or panic on the path every instrumented call takes in the
// shipped build.

func TestNoopProvider_TracerAndSpanAreInert(t *testing.T) {
	tracer := telemetry.GlobalTracer("test")
	if tracer == nil {
		t.Fatal("GlobalTracer returned nil")
	}

	ctx, span := tracer.Start(context.Background(), "op",
		telemetry.String("s", "v"),
		telemetry.Int64("i", 7),
		telemetry.Float64("f", 1.5),
	)
	if ctx == nil {
		t.Fatal("Start returned a nil context")
	}
	if span == nil {
		t.Fatal("Start returned a nil span")
	}

	// Every span method must be safe to call on the no-op implementation;
	// service code calls these unconditionally.
	span.SetAttributes(telemetry.String("k", "v"))
	span.RecordError(errors.New("boom"))
	span.End()
}

func TestNoopProvider_MeterInstrumentsAreInert(t *testing.T) {
	meter := telemetry.GlobalMeter("test")
	if meter == nil {
		t.Fatal("GlobalMeter returned nil")
	}
	ctx := context.Background()

	counter := meter.Counter("c", "count of things")
	if counter == nil {
		t.Fatal("Counter returned nil")
	}
	counter.Add(ctx, 1, telemetry.String("k", "v"))

	hist := meter.Histogram("h", "s", "durations")
	if hist == nil {
		t.Fatal("Histogram returned nil")
	}
	hist.Record(ctx, 0.25, telemetry.String("k", "v"))

	gauge := meter.Gauge("g", "a level")
	if gauge == nil {
		t.Fatal("Gauge returned nil")
	}
	gauge.Set(ctx, 3, telemetry.String("k", "v"))
}

func TestAttrConstructors(t *testing.T) {
	tests := []struct {
		name string
		got  telemetry.Attr
		key  string
		val  any
	}{
		{"String", telemetry.String("s", "v"), "s", "v"},
		{"Int64", telemetry.Int64("i", 7), "i", int64(7)},
		{"Float64", telemetry.Float64("f", 1.5), "f", 1.5},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.got.Key != tt.key {
				t.Errorf("Key = %q, want %q", tt.got.Key, tt.key)
			}
			if tt.got.Value != tt.val {
				t.Errorf("Value = %#v, want %#v", tt.got.Value, tt.val)
			}
		})
	}
}

func TestTimeSince(t *testing.T) {
	// TimeSince is called from deferred blocks all over the service layer with
	// whatever the metrics struct holds — including nil in the no-op build.
	telemetry.TimeSince(context.Background(), nil, time.Now())

	hist := telemetry.GlobalMeter("test").Histogram("h", "s", "d")
	telemetry.TimeSince(context.Background(), hist, time.Now().Add(-time.Second),
		telemetry.String("method", "Test"))
}

func TestNoopProvider_HTTPMiddlewareIsPassThrough(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusTeapot)
	})

	wrapped := telemetry.Global().HTTPMiddleware(next)
	rr := httptest.NewRecorder()
	wrapped.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

	if !called {
		t.Error("the wrapped handler was not invoked")
	}
	if rr.Code != http.StatusTeapot {
		t.Errorf("status = %d, want the inner handler's 418", rr.Code)
	}
}

func TestNewAppMetrics_InstrumentsAreUsable(t *testing.T) {
	m := telemetry.NewAppMetrics()
	if m == nil {
		t.Fatal("NewAppMetrics returned nil")
	}
	// ServiceCallDurationSec is passed straight into TimeSince by the service
	// layer, so it must never be nil.
	if m.ServiceCallDurationSec == nil {
		t.Error("ServiceCallDurationSec is nil")
	}
	telemetry.TimeSince(context.Background(), m.ServiceCallDurationSec, time.Now())
}
