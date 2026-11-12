package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// openMigratedDB opens an in-memory database with the full migration set.
func openMigratedDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// serveLocal serves req as if it came from the loopback address and returns
// the recorded response.
func serveLocal(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	req.RemoteAddr = "127.0.0.1:9999"
	return serveRequest(h, req)
}

// serveRequest serves req and returns the recorded response.
func serveRequest(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// captureDebugLogs routes the default slog logger to w, at debug level, until
// the test ends.
func captureDebugLogs(t *testing.T, w io.Writer) {
	t.Helper()
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
}
