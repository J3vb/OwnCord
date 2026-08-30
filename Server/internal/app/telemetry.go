package app

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// runInitTelemetry initialises OpenTelemetry and returns the shutdown step
// run defers. Extracted from run.
func runInitTelemetry(log *slog.Logger, cfg *config.Config) func() {
	// Init can return (nil, err) when the otel build-tag skeleton hasn't been
	// finished wiring to the upstream SDK. Normalise to a no-op shutdown so
	// the deferred closure never calls a nil function.
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
