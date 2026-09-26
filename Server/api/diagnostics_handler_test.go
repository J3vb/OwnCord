package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// setupDiagnosticsRouter creates a full router with an authenticated user for
// diagnostics testing.
func setupDiagnosticsRouter(t *testing.T) (http.Handler, string, *db.DB) {
	t.Helper()

	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
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
	handler, cleanup := api.NewRouter(cfg, database, "1.0.0-test", nil, nil, rt)
	t.Cleanup(cleanup)

	// Create a user and session for authenticated requests.
	uid, _ := database.CreateUser(context.Background(), "diaguser", "$2a$12$fake", 1)
	token := "diagtest-token-123"
	hash := auth.HashToken(token)
	_, _ = database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 VALUES (?, ?, 'test', '127.0.0.1', '2099-01-01T00:00:00Z')`,
		uid, hash,
	)

	return handler, token, database
}

func TestDiagnosticsConnectivity_ReturnsData(t *testing.T) {
	router, token, _ := setupDiagnosticsRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/diagnostics/connectivity", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Verify top-level sections exist.
	for _, section := range []string{"server", "voice", "client"} {
		if _, ok := resp[section]; !ok {
			t.Errorf("missing section %q in diagnostics response", section)
		}
	}

	// Verify server section has expected fields.
	server, _ := resp["server"].(map[string]any)
	if server["version"] != "1.0.0-test" {
		t.Errorf("server.version = %v, want 1.0.0-test", server["version"])
	}
}

// TestDiagnosticsConnectivity_HonoursTrustedProxies reproduces OC-0305: behind
// a configured trusted reverse proxy, the diagnostics endpoint must report the
// real client address from X-Forwarded-For, not the proxy's own RemoteAddr —
// matching the same route's RateLimitMiddleware, which already honours
// cfg.Server.TrustedProxies.
func TestDiagnosticsConnectivity_HonoursTrustedProxies(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	cfg := &config.Config{
		Server: config.ServerConfig{
			Name:           "Test Server",
			Port:           8443,
			TrustedProxies: []string{"127.0.0.1/32"},
		},
	}

	rt, rtErr := app.StartRuntime(cfg, database, nil)
	if rtErr != nil {
		t.Fatalf("app.StartRuntime: %v", rtErr)
	}
	handler, cleanup := api.NewRouter(cfg, database, "1.0.0-test", nil, nil, rt)
	t.Cleanup(cleanup)

	uid, _ := database.CreateUser(context.Background(), "diagproxyuser", "$2a$12$fake", 1)
	token := "diagtest-proxy-token"
	hash := auth.HashToken(token)
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 VALUES (?, ?, 'test', '127.0.0.1', '2099-01-01T00:00:00Z')`,
		uid, hash,
	); err != nil {
		t.Fatalf("insert session: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/diagnostics/connectivity", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	req.RemoteAddr = "127.0.0.1:9999" // the trusted reverse proxy's own hop
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	client, _ := resp["client"].(map[string]any)
	if client["remote_addr"] != "203.0.113.9" {
		t.Errorf("client.remote_addr = %v, want 203.0.113.9 (the real client behind the trusted proxy)", client["remote_addr"])
	}
	if isPrivate, _ := client["is_private_network"].(bool); isPrivate {
		t.Errorf("client.is_private_network = true, want false for public client 203.0.113.9")
	}
}

func TestDiagnosticsConnectivity_Unauthenticated(t *testing.T) {
	router, _, _ := setupDiagnosticsRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/diagnostics/connectivity", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

// TestDiagnosticsConnectivity_MemberForbidden locks the RequirePermission gate
// on the route. Without it, only 200-for-owner and 401-unauthenticated were
// covered, so deleting the ADMINISTRATOR gate broke no test while exposing the
// server's network topology to every member.
func TestDiagnosticsConnectivity_MemberForbidden(t *testing.T) {
	router, _, database := setupDiagnosticsRouter(t)

	uid, err := database.CreateUser(context.Background(), "diagmember", "$2a$12$fake", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token := "diagtest-member-token"
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 VALUES (?, ?, 'test', '127.0.0.1', '2099-01-01T00:00:00Z')`,
		uid, auth.HashToken(token),
	); err != nil {
		t.Fatalf("insert session: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/diagnostics/connectivity", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403; body: %s", rr.Code, rr.Body.String())
	}
}

// ─── isPrivateIP tests ──────────────────────────────────────────────────────

func TestIsPrivateIP(t *testing.T) {
	tests := []struct {
		name string
		ip   string
		want bool
	}{
		{"10.x.x.x", "10.0.0.1", true},
		{"172.16.x.x", "172.16.0.1", true},
		{"172.17.x.x", "172.17.5.5", true},
		{"172.31.x.x", "172.31.255.255", true},
		{"192.168.x.x", "192.168.1.1", true},
		{"127.x.x.x", "127.0.0.1", true},
		{"::1 loopback", "::1", true},
		{"fc ULA", "fc00::1", true},
		{"fd ULA", "fd12::1", true},
		{"public 8.8.8.8", "8.8.8.8", false},
		{"public 203.x", "203.0.113.1", false},
		{"public 1.1.1.1", "1.1.1.1", false},
		{"172.32 not private", "172.32.0.1", false},
		{"empty string", "", false},

		// B6-6. The prefix-matching version could not see any of these.
		// CGNAT is the range this milestone is about, and it is also the
		// range Tailscale hands out (docs/tailscale.md:19-24) — a tailnet
		// peer was previously reported as a public-internet client.
		{"CGNAT 100.64 lower edge", "100.64.0.1", true},
		{"CGNAT mid-range", "100.100.1.1", true},
		{"CGNAT 100.127 upper edge", "100.127.255.255", true},
		{"100.128 is above the CGNAT block", "100.128.0.1", false},
		{"100.63 is below the CGNAT block", "100.63.255.255", false},
		{"IPv4 link-local", "169.254.1.1", true},
		{"IPv6 link-local", "fe80::1", true},
		{"IPv4-mapped private", "::ffff:192.168.1.1", true},
		{"IPv4-mapped CGNAT", "::ffff:100.64.1.2", true},
		{"IPv4-mapped public", "::ffff:8.8.8.8", false},
		{"not an address at all", "not-an-ip", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := api.IsPrivateIPForTest(tt.ip)
			if got != tt.want {
				t.Errorf("isPrivateIP(%q) = %v, want %v", tt.ip, got, tt.want)
			}
		})
	}
}

// ─── B6-6: the reachability block and its owner gate ────────────────────────

// diagnosticsWithConfig is setupDiagnosticsRouter with the caller's config, so
// a test can flip server.reachability_report_enabled.
func diagnosticsWithConfig(t *testing.T, cfg *config.Config) (http.Handler, string) {
	t.Helper()

	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	rt, rtErr := app.StartRuntime(cfg, database, nil)
	if rtErr != nil {
		t.Fatalf("app.StartRuntime: %v", rtErr)
	}
	handler, cleanup := api.NewRouter(cfg, database, "1.0.0-test", nil, nil, rt)
	t.Cleanup(cleanup)

	uid, _ := database.CreateUser(context.Background(), "diaguser", "$2a$12$fake", 1)
	token := "diagtest-token-123"
	_, _ = database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 VALUES (?, ?, 'test', '127.0.0.1', '2099-01-01T00:00:00Z')`,
		uid, auth.HashToken(token),
	)
	return handler, token
}

func fetchDiagnostics(t *testing.T, router http.Handler, token string) map[string]any {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/diagnostics/connectivity", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp
}

// TestDiagnosticsReportsReachabilityWhenEnabled — with the owner's opt-in set,
// the block is present and carries the honesty payload.
func TestDiagnosticsReportsReachabilityWhenEnabled(t *testing.T) {
	cfg := &config.Config{Server: config.ServerConfig{
		Name:                      "Test Server",
		Port:                      8443,
		ReachabilityReportEnabled: true,
	}}
	router, token := diagnosticsWithConfig(t, cfg)

	resp := fetchDiagnostics(t, router, token)

	block, ok := resp["reachability"].(map[string]any)
	if !ok {
		t.Fatalf("reachability block missing or not an object: %v", resp["reachability"])
	}
	for _, field := range []string{
		"listen_port", "binds_all_interfaces", "local_addresses",
		"has_global_address", "cgnat_range_present", "required_ports",
		"tls_mode", "public_ip_https_supported", "undeterminable",
	} {
		if _, present := block[field]; !present {
			t.Errorf("reachability block is missing %q", field)
		}
	}

	unknowns, _ := block["undeterminable"].([]any)
	if len(unknowns) == 0 {
		t.Error("undeterminable is empty — the report must always state its own limits")
	}
	if supported, _ := block["public_ip_https_supported"].(bool); supported {
		t.Error("public_ip_https_supported = true; no build today issues a certificate for a bare IP (B6-3 deferred)")
	}
}

// TestDiagnosticsOmitsReachabilityWhenDisabled — the key must be absent, not
// present-and-empty, so an operator cannot read "switched off" as "nothing to
// report".
func TestDiagnosticsOmitsReachabilityWhenDisabled(t *testing.T) {
	cfg := &config.Config{Server: config.ServerConfig{Name: "Test Server", Port: 8443}}
	router, token := diagnosticsWithConfig(t, cfg)

	resp := fetchDiagnostics(t, router, token)

	if _, present := resp["reachability"]; present {
		t.Errorf("reachability is present with the flag off: %v", resp["reachability"])
	}
	// The rest of the response is unaffected by the gate.
	for _, section := range []string{"server", "voice", "client"} {
		if _, ok := resp[section]; !ok {
			t.Errorf("the gate removed section %q, which it must not touch", section)
		}
	}
}

// TestDiagnosticsReportsClientAddressClass — is_private_network is a boolean
// with an ambiguous meaning for a 100.64/10 address. address_class disambiguates
// it, and is not behind the gate: it describes the caller, not this host.
func TestDiagnosticsReportsClientAddressClass(t *testing.T) {
	cfg := &config.Config{Server: config.ServerConfig{Name: "Test Server", Port: 8443}}
	router, token := diagnosticsWithConfig(t, cfg)

	resp := fetchDiagnostics(t, router, token)

	client, _ := resp["client"].(map[string]any)
	if got := client["address_class"]; got != "loopback" {
		t.Errorf("client.address_class = %v, want \"loopback\" for a 127.0.0.1 caller", got)
	}
}

// TestHealthResponseCarriesNoReachabilityFields — /health is a liveness probe
// served from a cache, and reachability is neither live-changing nor
// probe-shaped. Putting it there would make a monitoring system flap on NAT
// topology. The gate is asserted, not assumed: the flag is switched ON here,
// so a handler that leaked the block into /health would be caught.
func TestHealthResponseCarriesNoReachabilityFields(t *testing.T) {
	cfg := &config.Config{Server: config.ServerConfig{
		Name:                      "Test Server",
		Port:                      8443,
		ReachabilityReportEnabled: true,
	}}
	router, _ := diagnosticsWithConfig(t, cfg)

	for _, path := range []string{"/health", "/api/v1/health"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)

		var resp map[string]any
		if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
			t.Fatalf("%s: decode: %v", path, err)
		}
		for _, banned := range []string{"reachability", "local_addresses", "undeterminable", "address_class"} {
			if _, present := resp[banned]; present {
				t.Errorf("%s carries %q; reachability belongs behind the admin gate, not on the liveness probe", path, banned)
			}
		}
	}
}
