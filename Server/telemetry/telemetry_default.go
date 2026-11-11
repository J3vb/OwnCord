//go:build !otel

// Default no-op build; see telemetry.go. The real SDK wiring is in telemetry_otel.go (`-tags otel`).

package telemetry

import (
	"context"

	"github.com/J3vb/OwnCord/Server/config"
)

// SDKAvailable is false in this build, so telemetry.enabled is silently inert;
// internal/app warns when an operator sets it on a build that cannot honour it.
const SDKAvailable = false

// Init installs a no-op provider so call sites have a usable global handle.
func Init(_ context.Context, cfg config.TelemetryConfig) (ShutdownFunc, error) {
	_ = cfg // honoured by the otel-tagged build only
	SetGlobal(noopProvider{})
	return func(context.Context) error { return nil }, nil
}

// TraceIDFromContext returns the active trace ID as a hex string, or "" when no
// span is active. The default build has no tracing, so it always returns "".
func TraceIDFromContext(_ context.Context) string { return "" }
