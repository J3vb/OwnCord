package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

// setupDiagnosticsRouter creates a full router with an authenticated user for
// diagnostics testing.
func setupDiagnosticsRouter(t *testing.T) (http.Handler, string) {
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

	handler, _, cleanup := api.NewRouter(cfg, database, "1.0.0-test", nil)
	t.Cleanup(cleanup)

	// Create a user and session for authenticated requests.
	uid, _ := database.CreateUser("diaguser", "$2a$12$fake", 1)
	token := "diagtest-token-123"
	hash := auth.HashToken(token)
	_, _ = database.Exec(
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 VALUES (?, ?, 'test', '127.0.0.1', '2099-01-01T00:00:00Z')`,
		uid, hash,
	)

	return handler, token
}

func TestDiagnosticsConnectivity_ReturnsData(t *testing.T) {
	router, token := setupDiagnosticsRouter(t)

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

func TestDiagnosticsConnectivity_Unauthenticated(t *testing.T) {
	router, _ := setupDiagnosticsRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/diagnostics/connectivity", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
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
