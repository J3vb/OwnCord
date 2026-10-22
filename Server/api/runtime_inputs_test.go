package api_test

import (
	"log/slog"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/internal/app"
)

// testRuntimeInputs is what a test that calls app.StartRuntime directly hands
// it: the version the updater reports and the one upload store (WP 5.6g). No
// TOTP key — these tests never touch TOTP crypto through the router.
func testRuntimeInputs(cfg *config.Config) app.RuntimeInputs {
	return app.RuntimeInputs{Version: "test", Storage: app.OpenStorage(slog.Default(), cfg)}
}
