package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// setupRouter creates a test router with an in-memory database.
func setupRouter(t *testing.T) http.Handler {
	t.Helper()
	return setupRouterWithServices(t, nil)
}

func setupRouterWithServices(t *testing.T, configure func(*service.Services, *db.DB)) http.Handler {
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
	if configure != nil {
		configure(rt.Services, database)
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
	if got := body["registration_mode"]; got != "invite" {
		t.Errorf("registration_mode = %v, want invite", got)
	}
	assertServerInfoRetention(t, body, 0)
}

func assertServerInfoRetention(t *testing.T, body map[string]any, days int) {
	t.Helper()
	retention, ok := body["retention"].(map[string]any)
	if !ok {
		t.Fatalf("retention = %#v, want an object", body["retention"])
	}
	if len(retention) != 1 || retention["messages_days"] != float64(days) {
		t.Errorf("retention = %#v, want only messages_days: %d", retention, days)
	}
}

func TestAPIV1ServerInfoRegistrationModes(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  string
	}{
		{"closed", "closed"},
		{"invite", "invite"},
		{"approval", "approval"},
		{"open", "open"},
		{" OPEN ", "open"},
		{"invalid", "closed"},
	} {
		t.Run(tc.value, func(t *testing.T) {
			router := setupRouterWithServices(t, func(_ *service.Services, database *db.DB) {
				if err := database.SetSetting(t.Context(), "registration_mode", tc.value); err != nil {
					t.Fatal(err)
				}
			})
			if got := serverInfoBody(t, router)["registration_mode"]; got != tc.want {
				t.Errorf("registration_mode = %v, want %s", got, tc.want)
			}
		})
	}
}

func TestAPIV1ServerInfoRetentionWindow(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  int
	}{
		{"0", 0},
		{"30", 30},
		{"3650", 3650},
		{"invalid", 0},
		{"-1", 0},
		{"3651", 0},
	} {
		t.Run(tc.value, func(t *testing.T) {
			router := setupRouterWithServices(t, func(_ *service.Services, database *db.DB) {
				if err := database.SetSetting(t.Context(), db.RetentionDaysKey, tc.value); err != nil {
					t.Fatal(err)
				}
			})
			assertServerInfoRetention(t, serverInfoBody(t, router), tc.want)
		})
	}
}

// Embed the real store so service parsing and routing are exercised, while
// counting only this endpoint's reads and injecting hard storage failures.
type serverInfoStore struct {
	*db.DB
	registrationReads atomic.Int32
	retentionReads    atomic.Int32
	registrationErr   error
	retentionErr      error
	missingMode       bool
}

func (s *serverInfoStore) GetSetting(ctx context.Context, key string) (string, error) {
	if key == "registration_mode" {
		s.registrationReads.Add(1)
		if s.registrationErr != nil {
			return "", s.registrationErr
		}
		if s.missingMode {
			return "", db.ErrNotFound
		}
	}
	return s.DB.GetSetting(ctx, key)
}

func (s *serverInfoStore) ServerRetentionDays(ctx context.Context) (int, error) {
	s.retentionReads.Add(1)
	if s.retentionErr != nil {
		return 0, s.retentionErr
	}
	return s.DB.ServerRetentionDays(ctx)
}

func (s *serverInfoStore) ListChannelRetention(context.Context) ([]db.ChannelRetention, error) {
	return nil, errors.New("server-info must not read channel overrides")
}

func setupServerInfoStore(t *testing.T, store *serverInfoStore) http.Handler {
	t.Helper()
	return setupRouterWithServices(t, func(svc *service.Services, database *db.DB) {
		store.DB = database
		svc.Settings = service.NewSettingsService(store)
		svc.Retention = service.NewRetentionService(store)
	})
}

func TestAPIV1ServerInfoMissingRegistrationMode(t *testing.T) {
	router := setupServerInfoStore(t, &serverInfoStore{missingMode: true})
	if got := serverInfoBody(t, router)["registration_mode"]; got != "invite" {
		t.Errorf("registration_mode = %v, want invite for a missing setting", got)
	}
}

func TestAPIV1ServerInfoCachesSettings(t *testing.T) {
	store := &serverInfoStore{}
	router := setupServerInfoStore(t, store)
	first := serverInfoBody(t, router)
	if err := store.SetSetting(t.Context(), "registration_mode", "open"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetSetting(t.Context(), db.RetentionDaysKey, "30"); err != nil {
		t.Fatal(err)
	}
	second := serverInfoBody(t, router)
	if second["registration_mode"] != first["registration_mode"] {
		t.Fatal("response changed within the five-second cache TTL")
	}
	assertServerInfoRetention(t, second, 0)
	if got := store.registrationReads.Load(); got != 1 {
		t.Errorf("registration reads = %d, want 1 for two requests", got)
	}
	if got := store.retentionReads.Load(); got != 1 {
		t.Errorf("retention reads = %d, want 1 for two requests", got)
	}

	time.Sleep(5 * time.Second)
	third := serverInfoBody(t, router)
	if third["registration_mode"] != "open" {
		t.Errorf("registration_mode = %v after expiry, want open", third["registration_mode"])
	}
	assertServerInfoRetention(t, third, 30)
	if store.registrationReads.Load() != 2 || store.retentionReads.Load() != 2 {
		t.Fatal("expired cache must refresh both settings exactly once")
	}
}

func TestAPIV1ServerInfoConcurrentRequestsShareCache(t *testing.T) {
	store := &serverInfoStore{}
	router := setupServerInfoStore(t, store)
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, 16)
	for range cap(responses) {
		go func() {
			<-start
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/server-info", nil))
			responses <- rec
		}()
	}
	close(start)
	for range cap(responses) {
		rec := <-responses
		if rec.Code != http.StatusOK {
			t.Errorf("concurrent request status = %d, want 200", rec.Code)
		}
	}
	if store.registrationReads.Load() != 1 || store.retentionReads.Load() != 1 {
		t.Fatal("concurrent requests must share one settings read per field")
	}
}

func TestAPIV1ServerInfoReadErrors(t *testing.T) {
	for _, field := range []string{"registration", "retention"} {
		t.Run(field, func(t *testing.T) {
			store := &serverInfoStore{}
			readErr := errors.New("private storage failure")
			if field == "registration" {
				store.registrationErr = readErr
			} else {
				store.retentionErr = readErr
			}
			router := setupServerInfoStore(t, store)
			for range 2 {
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/server-info", nil))
				if rec.Code != http.StatusInternalServerError {
					t.Fatalf("status = %d, want 500", rec.Code)
				}
				if strings.Contains(rec.Body.String(), readErr.Error()) {
					t.Fatal("public error response leaked storage details")
				}
			}
			if got := store.registrationReads.Load(); got != 1 {
				t.Errorf("registration reads = %d, want 1 even on failure", got)
			}
			if field == "retention" && store.retentionReads.Load() != 1 {
				t.Error("retention failure was not cached")
			}
		})
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

// TestAPIV1ServerInfoIsCached locks the amplification guard on the new public
// route: it is unauthenticated and rate-limit-exempt, and the client preflight
// calls it for every profile every 15 s, so the handler must serve the
// derived response from a 5 s cache (the healthCacheTTL precedent) rather than
// re-reading the config per request.
func TestAPIV1ServerInfoIsCached(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open error: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate error: %v", err)
	}
	// cfg is ours, so mutating it between calls proves whether the handler
	// re-derives the response or serves the cached one.
	cfg := &config.Config{Server: config.ServerConfig{Name: "First Name", Port: 8443}}
	rt, rtErr := app.StartRuntime(cfg, database, nil)
	if rtErr != nil {
		t.Fatalf("app.StartRuntime: %v", rtErr)
	}
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)

	first := serverInfoBody(t, handler)
	if first["name"] != "First Name" {
		t.Fatalf("first call name = %v, want 'First Name'", first["name"])
	}

	// Rename behind the handler's back; a 5 s cache must still serve the first.
	cfg.Server.Name = "Renamed Server"
	second := serverInfoBody(t, handler)
	if second["name"] != "First Name" {
		t.Errorf("second call within the TTL returned %v; the handler re-read cfg instead of serving the cache",
			second["name"])
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

// TestReachabilityWarningsAreNotGatedByTheFlag pins how far
// server.reachability_report_enabled reaches.
//
// The owner's decision was that the detailed interface enumeration is opt-in.
// The honest reporting is not: a limit that only surfaces once someone finds a
// config key is not "reported actionably", which is the milestone's outcome.
// So the flag gates the diagnostics block and nothing else — the startup
// warnings fire with it off, and the banner's address qualifier does not take
// the config at all. A later edit that moves either behind the flag fails here.
func TestReachabilityWarningsAreNotGatedByTheFlag(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	api.WarnOnServerConfigForTest(&config.Config{
		Server: config.ServerConfig{ReachabilityReportEnabled: false},
		Voice:  config.VoiceConfig{LiveKitURL: "ws://localhost:7880", NodeIP: "192.168.1.50"},
	})

	if !strings.Contains(buf.String(), "voice.node_ip") {
		t.Errorf("the node_ip warning was silenced by the report flag being off:\n%s", buf.String())
	}
}

// TestWarnOnServerConfig_AdminPeerAddress pins the start-up warning for an
// admin perimeter that would compare a relay's address: trusted_proxies empty
// with TLS off (a terminating proxy in front) or inside a container. It fires
// only while admin_allowed_cidrs still admits the loopback or bridge range,
// so a narrowed allowlist that excludes those peers must stay silent.
func TestWarnOnServerConfig_AdminPeerAddress(t *testing.T) {
	cases := []struct {
		name      string
		tlsMode   string
		container string
		trusted   []string
		allowed   []string
		wantWarn  bool
	}{
		{"tls off, no trusted proxies", "off", "0", nil, []string{"127.0.0.0/8"}, true},
		{"container, no trusted proxies", "self_signed", "1", nil, []string{"172.16.0.0/12"}, true},
		{"trusted proxies set", "off", "1", []string{"127.0.0.1/32"}, []string{"127.0.0.0/8"}, false},
		{"direct TLS on the host", "self_signed", "0", nil, []string{"127.0.0.0/8"}, false},
		{"perimeter disabled", "off", "1", nil, nil, false},
		// The owner narrowed the allowlist so no relay address is admitted;
		// the warning's own suggested fix must silence it.
		{"narrowed allowlist, loopback excluded", "off", "1", nil, []string{"192.168.1.10/32"}, false},
		{"narrowed allowlist, bridge excluded", "off", "1", nil, []string{"10.0.0.0/8"}, false},
		// A broader prefix that still overlaps the relay ranges keeps the
		// warning, because the relay is still admitted.
		{"catch-all allowlist still warns", "off", "0", nil, []string{"0.0.0.0/0"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OWNCORD_CONTAINER", tc.container)
			var buf bytes.Buffer
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
			t.Cleanup(func() { slog.SetDefault(prev) })

			api.WarnOnServerConfigForTest(&config.Config{
				Server: config.ServerConfig{TrustedProxies: tc.trusted, AdminAllowedCIDRs: tc.allowed},
				TLS:    config.TLSConfig{Mode: tc.tlsMode},
			})

			if got := strings.Contains(buf.String(), "trusted_proxies is empty"); got != tc.wantWarn {
				t.Errorf("warned = %v, want %v; log:\n%s", got, tc.wantWarn, buf.String())
			}
		})
	}
}
