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
		method string
		path   string
		status int
		level  string
	}{
		{"admin read 200 is debug", http.MethodGet, "/admin/api/system/stats", http.StatusOK, "level=DEBUG"},
		{"admin write 200 is info", http.MethodPost, "/admin/api/users/1/ban", http.StatusOK, "level=INFO"},
		{"admin 403 is warn", http.MethodGet, "/admin/api/system/stats", http.StatusForbidden, "level=WARN"},
		{"admin 500 is error", http.MethodGet, "/admin/api/system/stats", http.StatusInternalServerError, "level=ERROR"},
		{"other 200 is info", http.MethodGet, "/api/v1/channels", http.StatusOK, "level=INFO"},
		{"prefix lookalike is info", http.MethodGet, "/admin/apix", http.StatusOK, "level=INFO"},
		{"bare prefix is info", http.MethodGet, "/admin/api", http.StatusOK, "level=INFO"},
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
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(tc.method, tc.path, nil))

			var line string
			for l := range strings.SplitSeq(logs.String(), "\n") {
				if strings.Contains(l, `msg="http request"`) {
					line = l
				}
			}
			if !strings.Contains(line, tc.level) {
				t.Fatalf("request line = %q, want %s", line, tc.level)
			}
		})
	}
}
