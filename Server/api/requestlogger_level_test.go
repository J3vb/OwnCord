package api

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The admin panel polls its own API, so a successful request under
// /admin/api/ must not appear at INFO in the Live log; failures still do.
func TestRequestLogger_AdminAPILevels(t *testing.T) {
	cases := []struct {
		name   string
		path   string
		status int
		level  string
	}{
		{"admin 200 is debug", "/admin/api/system/stats", http.StatusOK, "level=DEBUG"},
		{"admin 403 is warn", "/admin/api/system/stats", http.StatusForbidden, "level=WARN"},
		{"admin 500 is error", "/admin/api/system/stats", http.StatusInternalServerError, "level=ERROR"},
		{"other 200 is info", "/api/v1/channels", http.StatusOK, "level=INFO"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
			t.Cleanup(func() { slog.SetDefault(prev) })

			h := requestLogger(nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
			}))
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, tc.path, nil))

			out := logs.String()
			if !strings.Contains(out, tc.level) || !strings.Contains(out, "http request") {
				t.Fatalf("log = %q, want %s", out, tc.level)
			}
		})
	}
}
