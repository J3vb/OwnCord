//go:build otel

// Real OpenTelemetry-backed implementation. Compiled only with `-tags otel`.
// Replaces the no-op providers in telemetry_default.go for the duration of
// the process.
package telemetry

import (
	"context"
	"fmt"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otlpgrpc "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	promexp "go.opentelemetry.io/otel/exporters/prometheus"
	otelmetric "go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdkresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	oteltrace "go.opentelemetry.io/otel/trace"

	"github.com/owncord/server/config"
)

// otelProvider is the real OTel-backed Provider, active only in the otel build.
type otelProvider struct {
	tp          oteltrace.TracerProvider
	mp          otelmetric.MeterProvider
	promHandler http.Handler
	mw          func(http.Handler) http.Handler
	shutdowns   []func(context.Context) error
}

// Init wires the OTel SDK according to cfg.Exporter and installs the result
// as the global telemetry provider. The returned ShutdownFunc must be called
// on server shutdown to flush pending telemetry.
func Init(ctx context.Context, cfg config.TelemetryConfig) (ShutdownFunc, error) {
	if !cfg.Enabled || cfg.Exporter == "" || cfg.Exporter == "none" {
		SetGlobal(noopProvider{})
		return func(context.Context) error { return nil }, nil
	}

	res, err := sdkresource.New(ctx,
		sdkresource.WithAttributes(attribute.String("service.name", cfg.ServiceName)),
		sdkresource.WithFromEnv(),
	)
	if err != nil {
		// Non-fatal: fall back to the SDK default resource.
		res = sdkresource.Default()
	}

	p := &otelProvider{}

	switch cfg.Exporter {
	case "prometheus":
		promReg := prometheus.NewRegistry()
		exporter, expErr := promexp.New(promexp.WithRegisterer(promReg))
		if expErr != nil {
			return nil, fmt.Errorf("telemetry: prometheus exporter: %w", expErr)
		}
		mp := sdkmetric.NewMeterProvider(
			sdkmetric.WithResource(res),
			sdkmetric.WithReader(exporter),
		)
		otel.SetMeterProvider(mp)
		p.mp = mp
		p.promHandler = promhttp.HandlerFor(promReg, promhttp.HandlerOpts{EnableOpenMetrics: true})
		p.shutdowns = append(p.shutdowns, mp.Shutdown)

	case "otlp":
		if cfg.OTLPEndpoint == "" {
			return nil, fmt.Errorf("telemetry: exporter=otlp requires otlp_endpoint to be set")
		}
		otlpOpts := []otlpgrpc.Option{
			otlpgrpc.WithEndpoint(cfg.OTLPEndpoint),
		}
		if cfg.OTLPInsecure {
			otlpOpts = append(otlpOpts, otlpgrpc.WithInsecure())
		}
		exp, expErr := otlpgrpc.New(ctx, otlpOpts...)
		if expErr != nil {
			return nil, fmt.Errorf("telemetry: otlp exporter: %w", expErr)
		}
		tp := sdktrace.NewTracerProvider(
			sdktrace.WithBatcher(exp),
			sdktrace.WithResource(res),
		)
		otel.SetTracerProvider(tp)
		p.tp = tp
		p.shutdowns = append(p.shutdowns, tp.Shutdown)

	default:
		return nil, fmt.Errorf("telemetry: unknown exporter %q (valid: none, prometheus, otlp)", cfg.Exporter)
	}

	// HTTP tracing middleware using otelhttp (works with any http.Handler router).
	p.mw = func(next http.Handler) http.Handler {
		return otelhttp.NewHandler(next, cfg.ServiceName)
	}

	SetGlobal(p)
	return p.shutdown, nil
}

func (p *otelProvider) shutdown(ctx context.Context) error {
	var first error
	for _, fn := range p.shutdowns {
		if err := fn(ctx); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// ── Provider interface ──────────────────────────────────────────────────────

func (p *otelProvider) Tracer(name string) Tracer {
	tp := p.tp
	if tp == nil {
		tp = otel.GetTracerProvider()
	}
	return otelTracerBridge{t: tp.Tracer(name)}
}

func (p *otelProvider) Meter(name string) Meter {
	mp := p.mp
	if mp == nil {
		mp = otel.GetMeterProvider()
	}
	return otelMeterBridge{m: mp.Meter(name)}
}

func (p *otelProvider) HTTPMiddleware(next http.Handler) http.Handler {
	if p.mw == nil {
		return next
	}
	return p.mw(next)
}

func (p *otelProvider) PrometheusHandler() http.Handler { return p.promHandler }

// ── Bridge: Tracer / Span ───────────────────────────────────────────────────

type otelTracerBridge struct{ t oteltrace.Tracer }

func (b otelTracerBridge) Start(ctx context.Context, name string, attrs ...Attr) (context.Context, Span) {
	var opts []oteltrace.SpanStartOption
	if len(attrs) > 0 {
		opts = append(opts, oteltrace.WithAttributes(toKVs(attrs)...))
	}
	ctx, span := b.t.Start(ctx, name, opts...)
	return ctx, otelSpanBridge{s: span}
}

type otelSpanBridge struct{ s oteltrace.Span }

func (b otelSpanBridge) End()                        { b.s.End() }
func (b otelSpanBridge) SetAttributes(attrs ...Attr) { b.s.SetAttributes(toKVs(attrs)...) }
func (b otelSpanBridge) RecordError(err error)       { b.s.RecordError(err) }

// ── Bridge: Meter / instruments ─────────────────────────────────────────────

type otelMeterBridge struct{ m otelmetric.Meter }

func (b otelMeterBridge) Counter(name, description string) Counter {
	c, err := b.m.Int64Counter(name, otelmetric.WithDescription(description))
	if err != nil {
		return noopCounter{}
	}
	return otelCounterBridge{c: c}
}

func (b otelMeterBridge) Histogram(name, description, unit string) Histogram {
	h, err := b.m.Float64Histogram(name,
		otelmetric.WithDescription(description),
		otelmetric.WithUnit(unit),
	)
	if err != nil {
		return noopHistogram{}
	}
	return otelHistogramBridge{h: h}
}

func (b otelMeterBridge) Gauge(name, description string) Gauge {
	g, err := b.m.Float64Gauge(name, otelmetric.WithDescription(description))
	if err != nil {
		return noopGauge{}
	}
	return otelGaugeBridge{g: g}
}

type otelCounterBridge struct{ c otelmetric.Int64Counter }

func (b otelCounterBridge) Add(ctx context.Context, delta int64, attrs ...Attr) {
	b.c.Add(ctx, delta, otelmetric.WithAttributes(toKVs(attrs)...))
}

type otelHistogramBridge struct{ h otelmetric.Float64Histogram }

func (b otelHistogramBridge) Record(ctx context.Context, value float64, attrs ...Attr) {
	b.h.Record(ctx, value, otelmetric.WithAttributes(toKVs(attrs)...))
}

type otelGaugeBridge struct{ g otelmetric.Float64Gauge }

func (b otelGaugeBridge) Set(ctx context.Context, value float64, attrs ...Attr) {
	b.g.Record(ctx, value, otelmetric.WithAttributes(toKVs(attrs)...))
}

// ── Attribute helpers ───────────────────────────────────────────────────────

func toKV(a Attr) attribute.KeyValue {
	switch v := a.Value.(type) {
	case string:
		return attribute.String(a.Key, v)
	case int64:
		return attribute.Int64(a.Key, v)
	case int:
		return attribute.Int(a.Key, v)
	case float64:
		return attribute.Float64(a.Key, v)
	case bool:
		return attribute.Bool(a.Key, v)
	default:
		return attribute.String(a.Key, fmt.Sprintf("%v", v))
	}
}

func toKVs(attrs []Attr) []attribute.KeyValue {
	kvs := make([]attribute.KeyValue, 0, len(attrs))
	for _, a := range attrs {
		kvs = append(kvs, toKV(a))
	}
	return kvs
}
