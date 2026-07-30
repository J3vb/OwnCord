package api

// White-box tests for the bounds placed on client-controlled values before
// they enter a log record (and hence the admin ring buffer, which retains
// 2000 entries and captures DEBUG regardless of the configured log level).
// They live in package api (not api_test) so they can reach the unexported
// middleware.

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
)

// loggedRequest runs req through the production request-id + logging chain and
// returns the captured log output and the response recorder.
func loggedRequest(t *testing.T, req *http.Request) (string, *httptest.ResponseRecorder) {
	t.Helper()

	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	h := boundRequestID(middleware.RequestID(setRequestIDHeader(requestLogger(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})))))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return logs.String(), rr
}

// TestBoundRequestID_OverLongHeaderNeverReachesLog locks the bound: an inbound
// X-Request-Id past maxRequestIDLen is dropped, so none of the attacker's bytes
// land in the log record the ring buffer retains — nor in the response header.
// The request still gets a server-generated id.
func TestBoundRequestID_OverLongHeaderNeverReachesLog(t *testing.T) {
	filler := strings.Repeat("A", maxRequestIDLen+1)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("X-Request-Id", filler)

	out, rr := loggedRequest(t, req)

	if strings.Contains(out, filler) {
		t.Errorf("over-long X-Request-Id reached the log record: %q", out)
	}
	if !strings.Contains(out, "req_id=") {
		t.Errorf("no request id was logged at all — correlation lost: %q", out)
	}
	if got := rr.Header().Get("X-Request-Id"); strings.Contains(got, filler) {
		t.Errorf("over-long X-Request-Id echoed in response header: %q", got)
	}
}

// TestBoundRequestID_ControlBytesRejected covers the charset half of the bound:
// a short id carrying control bytes is dropped too.
func TestBoundRequestID_ControlBytesRejected(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("X-Request-Id", "abc\x00def\tghi")

	out, _ := loggedRequest(t, req)

	if strings.Contains(out, "abc") {
		t.Errorf("ill-formed X-Request-Id reached the log record: %q", out)
	}
}

// TestBoundRequestID_NormalIDPreserved proves the bound does not break the
// req_id correlation feature: an ordinary client-supplied id still flows into
// the log record and back out in the response header.
func TestBoundRequestID_NormalIDPreserved(t *testing.T) {
	const id = "3f8b1c2e-7a11-4c9d-9f0b-2b6f2f1c9a55"
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("X-Request-Id", id)

	out, rr := loggedRequest(t, req)

	if !strings.Contains(out, "req_id="+id) {
		t.Errorf("client request id was dropped: %q", out)
	}
	if got := rr.Header().Get("X-Request-Id"); got != id {
		t.Errorf("response X-Request-Id = %q, want %q", got, id)
	}
}

// TestRequestLogger_LongPathTruncated locks the same bound on the other
// unbounded client-controlled value in the record: net/http accepts a URL up to
// MaxHeaderBytes, and requestLogger logs the path on every request (404s
// included, at Warn).
func TestRequestLogger_LongPathTruncated(t *testing.T) {
	filler := strings.Repeat("B", maxLoggedPathLen+50)
	req := httptest.NewRequest(http.MethodGet, "/"+filler, nil)

	out, _ := loggedRequest(t, req)

	if strings.Contains(out, filler) {
		t.Errorf("unbounded request path reached the log record: %q", out)
	}
	if !strings.Contains(out, "(truncated)") {
		t.Errorf("expected a truncation marker in the logged path: %q", out)
	}
}
