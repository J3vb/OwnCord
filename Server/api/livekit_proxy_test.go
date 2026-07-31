package api

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- isWebSocketUpgrade tests ---

func TestIsWebSocketUpgrade_ValidUpgrade(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Upgrade", "websocket")
	if !isWebSocketUpgrade(r) {
		t.Error("expected true for valid WebSocket upgrade")
	}
}

func TestIsWebSocketUpgrade_CaseInsensitive(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Connection", "upgrade")
	r.Header.Set("Upgrade", "WebSocket")
	if !isWebSocketUpgrade(r) {
		t.Error("expected true for case-insensitive upgrade headers")
	}
}

func TestIsWebSocketUpgrade_MissingConnectionHeader(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Upgrade", "websocket")
	if isWebSocketUpgrade(r) {
		t.Error("expected false when Connection header is missing")
	}
}

func TestIsWebSocketUpgrade_MissingUpgradeHeader(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Connection", "Upgrade")
	if isWebSocketUpgrade(r) {
		t.Error("expected false when Upgrade header is missing")
	}
}

func TestIsWebSocketUpgrade_NonWebsocketUpgrade(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Upgrade", "h2c")
	if isWebSocketUpgrade(r) {
		t.Error("expected false for non-websocket upgrade")
	}
}

func TestIsWebSocketUpgrade_ConnectionKeepAlive(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Connection", "keep-alive")
	r.Header.Set("Upgrade", "websocket")
	if isWebSocketUpgrade(r) {
		t.Error("expected false when Connection is keep-alive")
	}
}

// --- isOriginAllowed tests ---

func TestIsOriginAllowed_EmptyOriginAllowed(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	// No Origin header = same-origin or non-browser
	if !isOriginAllowed(r, []string{"https://example.com"}) {
		t.Error("expected true when no Origin header (same-origin)")
	}
}

func TestIsOriginAllowed_MatchingOrigin(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Origin", "https://example.com")
	if !isOriginAllowed(r, []string{"https://example.com"}) {
		t.Error("expected true for matching origin")
	}
}

func TestIsOriginAllowed_CaseInsensitive(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Origin", "HTTPS://EXAMPLE.COM")
	if !isOriginAllowed(r, []string{"https://example.com"}) {
		t.Error("expected true for case-insensitive origin match")
	}
}

func TestIsOriginAllowed_NonMatchingOrigin(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Origin", "https://evil.com")
	if isOriginAllowed(r, []string{"https://example.com"}) {
		t.Error("expected false for non-matching origin")
	}
}

func TestIsOriginAllowed_WildcardAllowsAll(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Origin", "https://anything.com")
	if !isOriginAllowed(r, []string{"*"}) {
		t.Error("expected true for wildcard origin")
	}
}

func TestIsOriginAllowed_EmptyAllowlistDenies(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Origin", "https://example.com")
	if isOriginAllowed(r, []string{}) {
		t.Error("expected false when allowlist is empty")
	}
}

func TestIsOriginAllowed_MultipleAllowedOrigins(t *testing.T) {
	r := httptest.NewRequest("GET", "/livekit/", nil)
	r.Header.Set("Origin", "https://b.com")
	allowed := []string{"https://a.com", "https://b.com", "https://c.com"}
	if !isOriginAllowed(r, allowed) {
		t.Error("expected true for origin in multi-origin allowlist")
	}
}

// The desktop client's webview issues LiveKit signal/validate requests
// directly (not via its Origin-stripping Rust proxy), so its fixed origins
// must pass even on the default empty allowlist — otherwise voice 403s on
// every fresh install for any client not on the server machine.
func TestIsOriginAllowed_FirstPartyDesktopOrigins(t *testing.T) {
	for _, origin := range []string{
		"http://tauri.localhost",  // WebView2 (Windows)
		"https://tauri.localhost", // WebView2, https variant
		"tauri://localhost",       // WKWebView / WebKitGTK (macOS, Linux)
		"HTTP://TAURI.LOCALHOST",  // case-insensitive
	} {
		r := httptest.NewRequest("GET", "/livekit/", nil)
		r.Header.Set("Origin", origin)
		if !isOriginAllowed(r, nil) {
			t.Errorf("expected true for first-party desktop origin %q with empty allowlist", origin)
		}
	}
}

// A lookalike origin must NOT ride along with the first-party allowance.
func TestIsOriginAllowed_FirstPartyLookalikesDenied(t *testing.T) {
	for _, origin := range []string{
		"http://tauri.localhost.evil.com",
		"http://eviltauri.localhost",
		"http://tauri.localhost:8080",
		"tauri://evil",
	} {
		r := httptest.NewRequest("GET", "/livekit/", nil)
		r.Header.Set("Origin", origin)
		if isOriginAllowed(r, nil) {
			t.Errorf("expected false for lookalike origin %q", origin)
		}
	}
}

// --- NewLiveKitProxy HTTP routing tests ---

func TestLiveKitProxy_BlocksAdminPath(t *testing.T) {
	proxy := NewLiveKitProxy("http://localhost:7880", []string{"*"})
	r := httptest.NewRequest("GET", "/admin/dashboard", nil)
	w := httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for /admin path, got %d", w.Code)
	}
}

func TestLiveKitProxy_BlocksMetricsPath(t *testing.T) {
	proxy := NewLiveKitProxy("http://localhost:7880", []string{"*"})
	r := httptest.NewRequest("GET", "/metrics", nil)
	w := httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for /metrics path, got %d", w.Code)
	}
}

func TestLiveKitProxy_BlocksDebugPath(t *testing.T) {
	proxy := NewLiveKitProxy("http://localhost:7880", []string{"*"})
	r := httptest.NewRequest("GET", "/debug/pprof", nil)
	w := httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for /debug path, got %d", w.Code)
	}
}

func TestLiveKitProxy_BlocksTwirpPath(t *testing.T) {
	proxy := NewLiveKitProxy("http://localhost:7880", []string{"*"})
	r := httptest.NewRequest("POST", "/twirp/livekit.RoomService/ListRooms", nil)
	w := httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for /twirp path, got %d", w.Code)
	}
}

func TestLiveKitProxy_AllowsNormalPath(t *testing.T) {
	// Use a test backend that returns 200
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK")) //nolint:errcheck
	}))
	defer backend.Close()

	proxy := NewLiveKitProxy(backend.URL, []string{"*"})
	r := httptest.NewRequest("GET", "/rtc", nil)
	w := httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for normal path, got %d", w.Code)
	}
}

func TestLiveKitProxy_BlocksCrossOriginHTTP(t *testing.T) {
	proxy := NewLiveKitProxy("http://localhost:7880", []string{"https://myapp.com"})
	r := httptest.NewRequest("GET", "/rtc", nil)
	r.Header.Set("Origin", "https://evil.com")
	w := httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for cross-origin HTTP, got %d", w.Code)
	}
}

func TestLiveKitProxy_AllowsSameOriginHTTP(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	proxy := NewLiveKitProxy(backend.URL, []string{"https://myapp.com"})
	r := httptest.NewRequest("GET", "/rtc", nil)
	r.Header.Set("Origin", "https://myapp.com")
	w := httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for same-origin HTTP, got %d", w.Code)
	}
}

func TestLiveKitProxy_DoesNotBlockUserMetrics(t *testing.T) {
	// "/user-metrics" should NOT be blocked (only "/metrics" segment is blocked)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	proxy := NewLiveKitProxy(backend.URL, []string{"*"})
	r := httptest.NewRequest("GET", "/user-metrics", nil)
	w := httptest.NewRecorder()
	proxy.ServeHTTP(w, r)
	// The path is split by "/" — "user-metrics" is one segment, not "metrics"
	// Wait — actually the blocked check splits by "/" and checks each segment.
	// "/user-metrics" splits to ["", "user-metrics"] so "user-metrics" != "metrics". Should pass.
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for /user-metrics (not an exact segment match), got %d", w.Code)
	}
}

// TestProxyWebSocket_DialFailureDoesNotLogAccessToken locks the credential out
// of the log stream: websocket.Dial wraps a *url.Error carrying the full
// backend URL, so a dial failure (LiveKit down, restarting, refused) used to
// print the caller's live room-join JWT at Warn level — replayable inside its
// 5-minute TTL by anyone reading stdout or the admin panel's log ring buffer.
func TestProxyWebSocket_DialFailureDoesNotLogAccessToken(t *testing.T) {
	const token = "eyJhbGciOiJIUzI1NiJ9.SECRET-LIVEKIT-JWT-PAYLOAD.c2lnbmF0dXJl"

	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	// Port 1 on loopback refuses connections, which is the exact branch where
	// the wrapped *url.Error carries the query string.
	proxy := NewLiveKitProxy("http://127.0.0.1:1", []string{"*"})
	r := httptest.NewRequest("GET", "/rtc?access_token="+token, nil)
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Upgrade", "websocket")
	w := httptest.NewRecorder()
	proxy.ServeHTTP(w, r)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when the backend refuses the dial, got %d", w.Code)
	}
	out := logs.String()
	if out == "" {
		t.Fatal("expected the dial failure to be logged at all")
	}
	if strings.Contains(out, token) {
		t.Fatalf("the LiveKit access token leaked into the log stream:\n%s", out)
	}
	if !strings.Contains(out, "backend dial failed") {
		t.Errorf("the failure must still be diagnosable, got:\n%s", out)
	}
}

func TestLiveKitProxy_InvalidURL_FallsBackToLocalhost(t *testing.T) {
	// Should not panic with invalid URL
	proxy := NewLiveKitProxy("://invalid", []string{"*"})
	r := httptest.NewRequest("GET", "/rtc", nil)
	w := httptest.NewRecorder()
	// This will fail to connect to localhost:7880, but should not panic
	proxy.ServeHTTP(w, r)
	// We expect a 502 or similar because localhost:7880 isn't running
	if w.Code == http.StatusOK {
		t.Error("expected non-200 for invalid backend URL fallback")
	}
}
