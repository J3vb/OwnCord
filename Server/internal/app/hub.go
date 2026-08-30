package app

import (
	"log/slog"
	"net/url"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// StartRuntime builds the collaborators the hub and the router share, applies
// every pre-Run hub setter, and starts the hub's dispatch goroutine.
//
// Before B3-3 this lived inside api.NewRouter (the ws.NewHub call at
// router.go:106 and the plugin and LiveKit setters at :325-360), while
// main.go set the event persister and the event store after NewRouter
// returned — two owners of one hub, with nothing checking that the required
// collaborators were present before Run started. There is one owner now, and
// one place B3-4 has to change when the required setters become validated
// constructor options.
//
// The limiter and the service layer are built here rather than in the router
// because the hub needs the SAME instances: the limiter persists auth
// lockouts and the service layer holds the permission cache the hub
// invalidates, so a second copy of either would silently split that state.
//
// It starts the hub, so every caller must stop it — App.Close does, through
// the "hub" close step; api's tests rely on the goleak ignore for
// ws.(*Hub).Run.func1 exactly as they did when NewRouter started it.
func StartRuntime(cfg *config.Config, database *db.DB, pluginRegistry *plugin.Registry) api.Runtime {
	// Lockouts are persisted to the database so they survive restarts (M2).
	limiter := auth.NewPersistentRateLimiter(database)
	// Service layer — centralises business logic for REST and WS handlers.
	// *db.DB satisfies service.Store directly.
	svc := service.New(database, limiter)

	// WebSocket hub — WS does its own in-band auth, so no AuthMiddleware.
	hub := ws.NewHub(database, limiter, svc)
	// Replay budget knobs must land before hub.Run starts (below).
	hub.ConfigureReplay(cfg.EventPersistence.ReplayRingSize, cfg.EventPersistence.ReplayColdLimit)

	wirePlugins(hub, pluginRegistry)
	voiceEnabled := startVoice(cfg, hub)

	go hub.Run()

	return api.Runtime{Hub: hub, Limiter: limiter, Services: svc, VoiceEnabled: voiceEnabled}
}

// wirePlugins wires the plugin registry and its event sink into the hub.
// Moved from api.routerPluginWiring.
func wirePlugins(hub *ws.Hub, pluginRegistry *plugin.Registry) {
	// Phase C Step 9 — wire plugin registry and event sink into the hub.
	// nil pluginRegistry means plugins are disabled; the hub no-ops cleanly.
	if pluginRegistry != nil {
		hub.SetPluginRegistry(pluginRegistry)
		sink := pluginRegistry.Sink()
		sink.SetBroadcaster(hub.BroadcastToChannel)
		hub.SetPluginEventSink(sink)
	}
}

// startVoice creates the LiveKit client and, when OwnCord manages the
// companion process, starts it — the construction half of what
// api.routerVoiceRoutes did before B3-3. It reports whether voice is
// configured; the webhook, LiveKit health and signalling-proxy routes are
// still mounted by the router, on exactly that condition (the `lkErr == nil`
// guard, now api.Runtime.VoiceEnabled).
func startVoice(cfg *config.Config, hub *ws.Hub) bool {
	// Create LiveKit client if voice config is present; voice is disabled on failure.
	lk, lkErr := ws.NewLiveKitClient(&cfg.Voice)
	if lkErr != nil {
		slog.Warn("failed to create LiveKit client, voice disabled", "error", lkErr)
		return false
	}
	hub.SetLiveKit(lk)

	// Optionally start a companion LiveKit process — either from a
	// configured binary or via checksum-verified auto-download (the
	// download happens in the background inside Start).
	if cfg.Voice.LiveKitBinaryPath != "" || cfg.Voice.AutoDownloadLiveKit {
		proc := ws.NewLiveKitProcess(&cfg.Voice, &cfg.TLS, cfg.Server.DataDir)
		// Register the process with the hub BEFORE calling Start(), and
		// keep it registered even if Start() fails (OC-0019). The only
		// consumer of h.lkProcess is the voice_join guard
		// (`h.lkProcess != nil && !h.lkProcess.IsRunning()`), which reads
		// a nil process as "LiveKit is externally managed, don't check".
		// That is the wrong reading here: OwnCord was told to manage
		// LiveKit and failed to launch it, so joins must fail closed via
		// IsRunning() == false, not be waved through with no SFU
		// running. IsRunning() is false for a proc whose Start() never
		// got as far as spawning cmd, and Hub.Stop's lkProcess.Stop() is
		// safe to call on a never-started proc.
		hub.SetLiveKitProcess(proc)
		if startErr := proc.Start(); startErr != nil {
			slog.Error("failed to start LiveKit process", "error", startErr)
		}
		return true
	}

	// Warn if LiveKit is externally managed and webhook may be blocked by admin CIDRs.
	lkHost := ""
	if u, parseErr := url.Parse(cfg.Voice.LiveKitURL); parseErr == nil {
		lkHost = u.Hostname()
	}
	if lkHost != "" && lkHost != "localhost" && lkHost != "127.0.0.1" && lkHost != "::1" {
		slog.Warn("LiveKit is externally managed but webhook endpoint is admin-IP-restricted — "+
			"add the LiveKit server's IP to livekit_webhook_allowed_cidrs or webhooks will be silently dropped",
			"livekit_host", lkHost)
	}
	return true
}
