package api

import (
	"fmt"
	"io/fs"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/lkstats"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/sysstats"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/J3vb/OwnCord/Server/ws"
)

// Runtime holds the process-level collaborators NewRouter mounts its routes
// over. internal/app builds them (app.StartRuntime) and applies every pre-Run
// setter in one place, so the hub has a single owner.
type Runtime struct {
	// Hub is already wired and running: StartRuntime starts its dispatch
	// goroutine after the last pre-Run setter. Stopping it is the caller's job
	// (App.Close's "hub" step).
	Hub *ws.Hub
	// Limiter backs both the hub and every rate-limited route. One instance:
	// it persists auth lockouts, so a second copy would split that state.
	Limiter *auth.RateLimiter
	// Services is the shared service layer — the same instance the hub holds,
	// so the permission cache the hub invalidates is the one the handlers read.
	Services     *service.Services
	VoiceEnabled bool
	// SetupToken is required on the first-run setup request when non-empty
	// (admin.SetupOptions.SetupToken). The app generates it per start.
	SetupToken string
	LogLevel   *admin.LogLevelController
	// MetricsWindows is the sampled ring behind the metrics endpoint's "windows"
	// block. The app starts its sampler (App.startHub) and stops it before the
	// hub. Nil leaves the block out.
	MetricsWindows *metrics.Windows
	// SystemStats is the CPU and memory sampler behind the admin Dashboard's
	// health row. The app starts and stops it beside MetricsWindows. Nil
	// leaves those figures null.
	SystemStats *sysstats.Sampler
	// LiveKitStats reads LiveKit's stats page for the Dashboard's LiveKit
	// card; nil when voice.livekit_metrics_url is not set.
	LiveKitStats *lkstats.Sampler
	// Auth is the account service, built by StartRuntime over the hub (its
	// AuthBroadcaster) and shared with the erasure runner. NewRouter only mounts
	// it.
	Auth *service.AuthService
	// Storage is the one upload file store: the routes, the maintenance
	// sweep and the erasure replay all use this instance. Nil when the store
	// could not be opened (logged once by app.OpenStorage); the upload,
	// avatar and emoji routes are then not mounted.
	Storage *storage.Storage
	Updater *updater.Updater
	// WebClient is the browser client bundle the portal serves when
	// server.browser_client_enabled is on. Nil uses the one embedded
	// in this binary (webclient.Assets); tests hand in an fstest.MapFS.
	WebClient fs.FS
	Lifecycle // the app's job group and shutdown signal (setup_options.go)
}

// requireBuiltRuntime refuses a Runtime that StartRuntime did not build: the
// router only mounts, so a missing collaborator is a wiring bug to fail on at
// start-up. Storage is not checked; nil is the degraded "no file storage" state.
func requireBuiltRuntime(rt Runtime) {
	var missing []string
	if rt.Hub == nil {
		missing = append(missing, "Hub")
	}
	if rt.Limiter == nil {
		missing = append(missing, "Limiter")
	}
	if rt.Services == nil {
		missing = append(missing, "Services")
	}
	if rt.Auth == nil {
		missing = append(missing, "Auth")
	}
	if rt.Updater == nil {
		missing = append(missing, "Updater")
	}
	if len(missing) > 0 {
		panic(fmt.Sprintf("api: NewRouter needs a runtime built by app.StartRuntime; missing %v", missing))
	}
}
