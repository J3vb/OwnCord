package logctx

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
)

// TestHandlerAddsReqID verifies the enriching handler stamps req_id when the
// context carries a chi request ID, and omits it otherwise. (trace_id is only
// populated under -tags otel and is covered by manual verification.)
func TestHandlerAddsReqID(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(New(slog.NewTextHandler(&buf, nil)))

	ctx := context.WithValue(context.Background(), middleware.RequestIDKey, "req-abc-123")
	log.InfoContext(ctx, "hello")
	if !strings.Contains(buf.String(), "req_id=req-abc-123") {
		t.Errorf("expected req_id in output, got: %s", buf.String())
	}

	buf.Reset()
	log.InfoContext(context.Background(), "plain")
	if strings.Contains(buf.String(), "req_id") {
		t.Errorf("did not expect req_id without a request ID: %s", buf.String())
	}

	// Enrichment must survive logger.With (WithAttrs re-wrap).
	buf.Reset()
	log.With("k", "v").InfoContext(ctx, "withattrs")
	if !strings.Contains(buf.String(), "req_id=req-abc-123") {
		t.Errorf("expected req_id to survive With(): %s", buf.String())
	}
}

// TestHandlerSurvivesWithGroup covers the WithGroup re-wrap and pins the known
// nesting caveat the WithGroup doc comment flags.
//
// Enrichment survives the re-wrap, but because Handle calls r.AddAttrs *after*
// the inner handler has opened the group, req_id lands as "http.req_id" rather
// than at the record's top level. That is only harmless while no logger-level
// groups are opened in production code — which is true today, and is exactly
// the condition the source comment says to revisit. If someone introduces
// slog groups, this test is what tells them log searches for a bare `req_id`
// will stop matching.
func TestHandlerSurvivesWithGroup(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(New(slog.NewTextHandler(&buf, nil)))
	ctx := context.WithValue(context.Background(), middleware.RequestIDKey, "req-group-1")

	log.WithGroup("http").InfoContext(ctx, "grouped", "status", 200)

	out := buf.String()
	if !strings.Contains(out, "req-group-1") {
		t.Errorf("req_id was dropped by WithGroup(): %s", out)
	}
	if !strings.Contains(out, "http.req_id=req-group-1") {
		t.Errorf("current behaviour is to nest req_id under the group; got: %s", out)
	}
	if !strings.Contains(out, "http.status=200") {
		t.Errorf("expected the group to still apply to record attrs: %s", out)
	}
}

// TestHandlerEnabledDelegates confirms the wrapper does not widen or narrow the
// inner handler's level.
func TestHandlerEnabledDelegates(t *testing.T) {
	var buf bytes.Buffer
	inner := slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})
	h := New(inner)

	if h.Enabled(context.Background(), slog.LevelInfo) {
		t.Error("Enabled(Info) = true for a Warn-level inner handler")
	}
	if !h.Enabled(context.Background(), slog.LevelError) {
		t.Error("Enabled(Error) = false for a Warn-level inner handler")
	}
}
