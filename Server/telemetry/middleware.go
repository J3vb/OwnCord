// HTTP middleware delegating tracing to the global provider: the no-op build
// returns next unchanged, the otel build wraps it with otelchi.Middleware.

package telemetry

import "net/http"

// HTTPMiddleware traces every request via the installed Provider; a pass-through when telemetry is off.
func HTTPMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return Global().HTTPMiddleware(next)
	}
}

// PrometheusHandler returns the Prometheus exporter handler, or nil when none is
// wired; mount it only when non-nil so /metrics is untouched in the no-op build.
func PrometheusHandler() http.Handler { return Global().PrometheusHandler() }
