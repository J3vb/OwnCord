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

	rt := app.StartRuntime(cfg, database, nil)
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

	rt := app.StartRuntime(cfg, database, nil)
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
