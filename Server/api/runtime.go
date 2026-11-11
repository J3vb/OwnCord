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

// Runtime holds the process-level collaborators NewRouter mounts its routes over; internal/app builds them
// (app.StartRuntime), so the hub has a single owner.
type Runtime struct {
	// Already wired and running; stopping it is the caller's job (App.Close's "hub" step).
	Hub *ws.Hub
	// Backs both the hub and every rate-limited route; one instance, since it persists auth lockouts.
	Limiter *auth.RateLimiter
	// The shared service layer, the same instance the hub holds, so the permission cache the hub invalidates
	// is the one handlers read.
	Services     *service.Services
	VoiceEnabled bool
	// Required on the first-run setup request when non-empty (admin.SetupOptions.SetupToken); generated per
	// start.
	SetupToken string
	LogLevel   *admin.LogLevelController
	// The sampled ring behind the metrics "windows" block; the app starts its sampler and stops it before the
	// hub. Nil leaves the block out.
	MetricsWindows *metrics.Windows
	// The CPU and memory sampler behind the admin Dashboard's health row; nil leaves those figures null.
	SystemStats *sysstats.Sampler
	// Reads LiveKit's stats page for the Dashboard card; nil when voice.livekit_metrics_url is unset.
	LiveKitStats *lkstats.Sampler
	// The account service, built by StartRuntime over the hub and shared with the erasure runner; NewRouter
	// only mounts it.
	Auth *service.AuthService
	// The one upload file store, shared by routes, the maintenance sweep and erasure replay. Nil when it
	// could not be opened; the upload, avatar and emoji routes are then not mounted.
	Storage *storage.Storage
	Updater *updater.Updater
	// The browser client bundle served when server.browser_client_enabled is on; nil uses the embedded one,
	// tests pass an fstest.MapFS.
	WebClient fs.FS
	Lifecycle // the app's job group and shutdown signal (setup_options.go)
}

// requireBuiltRuntime refuses a Runtime StartRuntime did not build: a missing collaborator is a wiring bug
// to fail on at start-up. Storage is not checked; nil is the degraded "no file storage" state.
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
