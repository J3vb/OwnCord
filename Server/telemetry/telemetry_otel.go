//go:build otel

// Real OpenTelemetry-backed implementation. Compiled only with `-tags otel`,
// which keeps the OTel SDK out of the default sqlite-only build (matching the
// pattern used by Server/store/postgres.go).
//
// IMPORTANT: This file currently compiles under `-tags otel` because the
// skeleton deliberately avoids importing any upstream OTel packages. `Init`
// returns a runtime error until the real SDK wiring lands; `Shutdown` is a
// no-op. The CI matrix step that builds with `-tags otel` therefore passes
// today but does NOT exercise real telemetry. To finish wiring it, run on
// a machine with network access:
//
//	cd Server
//	go get go.opentelemetry.io/otel@latest \
//	       go.opentelemetry.io/otel/sdk@latest \
//	       go.opentelemetry.io/otel/exporters/prometheus@latest \
//	       go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@latest \
//	       go.opentelemetry.io/contrib/instrumentation/github.com/go-chi/chi/v5/otelchi@latest
//	go mod tidy
//	go build -tags otel ./...
//
// Until that runs, the default build (no `-tags otel`) uses telemetry_default.go.
package telemetry

import (
	"context"
	"fmt"
	"net/http"

	"github.com/owncord/server/config"
)

// otelProvider is the placeholder for the real OTel-backed Provider. The
// fields and methods will be filled in once the OTel modules are in go.mod;
// for now this file exists so reviewers can see the intended shape and the
// `otel` build tag has a target.
type otelProvider struct {
	cfg            config.TelemetryConfig
	promHandler    http.Handler
	httpMiddleware func(http.Handler) http.Handler
	shutdown       ShutdownFunc
}

// Init wires the OTel SDK exporters according to cfg.Exporter:
//
//	"none"       — no-op (matches the default build)
//	"prometheus" — pull-based Prometheus exporter mounted at /metrics
//	"otlp"       — push-based OTLP/gRPC exporter to cfg.OTLPEndpoint
//
// All exporters share the same resource (service.name = cfg.ServiceName).
func Init(ctx context.Context, cfg config.TelemetryConfig) (ShutdownFunc, error) {
	if !cfg.Enabled || cfg.Exporter == "" || cfg.Exporter == "none" {
		SetGlobal(noopProvider{})
		return func(context.Context) error { return nil }, nil
	}

	// TODO(otel-build-tag): replace the panic below with the real OTel
	// initialisation once go.mod has the otel modules. The structural call
	// graph is:
	//
	//   resource = sdkresource.NewWithAttributes(...)
	//   tp       = sdktrace.NewTracerProvider(WithBatcher(otlptracegrpc...))
	//   mp       = sdkmetric.NewMeterProvider(WithReader(prometheus.New()))
	//   otel.SetTracerProvider(tp); otel.SetMeterProvider(mp)
	//   handler  = promhttp.HandlerFor(prometheusReg, promhttp.HandlerOpts{})
	//   mw       = otelchi.Middleware(serviceName, otelchi.WithChiRoutes(...))
	//
	// then wrap them in a Provider implementation and SetGlobal it.
	_ = ctx
	return nil, fmt.Errorf("telemetry: otel build tag is set but the SDK skeleton in telemetry_otel.go is incomplete; finish wiring after `go get go.opentelemetry.io/otel...`")
}

// otelProvider satisfies Provider once the SDK is wired.
func (p *otelProvider) Tracer(name string) Tracer                     { _ = name; return noopTracer{} }
func (p *otelProvider) Meter(name string) Meter                       { _ = name; return noopMeter{} }
func (p *otelProvider) HTTPMiddleware(next http.Handler) http.Handler { return p.httpMiddleware(next) }
func (p *otelProvider) PrometheusHandler() http.Handler               { return p.promHandler }
