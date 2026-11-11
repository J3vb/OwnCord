// Package logctx provides a slog.Handler that adds correlation IDs from the
// context to every record: the chi request ID (req_id) and, under -tags otel,
// the trace ID (trace_id), so ...Context log calls tie back to their request and trace.
package logctx

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/telemetry"
	"github.com/go-chi/chi/v5/middleware"
)

type handler struct {
	inner slog.Handler
}

// New wraps inner so records handled with a context carrying a request ID (and,
// in the otel build, an active span) gain req_id and trace_id attributes.
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

// WithGroup re-wraps so enrichment survives logger.WithGroup; IDs go at the
// record's top level, as the codebase opens no logger-level groups.
func (h handler) WithGroup(name string) slog.Handler {
	return handler{inner: h.inner.WithGroup(name)}
}
