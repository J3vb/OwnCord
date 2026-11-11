//go:build otel

// Real OpenTelemetry-backed implementation (`-tags otel`). Exporter modes
// (config.TelemetryConfig.Exporter): "none" is a no-op provider; "prometheus"
// serves pull-based metrics via /metrics with spans processed but not exported;
// "otlp" pushes traces over OTLP/gRPC to cfg.OTLPEndpoint and also serves
// Prometheus metrics. The Provider adapts our telemetry.* API onto the SDK so
// the rest of the codebase never depends on it.
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sync"

	"github.com/J3vb/OwnCord/Server/config"

	promclient "github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	otelprom "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
	"go.opentelemetry.io/otel/trace"
)

// SDKAvailable is true here: the otel build can honour telemetry.enabled.
const SDKAvailable = true

// otelProvider adapts the OTel SDK to the telemetry.Provider interface.
type otelProvider struct {
	cfg         config.TelemetryConfig
	promHandler http.Handler
	tp          *sdktrace.TracerProvider
	mp          *sdkmetric.MeterProvider
	serviceName string
}

// Init wires the OTel SDK per cfg and installs it as the global Provider. The
// returned ShutdownFunc flushes and releases exporters and is safe to call more than once.
func Init(ctx context.Context, cfg config.TelemetryConfig) (ShutdownFunc, error) {
	if !cfg.Enabled || cfg.Exporter == "" || cfg.Exporter == "none" {
		SetGlobal(noopProvider{})
		return func(context.Context) error { return nil }, nil
	}

	svcName := cfg.ServiceName
	if svcName == "" {
		svcName = "owncord-server"
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(svcName),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("telemetry: resource: %w", err)
	}

	provider := &otelProvider{cfg: cfg, serviceName: svcName}

	tpOpts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	if cfg.Exporter == "otlp" {
		endpoint := cfg.OTLPEndpoint
		if endpoint == "" {
			endpoint = "localhost:4317"
		}
		otlpOpts := []otlptracegrpc.Option{
			otlptracegrpc.WithEndpoint(endpoint),
		}
		// OTLPInsecure is the explicit opt-in for plaintext gRPC; production should use a TLS endpoint.
		if cfg.OTLPInsecure {
			otlpOpts = append(otlpOpts, otlptracegrpc.WithInsecure())
		}
		traceExp, err := otlptracegrpc.New(ctx, otlpOpts...)
		if err != nil {
			return nil, fmt.Errorf("telemetry: otlp trace exporter: %w", err)
		}
		tpOpts = append(tpOpts, sdktrace.WithBatcher(traceExp))
	}
	provider.tp = sdktrace.NewTracerProvider(tpOpts...)
	otel.SetTracerProvider(provider.tp)

	// Both real modes serve Prometheus metrics (OTLP tracing does not preclude it), so wire the exporter
	// unconditionally.
	reg := promclient.NewRegistry()
	promExp, err := otelprom.New(otelprom.WithRegisterer(reg))
	if err != nil {
		// Shut the trace provider down so Init failing does not leak an OTLP gRPC connection.
		_ = provider.tp.Shutdown(ctx)
		return nil, fmt.Errorf("telemetry: prometheus exporter: %w", err)
	}
	provider.mp = sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(promExp),
	)
	otel.SetMeterProvider(provider.mp)
	provider.promHandler = promhttp.HandlerFor(reg, promhttp.HandlerOpts{})

	// Drop the cached AppMetrics BEFORE publishing the new provider, so a caller
	// never sees the new provider with the old no-op instruments; the reverse is harmless.
	resetAppMetricsForInit()
	SetGlobal(provider)

	var once sync.Once
	return func(shutCtx context.Context) error {
		var rerr error
		once.Do(func() {
			var errs []error
			if provider.tp != nil {
				if err := provider.tp.Shutdown(shutCtx); err != nil {
					errs = append(errs, err)
				}
			}
			if provider.mp != nil {
				if err := provider.mp.Shutdown(shutCtx); err != nil {
					errs = append(errs, err)
				}
			}
			if len(errs) > 0 {
				rerr = fmt.Errorf("telemetry shutdown: %w", errors.Join(errs...))
			}
			SetGlobal(noopProvider{})
		})
		return rerr
	}, nil
}

// Tracer returns an otel-backed tracer for the given instrumentation scope.
func (p *otelProvider) Tracer(name string) Tracer {
	return &otelTracer{inner: p.tp.Tracer(name)}
}

// Meter returns an otel-backed meter for the given instrumentation scope.
func (p *otelProvider) Meter(name string) Meter {
	return &otelMeter{inner: p.mp.Meter(name)}
}

// HTTPMiddleware wraps next with otelhttp, one span per request named by route pattern.
func (p *otelProvider) HTTPMiddleware(next http.Handler) http.Handler {
	return otelhttp.NewHandler(next, "http.server",
		otelhttp.WithServerName(p.serviceName),
	)
}

// PrometheusHandler returns the /metrics handler for the active exporter registry.
func (p *otelProvider) PrometheusHandler() http.Handler { return p.promHandler }

// TraceIDFromContext returns the recording span's trace ID as hex, or "" if
// none; used to stamp log records so they correlate with traces.
func TraceIDFromContext(ctx context.Context) string {
	if sc := trace.SpanContextFromContext(ctx); sc.HasTraceID() {
		return sc.TraceID().String()
	}
	return ""
}

type otelTracer struct{ inner trace.Tracer }

func (t *otelTracer) Start(ctx context.Context, name string, attrs ...Attr) (context.Context, Span) {
	ctx, span := t.inner.Start(ctx, name, trace.WithAttributes(convertAttrs(attrs)...))
	return ctx, &otelSpan{inner: span}
}

type otelSpan struct{ inner trace.Span }

func (s *otelSpan) End()                        { s.inner.End() }
func (s *otelSpan) SetAttributes(attrs ...Attr) { s.inner.SetAttributes(convertAttrs(attrs)...) }
func (s *otelSpan) RecordError(err error) {
	if err == nil {
		return
	}
	s.inner.RecordError(err)
}

type otelMeter struct{ inner metric.Meter }

func (m *otelMeter) Counter(name, description string) Counter {
	c, err := m.inner.Int64Counter(name, metric.WithDescription(description))
	if err != nil {
		return noopCounter{}
	}
	return &otelCounter{inner: c}
}

func (m *otelMeter) Histogram(name, description, unit string) Histogram {
	opts := []metric.Float64HistogramOption{metric.WithDescription(description)}
	if unit != "" {
		opts = append(opts, metric.WithUnit(unit))
	}
	h, err := m.inner.Float64Histogram(name, opts...)
	if err != nil {
		return noopHistogram{}
	}
	return &otelHistogram{inner: h}
}

func (m *otelMeter) Gauge(name, description string) Gauge {
	g, err := m.inner.Float64Gauge(name, metric.WithDescription(description))
	if err != nil {
		return noopGauge{}
	}
	return &otelGauge{inner: g}
}

type otelCounter struct{ inner metric.Int64Counter }

func (c *otelCounter) Add(ctx context.Context, delta int64, attrs ...Attr) {
	c.inner.Add(ctx, delta, metric.WithAttributes(convertAttrs(attrs)...))
}

type otelHistogram struct{ inner metric.Float64Histogram }

func (h *otelHistogram) Record(ctx context.Context, value float64, attrs ...Attr) {
	h.inner.Record(ctx, value, metric.WithAttributes(convertAttrs(attrs)...))
}

type otelGauge struct{ inner metric.Float64Gauge }

func (g *otelGauge) Set(ctx context.Context, value float64, attrs ...Attr) {
	g.inner.Record(ctx, value, metric.WithAttributes(convertAttrs(attrs)...))
}

// convertAttrs maps Attr values to attribute.KeyValue, rendering unknown types
// via fmt.Sprint. The unsigned cases matter: ids and seqs are unsigned and
// would otherwise become string attributes and break aggregation.
func convertAttrs(in []Attr) []attribute.KeyValue {
	if len(in) == 0 {
		return nil
	}
	out := make([]attribute.KeyValue, 0, len(in))
	for _, a := range in {
		switch v := a.Value.(type) {
		case string:
			out = append(out, attribute.String(a.Key, v))
		case int:
			out = append(out, attribute.Int(a.Key, v))
		case int32:
			out = append(out, attribute.Int64(a.Key, int64(v)))
		case int64:
			out = append(out, attribute.Int64(a.Key, v))
		case uint:
			out = append(out, attribute.Int64(a.Key, int64(v)))
		case uint32:
			out = append(out, attribute.Int64(a.Key, int64(v)))
		case uint64:
			// Most uint64 values fit in int64; a wrapped negative would corrupt aggregation, so fall back to a string.
			if v <= math.MaxInt64 {
				out = append(out, attribute.Int64(a.Key, int64(v)))
			} else {
				out = append(out, attribute.String(a.Key, fmt.Sprint(v)))
			}
		case float32:
			out = append(out, attribute.Float64(a.Key, float64(v)))
		case float64:
			out = append(out, attribute.Float64(a.Key, v))
		case bool:
			out = append(out, attribute.Bool(a.Key, v))
		default:
			out = append(out, attribute.String(a.Key, fmt.Sprint(v)))
		}
	}
	return out
}
