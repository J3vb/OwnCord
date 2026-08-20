package ws

// Internal test for OC-0237: serviceErrorToResult's default branch (the one
// hit for service.ErrInternal, since ErrInternal has no dedicated case above
// it) put err.Error() straight into the ClientError sent to the requesting
// client, and never logged anything server-side. Service-layer ErrInternal
// wrappers embed the underlying driver error via %v (see Server/service/dm.go),
// so this leaked internal query names and driver state to an ordinary member,
// while producing zero server-side log output — handlers.go only logs when
// result.Error is NOT a ClientError. The REST twin, writeServiceError in
// Server/api/channel_handler.go, does the opposite: it logs the error and
// replies with the fixed string "an internal error occurred".

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"github.com/owncord/server/service"
)

func TestServiceErrorToResult_InternalErrorDoesNotLeakAndIsLogged(t *testing.T) {
	prev := slog.Default()
	var buf bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	// Mirrors Server/service/dm.go:149 — a real ErrInternal wrapper embedding
	// driver error text via %v, exactly what handlers_call.go's RingTargets
	// call produces when GetDMParticipantIDs fails.
	driverErr := errors.New("GetDMParticipantIDs: database is locked")
	svcErr := fmt.Errorf("%w: failed to read DM participants: %v", service.ErrInternal, driverErr)

	result := serviceErrorToResult(svcErr)

	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("serviceErrorToResult(ErrInternal wrapper) did not return a ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeInternal {
		t.Fatalf("ClientError.Code = %q, want %q", ce.Code, ErrCodeInternal)
	}

	// The client-facing message must not leak driver/query internals — it
	// must match every other ErrCodeInternal site in this package, which all
	// use a fixed string (deps.go, registry.go, voice_controls.go, serve.go).
	if strings.Contains(ce.Message, "database is locked") || strings.Contains(ce.Message, "GetDMParticipantIDs") {
		t.Fatalf("ClientError.Message leaked internal error detail to the client: %q", ce.Message)
	}
	if ce.Message == svcErr.Error() {
		t.Fatalf("ClientError.Message is the raw wrapped service error verbatim: %q", ce.Message)
	}

	// Unlike the REST path (writeServiceError), and unlike this same handler
	// path for every other error class, nothing was ever written to the
	// server log for an internal error — the operator had no record the
	// failure happened at all.
	if !strings.Contains(buf.String(), "database is locked") {
		t.Fatalf("serviceErrorToResult did not log the internal error server-side; log output: %q", buf.String())
	}
}
