//go:build !otel

// Default no-op build of the telemetry package — see telemetry.go for the
// public API. The real OpenTelemetry SDK wiring lives in telemetry_otel.go and
// is selected by `go build -tags otel ./...`.

package telemetry

import (
	"context"

	"github.com/J3vb/OwnCord/Server/config"
)

// Init configures and installs the OpenTelemetry SDK based on cfg. In the
// default build this installs a no-op provider so call sites have a usable
// global handle without pulling in any external dependencies.
func Init(_ context.Context, cfg config.TelemetryConfig) (ShutdownFunc, error) {
	_ = cfg // honoured by the otel-tagged build only
	SetGlobal(noopProvider{})
	return func(context.Context) error { return nil }, nil
}

// TraceIDFromContext returns the active trace ID as a hex string, or "" when no
// span is active. The default build has no tracing, so it always returns "".
func TraceIDFromContext(_ context.Context) string { return "" }
