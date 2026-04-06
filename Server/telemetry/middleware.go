// Phase B Step 8 — HTTP middleware that delegates tracing to the global
// provider. The default no-op build returns next unchanged; the otel-tagged
// build wraps next with otelchi.Middleware. Mount it from the Chi router so
// every REST request becomes a span automatically.
package telemetry

import "net/http"

// HTTPMiddleware returns an HTTP middleware that traces every request via
// the currently installed Provider. Safe to mount unconditionally — it is a
// pass-through when telemetry is disabled.
func HTTPMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return Global().HTTPMiddleware(next)
	}
}

// PrometheusHandler returns the active Prometheus exporter handler, or nil if
// no Prometheus exporter is wired. Mount it from the API router only when
// non-nil so the legacy /metrics endpoint stays untouched in the no-op build.
func PrometheusHandler() http.Handler { return Global().PrometheusHandler() }
