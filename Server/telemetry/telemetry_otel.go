//go:build otel

// Phase B Step 8 — Real OpenTelemetry-backed implementation. Compiled only
// with `-tags otel`, matching the postgres / wazero build-tag pattern used
// elsewhere in the repo. The default build ships telemetry_default.go with a
// no-op provider so sqlite-only binaries do not pull the OTel SDK in.
//
// Exporter modes (config.TelemetryConfig.Exporter):
//
//	"none"       — no-op provider; same as the default build.
//	"prometheus" — pull-based metrics via a /metrics handler, spans are still
//	               processed by a batching tracer provider with no exporter.
//	"otlp"       — push-based traces over OTLP/gRPC to cfg.OTLPEndpoint AND
//	               pull-based metrics via the Prometheus exporter.
//
// The concrete Provider adapts our tiny telemetry.* API onto the upstream
// OTel SDK so the rest of the codebase never depends on the SDK directly.
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sync"

	"github.com/owncord/server/config"

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

// otelProvider adapts the OTel SDK to the telemetry.Provider interface.
type otelProvider struct {
	cfg         config.TelemetryConfig
	promHandler http.Handler
	tp          *sdktrace.TracerProvider
	mp          *sdkmetric.MeterProvider
	serviceName string
}

// Init wires the OTel SDK according to cfg and installs it as the global
// Provider. The returned ShutdownFunc flushes the batchers and releases
// exporter resources; it is safe to call more than once.
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

	// ── Tracing ────────────────────────────────────────────────────────────
	tpOpts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	if cfg.Exporter == "otlp" {
		endpoint := cfg.OTLPEndpoint
		if endpoint == "" {
			endpoint = "localhost:4317"
		}
		traceExp, err := otlptracegrpc.New(ctx,
			otlptracegrpc.WithEndpoint(endpoint),
			otlptracegrpc.WithInsecure(),
		)
		if err != nil {
			return nil, fmt.Errorf("telemetry: otlp trace exporter: %w", err)
		}
		tpOpts = append(tpOpts, sdktrace.WithBatcher(traceExp))
	}
	provider.tp = sdktrace.NewTracerProvider(tpOpts...)
	otel.SetTracerProvider(provider.tp)

	// ── Metrics ────────────────────────────────────────────────────────────
	// Both prometheus and otlp modes surface metrics via a pull-based
	// Prometheus endpoint. OTLP tracing does not preclude Prometheus metrics
	// — operators usually want both — so we wire the exporter unconditionally
	// for the two real modes.
	reg := promclient.NewRegistry()
	promExp, err := otelprom.New(otelprom.WithRegisterer(reg))
	if err != nil {
		// Shut the trace provider down so the OTLP exporter's gRPC
		// connection (if any) is torn down. Init returning an error must
		// not leak resources.
		_ = provider.tp.Shutdown(ctx)
		return nil, fmt.Errorf("telemetry: prometheus exporter: %w", err)
	}
	provider.mp = sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(promExp),
	)
	otel.SetMeterProvider(provider.mp)
	provider.promHandler = promhttp.HandlerFor(reg, promhttp.HandlerOpts{})

	// Drop the cached AppMetrics bundle BEFORE publishing the new global
	// provider. A concurrent NewAppMetrics() caller that observes the old
	// no-op provider and the stale cache is harmless (it just re-populates
	// once); the failure mode we avoid is a caller seeing the new provider
	// but still reading the old cached (no-op) instruments.
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

// HTTPMiddleware wraps next with otelhttp so every REST request becomes a span
// named after its route pattern.
func (p *otelProvider) HTTPMiddleware(next http.Handler) http.Handler {
	return otelhttp.NewHandler(next, "http.server",
		otelhttp.WithServerName(p.serviceName),
	)
}

// PrometheusHandler returns the /metrics handler backed by the active
// exporter registry.
func (p *otelProvider) PrometheusHandler() http.Handler { return p.promHandler }

// ── Tracer / Span adapters ─────────────────────────────────────────────────

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

// ── Meter / instrument adapters ────────────────────────────────────────────

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

// convertAttrs maps telemetry.Attr values to attribute.KeyValue. Unknown
// types are rendered via fmt.Sprint so callers never panic on exotic values.
// The uint64 / uint32 / uint cases matter: sequence numbers and ID fields in
// OwnCord are unsigned, and routing them through the default fmt.Sprint path
// would encode them as string attributes and break metric aggregation.
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
			// Most uint64 values in OwnCord (ids, seqs) fit comfortably
			// within int64 range. A wrapped negative would corrupt
			// metric aggregation, so we fall back to a string for the
			// pathological case rather than silently misreporting.
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
