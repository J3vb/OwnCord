package api_test

import (
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/internal/app"
)

// The real router must hand Runtime.Shutdown to the admin API: with the
// signal closed, an owner's POST /admin/api/updates/apply is refused with
// 503 SHUTTING_DOWN before any outbound call. A refactor that stops NewRouter
// building its SetupOptions through adminSetupOptions would let it through
// (to a GitHub lookup instead).
func TestRouter_UpdateApplyRefusedOnceShutdownBegins(t *testing.T) {
	t.Setenv("OWNCORD_CONTAINER", "0")
	database := openMigratedDB(t)

	cfg := &config.Config{Server: config.ServerConfig{Name: "Test Server", Port: 8443}}
	rt, err := app.StartRuntime(cfg, database, nil, testRuntimeInputs(cfg))
	if err != nil {
		t.Fatalf("app.StartRuntime: %v", err)
	}
	shutdown := make(chan struct{})
	close(shutdown)
	rt.Shutdown = shutdown
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)

	token := chTestCreateToken(t, database, "owner-shutdown", 1)
	rr := doAPI(t, handler, http.MethodPost, "/admin/api/updates/apply", token, nil)

	resp := decodeBody[map[string]string](t, rr)
	if rr.Code != http.StatusServiceUnavailable || resp["error"] != "SHUTTING_DOWN" {
		t.Fatalf("status = %d, body = %s; want 503 SHUTTING_DOWN", rr.Code, rr.Body.String())
	}
}
