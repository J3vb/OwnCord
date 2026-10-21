package api_test

import (
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
)

// TestNewRouter_ConstructsNothing pins WP 5.6g: NewRouter only mounts. A
// Runtime that StartRuntime did not build (no Auth, no Updater) is a start-up
// panic naming what is missing, not something the router quietly builds for
// itself. This also replaces the retired routerTOTPKey fallback tests: a
// malformed OWNCORD_TOTP_KEY is now refused by the totp-key stage
// (internal/app TestApp_MalformedTOTPKeyFailsNamedStage), before any router.
func TestNewRouter_ConstructsNothing(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	cfg := &config.Config{Server: config.ServerConfig{Name: "Test Server", Port: 8443}}

	rt, err := app.StartRuntime(cfg, database, nil, testRuntimeInputs(cfg))
	if err != nil {
		t.Fatalf("app.StartRuntime: %v", err)
	}
	defer rt.Hub.GracefulStop()

	for name, strip := range map[string]func(*api.Runtime){
		"Auth":    func(r *api.Runtime) { r.Auth = nil },
		"Updater": func(r *api.Runtime) { r.Updater = nil },
	} {
		t.Run(name, func(t *testing.T) {
			broken := rt
			strip(&broken)
			defer func() {
				got := recover()
				if got == nil {
					t.Fatalf("NewRouter built its own %s instead of failing", name)
				}
				if msg, _ := got.(string); !strings.Contains(msg, name) {
					t.Fatalf("panic = %v, want it to name %s", got, name)
				}
			}()
			api.NewRouter(cfg, database, "test", nil, nil, broken)
		})
	}
}
