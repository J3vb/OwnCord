package api

// SRE-11: the access log recorded the reverse proxy's address even when
// trusted_proxies was configured, so an operator running the recommended
// reverse-proxy deployment could not trace a client. requestLogger resolves
// the client IP through the same proxy-aware helper the rate limiter and the
// session-IP paths use.

import (
	"bytes"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
)

// loggedRequestThroughProxy runs req through the production request-id +
// logging chain configured with proxyNets, and returns the captured log.
func loggedRequestThroughProxy(t *testing.T, req *http.Request, proxyNets []*net.IPNet) string {
	t.Helper()

	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	h := boundRequestID(middleware.RequestID(setRequestIDHeader(requestLogger(proxyNets)(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})))))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return logs.String()
}

// TestRequestLogger_TrustedProxyLogsClientIP pins SRE-11: with trusted_proxies
// set, a request carrying X-Forwarded-For logs the client IP, not the proxy's.
func TestRequestLogger_TrustedProxyLogsClientIP(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels", nil)
	req.RemoteAddr = "10.0.0.5:4321"
	req.Header.Set("X-Forwarded-For", "203.0.113.7")

	out := loggedRequestThroughProxy(t, req, parseCIDRList([]string{"10.0.0.0/8"}))

	if !strings.Contains(out, "client_ip=203.0.113.7") {
		t.Errorf("access log did not record the client IP: %q", out)
	}
	if strings.Contains(out, "client_ip=10.0.0.5") {
		t.Errorf("access log recorded the proxy's address instead of the client's: %q", out)
	}
}

// TestRequestLogger_NoTrustedProxiesLogsRemoteAddr pins that the default
// configuration is unchanged: with no trusted proxies, a client-supplied
// X-Forwarded-For must never reach the log (it would be a spoofable value).
func TestRequestLogger_NoTrustedProxiesLogsRemoteAddr(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels", nil)
	req.RemoteAddr = "203.0.113.5:4321"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")

	out := loggedRequestThroughProxy(t, req, nil)

	if !strings.Contains(out, "client_ip=203.0.113.5") {
		t.Errorf("access log did not record RemoteAddr with no trusted proxies: %q", out)
	}
	if strings.Contains(out, "client_ip=1.2.3.4") {
		t.Errorf("spoofable X-Forwarded-For reached the log with no trusted proxies: %q", out)
	}
}
