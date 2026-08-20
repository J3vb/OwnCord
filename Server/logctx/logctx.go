// Package logctx provides a slog.Handler that enriches every log record with
// correlation IDs pulled from the context: the chi request ID (as req_id) and,
// under -tags otel, the OpenTelemetry trace ID (as trace_id).
//
// Wrapping the base handler with New means any log call using the ...Context
// variants (slog.InfoContext, slog.ErrorContext, …) automatically carries
// these IDs, so a log line can be tied back to its HTTP request and its
// distributed trace without threading the IDs through by hand at every site.
package logctx

import (
	"context"
	"log/slog"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/owncord/server/telemetry"
)

type handler struct {
	inner slog.Handler
}

// New wraps inner so that records handled with a context carrying a chi request
// ID (and, in the otel build, an active span) are enriched with req_id and
// trace_id attributes.
func New(inner slog.Handler) slog.Handler {
	return handler{inner: inner}
}

func (h handler) Enabled(ctx context.Context, l slog.Level) bool {
	return h.inner.Enabled(ctx, l)
}

func (h handler) Handle(ctx context.Context, r slog.Record) error {
	if reqID := middleware.GetReqID(ctx); reqID != "" {
		r.AddAttrs(slog.String("req_id", reqID))
	}
	if tid := telemetry.TraceIDFromContext(ctx); tid != "" {
		r.AddAttrs(slog.String("trace_id", tid))
	}
	return h.inner.Handle(ctx, r)
}

func (h handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return handler{inner: h.inner.WithAttrs(attrs)}
}

// WithGroup re-wraps so enrichment survives logger.WithGroup.
// req_id/trace_id are added at the record's top level; the codebase
// opens no logger-level groups, so there is no group-nesting concern to handle
// here. Revisit if slog group usage is introduced.
func (h handler) WithGroup(name string) slog.Handler {
	return handler{inner: h.inner.WithGroup(name)}
}
