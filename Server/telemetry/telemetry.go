// Package telemetry wires the OpenTelemetry SDK for OwnCord.
//
// Phase B Step 8 — Add OpenTelemetry for Observability.
//
// This file provides the public API surface and a no-op default implementation
// that compiles without any external dependencies. The real OpenTelemetry
// providers live in telemetry_otel.go behind the `otel` build tag, so the
// default build (`go build ./...`) ships a stub that satisfies every call site
// at zero binary cost. To enable real OTel:
//
//	go get go.opentelemetry.io/otel \
//	       go.opentelemetry.io/otel/sdk \
//	       go.opentelemetry.io/otel/exporters/prometheus \
//	       go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc \
//	       go.opentelemetry.io/contrib/instrumentation/github.com/go-chi/chi/otelchi
//	go build -tags otel ./...
//
// The fallback API is intentionally tiny: it lets the rest of the codebase
// reference Tracer / Meter / Counter / Histogram without caring whether the
// real SDK is compiled in.
package telemetry

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// ShutdownFunc is returned by Init and must be called on server shutdown to
// flush exporters. The no-op implementation returns nil.
type ShutdownFunc func(context.Context) error

// Counter is a monotonically increasing integer metric.
type Counter interface {
	Add(ctx context.Context, delta int64, attrs ...Attr)
}

// Histogram records distributions of float64 observations (e.g. durations).
type Histogram interface {
	Record(ctx context.Context, value float64, attrs ...Attr)
}

// Gauge records the current value of a measurement.
type Gauge interface {
	Set(ctx context.Context, value float64, attrs ...Attr)
}

// Attr is a single key/value attribute attached to a metric or span.
type Attr struct {
	Key   string
	Value any
}

// String constructs a string attribute.
func String(k, v string) Attr { return Attr{Key: k, Value: v} }

// Int64 constructs an int64 attribute.
func Int64(k string, v int64) Attr { return Attr{Key: k, Value: v} }

// Float64 constructs a float64 attribute.
func Float64(k string, v float64) Attr { return Attr{Key: k, Value: v} }

// Span is a single tracing span.
type Span interface {
	End()
	SetAttributes(attrs ...Attr)
	RecordError(err error)
}

// Tracer creates spans within a single instrumentation library.
type Tracer interface {
	Start(ctx context.Context, name string, attrs ...Attr) (context.Context, Span)
}

// Meter creates instruments within a single instrumentation library.
type Meter interface {
	Counter(name, description string) Counter
	Histogram(name, description, unit string) Histogram
	Gauge(name, description string) Gauge
}

// Provider is the top-level handle returned by Init.
type Provider interface {
	Tracer(name string) Tracer
	Meter(name string) Meter
	HTTPMiddleware(next http.Handler) http.Handler
	PrometheusHandler() http.Handler // returns nil when no Prometheus exporter is wired
}

var (
	globalMu       sync.RWMutex
	globalProvider Provider = noopProvider{}
)

// SetGlobal stores p as the package-level provider returned by Global.
func SetGlobal(p Provider) {
	globalMu.Lock()
	defer globalMu.Unlock()
	if p == nil {
		globalProvider = noopProvider{}
		return
	}
	globalProvider = p
}

// Global returns the currently installed provider, or a no-op when none.
func Global() Provider {
	globalMu.RLock()
	defer globalMu.RUnlock()
	return globalProvider
}

// GlobalTracer is a convenience that fetches a tracer from the global provider.
func GlobalTracer(name string) Tracer { return Global().Tracer(name) }

// GlobalMeter is a convenience that fetches a meter from the global provider.
func GlobalMeter(name string) Meter { return Global().Meter(name) }

// ── No-op implementation ────────────────────────────────────────────────────

type noopProvider struct{}

func (noopProvider) Tracer(string) Tracer                          { return noopTracer{} }
func (noopProvider) Meter(string) Meter                            { return noopMeter{} }
func (noopProvider) HTTPMiddleware(next http.Handler) http.Handler { return next }
func (noopProvider) PrometheusHandler() http.Handler               { return nil }

type noopTracer struct{}

func (noopTracer) Start(ctx context.Context, _ string, _ ...Attr) (context.Context, Span) {
	return ctx, noopSpan{}
}

type noopSpan struct{}

func (noopSpan) End()                  {}
func (noopSpan) SetAttributes(...Attr) {}
func (noopSpan) RecordError(error)     {}

type noopMeter struct{}

func (noopMeter) Counter(string, string) Counter             { return noopCounter{} }
func (noopMeter) Histogram(string, string, string) Histogram { return noopHistogram{} }
func (noopMeter) Gauge(string, string) Gauge                 { return noopGauge{} }

type noopCounter struct{}

func (noopCounter) Add(context.Context, int64, ...Attr) {}

type noopHistogram struct{}

func (noopHistogram) Record(context.Context, float64, ...Attr) {}

type noopGauge struct{}

func (noopGauge) Set(context.Context, float64, ...Attr) {}

// TimeSince records the elapsed time since start as seconds on h. Convenience
// shim used by Hub / service-layer instrumentation.
func TimeSince(ctx context.Context, h Histogram, start time.Time, attrs ...Attr) {
	if h == nil {
		return
	}
	h.Record(ctx, time.Since(start).Seconds(), attrs...)
}

// init installs a no-op provider as the package default. The real
// telemetry_otel.go (build tag `otel`) overrides this via Init.
func init() {
	SetGlobal(noopProvider{})
}
