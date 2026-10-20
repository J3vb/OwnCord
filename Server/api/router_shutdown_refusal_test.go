package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
)

// The real router must hand Runtime.Shutdown to the admin API: with the
// signal closed, an owner's POST /admin/api/updates/apply is refused with
// 503 SHUTTING_DOWN before any outbound call. A refactor that stops NewRouter
// building its SetupOptions through adminSetupOptions would let it through
// (to a GitHub lookup instead).
func TestRouter_UpdateApplyRefusedOnceShutdownBegins(t *testing.T) {
	t.Setenv("OWNCORD_CONTAINER", "0")
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	cfg := &config.Config{Server: config.ServerConfig{Name: "Test Server", Port: 8443}}
	rt, err := app.StartRuntime(cfg, database, nil)
	if err != nil {
		t.Fatalf("app.StartRuntime: %v", err)
	}
	shutdown := make(chan struct{})
	close(shutdown)
	rt.Shutdown = shutdown
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)

	token := chTestCreateToken(t, database, "owner-shutdown", 1)
	req := httptest.NewRequest(http.MethodPost, "/admin/api/updates/apply", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	var resp map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	if rr.Code != http.StatusServiceUnavailable || resp["error"] != "SHUTTING_DOWN" {
		t.Fatalf("status = %d, body = %s; want 503 SHUTTING_DOWN", rr.Code, rr.Body.String())
	}
}
