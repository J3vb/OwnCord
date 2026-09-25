package api_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
)

// TestSetupRequiresTokenFromAdmittedPeers pins the first-run setup token on
// the production router. With trusted_proxies empty the admin perimeter
// compares the connecting address, so a request relayed by a same-host
// reverse proxy (127.0.0.1) or a container bridge gateway (172.x) is inside
// the default admin_allowed_cidrs whatever client it carries. The perimeter
// alone therefore cannot decide who creates the owner account; the token
// printed at start-up does.
func TestSetupRequiresTokenFromAdmittedPeers(t *testing.T) {
	const token = "test-setup-token"
	peers := []string{"127.0.0.1:40000", "172.18.0.1:40000", "[::1]:40000"}

	for _, peer := range peers {
		t.Run(peer, func(t *testing.T) {
			router := setupTokenRouter(t, token)

			post := func(body string) int {
				req := httptest.NewRequest(http.MethodPost, "/admin/api/setup", strings.NewReader(body))
				req.RemoteAddr = peer
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-Forwarded-For", "203.0.113.9")
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)
				return rec.Code
			}

			const creds = `"username":"owner","password":"OwnerPass1!x"`
			if code := post(`{` + creds + `}`); code != http.StatusForbidden {
				t.Fatalf("setup without a token: status %d, want 403", code)
			}
			if code := post(`{` + creds + `,"setup_token":"wrong"}`); code != http.StatusForbidden {
				t.Fatalf("setup with a wrong token: status %d, want 403", code)
			}
			if code := post(`{` + creds + `,"setup_token":"` + token + `"}`); code != http.StatusCreated {
				t.Fatalf("setup with the start-up token: status %d, want 201", code)
			}
		})
	}
}

func setupTokenRouter(t *testing.T, token string) http.Handler {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	// The compiled admin_allowed_cidrs default, with trusted_proxies empty.
	cfg := &config.Config{Server: config.ServerConfig{
		Name: "Test Server",
		Port: 8443,
		AdminAllowedCIDRs: []string{
			"127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7",
		},
	}}
	rt, err := app.StartRuntime(cfg, database, nil)
	if err != nil {
		t.Fatalf("app.StartRuntime: %v", err)
	}
	rt.SetupToken = token
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)
	return handler
}
