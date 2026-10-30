package app

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// initTelemetry initialises OpenTelemetry and returns the shutdown step the
// telemetry stage registers with App.Close.
func initTelemetry(log *slog.Logger, cfg *config.Config) func() {
	// telemetry.enabled is inert on a build without the SDK (the release and
	// Docker builds use no build tags); say so once at startup so the operator
	// does not wonder why a configured exporter emits nothing.
	if cfg.Telemetry.Enabled && !telemetry.SDKAvailable {
		log.Warn("telemetry.enabled is set but this build has no OpenTelemetry SDK; rebuild with -tags otel for the configured exporter to take effect")
	}
	// Init can return (nil, err) when the otel build-tag skeleton is not fully
	// wired to the upstream SDK; normalise to a no-op shutdown so the deferred
	// closure never calls a nil function.
	telemetryShutdown, telErr := telemetry.Init(context.Background(), cfg.Telemetry)
	if telErr != nil {
		log.Warn("telemetry init failed; continuing without OpenTelemetry", "error", telErr)
	}
	if telemetryShutdown == nil {
		telemetryShutdown = func(context.Context) error { return nil }
	}

	return func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := telemetryShutdown(shutdownCtx); err != nil {
			log.Warn("telemetry shutdown returned error", "error", err)
		}
	}
}
