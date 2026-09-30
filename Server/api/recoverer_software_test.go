package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/stackutil"
)

// TestRecoverer_SoftwarePanicStaysRecovered pins the non-Windows half of
// SRE-08 at the HTTP recovery site: a software panic is still answered with
// 500 and the process keeps running. The Windows hardware-fault branch cannot
// run on this leg (stackutil.HardwareFault is GOOS-gated), so this asserts the
// classifier did not make every panic fatal.
func TestRecoverer_SoftwarePanicStaysRecovered(t *testing.T) {
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	r := recoverer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/boom", nil))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (software panic recovered)", rr.Code)
	}
	if stackutil.HardwareFault("boom") {
		t.Fatal("a string panic classified as a hardware fault")
	}
}
