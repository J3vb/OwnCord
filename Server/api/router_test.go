package api_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
	"github.com/J3vb/OwnCord/Server/ws"
)

// setupRouter creates a test router with an in-memory database.
func setupRouter(t *testing.T) http.Handler {
	t.Helper()

	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open error: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate error: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	cfg := &config.Config{
		Server: config.ServerConfig{
			Name: "Test Server",
			Port: 8443,
		},
	}

	rt, rtErr := app.StartRuntime(cfg, database, nil)
	if rtErr != nil {
		t.Fatalf("app.StartRuntime: %v", rtErr)
	}
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)
	return handler
}

func TestHealthEndpointReturns200(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("GET /health status = %d, want 200", rec.Code)
	}
}

func TestHealthEndpointReturnsJSON(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	contentType := rec.Header().Get("Content-Type")
	if !strings.Contains(contentType, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", contentType)
	}

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("response body is not valid JSON: %v", err)
	}
}

func TestHealthEndpointStatusOK(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("JSON decode error: %v", err)
	}

	if body["status"] != "ok" {
		t.Errorf("status = %v, want 'ok'", body["status"])
	}
}

func TestHealthEndpointOmitsVersion(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("JSON decode error: %v", err)
	}

	// C-2: Version must NOT be exposed on unauthenticated endpoints.
	if _, exists := body["version"]; exists {
		t.Error("health response must not contain 'version' field (prevents fingerprinting)")
	}
}

func TestAPIV1InfoEndpoint(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("GET /api/v1/info status = %d, want 200", rec.Code)
	}
}

func TestAPIV1InfoReturnsServerName(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("JSON decode error: %v", err)
	}

	if body["name"] != "Test Server" {
		t.Errorf("name = %v, want 'Test Server'", body["name"])
	}
}

func TestAPIV1InfoOmitsVersion(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("JSON decode error: %v", err)
	}

	// C-2: Version must NOT be exposed to prevent fingerprinting.
	if _, exists := body["version"]; exists {
		t.Error("info response must not contain 'version' field (prevents fingerprinting)")
	}
}

// serverInfoBody fetches GET /api/v1/server-info and decodes it, failing the
// test on any non-200 so every caller below can speak about fields alone.
func serverInfoBody(t *testing.T, router http.Handler) map[string]any {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/server-info", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/server-info status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("JSON decode error: %v", err)
	}
	return body
}

// TestAPIV1ServerInfoReturnsNameEpochAndBrowserFlag is B6-7's outcome: one
// public endpoint answers "what is this server, and is the browser client on".
func TestAPIV1ServerInfoReturnsNameEpochAndBrowserFlag(t *testing.T) {
	body := serverInfoBody(t, setupRouter(t))

	if body["name"] != "Test Server" {
		t.Errorf("name = %v, want 'Test Server'", body["name"])
	}
	// JSON numbers decode into float64 through map[string]any.
	if got, want := body["protocol_epoch"], float64(ws.ProtocolEpoch); got != want {
		t.Errorf("protocol_epoch = %v, want %v", got, want)
	}
	// setupRouter leaves browser_client_enabled at its zero value, which is
	// also the shipped default (BG-01: hosting is owner opt-in).
	if got, exists := body["browser_client_enabled"]; !exists || got != false {
		t.Errorf("browser_client_enabled = %v (present=%t), want false", got, exists)
	}
}

// TestAPIV1ServerInfoEpochTracksTheGeneratedConstant guards the one mistake
// that would pass every other test here: hard-coding the epoch. ws.ProtocolEpoch
// is generated from protocol/schema.json, so a literal would keep reporting the
// old number after the next epoch bump and silently lie to every client.
func TestAPIV1ServerInfoEpochTracksTheGeneratedConstant(t *testing.T) {
	body := serverInfoBody(t, setupRouter(t))

	epoch, ok := body["protocol_epoch"].(float64)
	if !ok {
		t.Fatalf("protocol_epoch = %v (%T), want a JSON number", body["protocol_epoch"], body["protocol_epoch"])
	}
	if int(epoch) != ws.ProtocolEpoch {
		t.Errorf("protocol_epoch = %d, want ws.ProtocolEpoch (%d) — read the generated constant, never a literal",
			int(epoch), ws.ProtocolEpoch)
	}
}

// TestAPIV1ServerInfoOmitsVersion mirrors TestAPIV1InfoOmitsVersion on the new
// route. C-2 is a property of every unauthenticated endpoint, not of one
// handler: a new public route nobody thought to lock is how the invariant
// erodes. Version stays on the admin-gated diagnostics endpoint.
func TestAPIV1ServerInfoOmitsVersion(t *testing.T) {
	body := serverInfoBody(t, setupRouter(t))

	for _, field := range []string{"version", "build", "commit", "go_version"} {
		if _, exists := body[field]; exists {
			t.Errorf("server-info response must not contain %q (C-2: prevents fingerprinting)", field)
		}
	}
}

func TestUnknownRouteReturns404(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/nonexistent", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("GET /api/v1/nonexistent status = %d, want 404", rec.Code)
	}
}

func TestRequestIDMiddleware(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	// Request ID header should be set by middleware.
	requestID := rec.Header().Get("X-Request-Id")
	if requestID == "" {
		t.Error("X-Request-Id header not set by middleware")
	}
}

func TestHealthMethodNotAllowed(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodPost, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /health status = %d, want 405", rec.Code)
	}
}

// ─── B6-6: a non-global voice.node_ip fails silently ────────────────────────

// TestWarnOnServerConfig_NonGlobalNodeIP — voice.node_ip is written straight
// into livekit.yaml, which validates it only for YAML-unsafe characters. A
// private or CGNAT value hands remote clients an ICE candidate they cannot
// route to, so the call connects and then carries no audio: the join succeeds,
// the media never arrives, and nothing says why.
//
// It warns rather than refuses. A LAN-only or tailnet-only operator has a
// legitimate reason to point node_ip at a private address, and B6-6 is about
// reporting limits honestly, not about narrowing what an owner may configure.
func TestWarnOnServerConfig_NonGlobalNodeIP(t *testing.T) {
	cases := []struct {
		name     string
		nodeIP   string
		wantWarn bool
	}{
		{"private LAN address", "192.168.1.50", true},
		{"CGNAT or tailnet address", "100.64.1.2", true},
		{"loopback", "127.0.0.1", true},
		{"link-local", "169.254.1.1", true},
		{"not an address", "chat.example.com", true},
		{"public IPv4", "93.184.216.34", false},
		{"public IPv6", "2606:4700::1111", false},
		{"unset", "", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
			t.Cleanup(func() { slog.SetDefault(prev) })

			api.WarnOnServerConfigForTest(&config.Config{
				Voice: config.VoiceConfig{LiveKitURL: "ws://localhost:7880", NodeIP: tc.nodeIP},
			})

			got := strings.Contains(buf.String(), "voice.node_ip")
			if got != tc.wantWarn {
				t.Errorf("warned = %v, want %v for node_ip %q; log:\n%s", got, tc.wantWarn, tc.nodeIP, buf.String())
			}
			if tc.wantWarn && !strings.Contains(buf.String(), "no audio") {
				t.Errorf("the warning does not name the symptom an owner will actually see:\n%s", buf.String())
			}
		})
	}
}

// TestWarnOnServerConfig_NodeIPSilentWhenVoiceIsOff — an unused key is not a
// misconfiguration, and a warning an operator cannot act on is noise.
func TestWarnOnServerConfig_NodeIPSilentWhenVoiceIsOff(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	api.WarnOnServerConfigForTest(&config.Config{
		Voice: config.VoiceConfig{NodeIP: "192.168.1.50"}, // no LiveKitURL
	})

	if strings.Contains(buf.String(), "voice.node_ip") {
		t.Errorf("warned about node_ip with voice switched off:\n%s", buf.String())
	}
}
