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
