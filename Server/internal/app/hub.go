package app

import (
	"fmt"
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

// StartRuntime builds the collaborators the hub and the router share,
// constructs the hub with everything it must hold before Run (B3-4:
// HubOptions replaced the pre-Run setters), and starts the dispatch
// goroutine.
//
// Before B3-3 this lived inside api.NewRouter, while main.go set the event
// persister and store after NewRouter returned — two owners of one hub, with
// nothing checking that the required collaborators were present before Run
// started. B3-3 collapsed the owners to one; B3-4 moved the pre-Run wiring
// into ws.NewHub itself, which now refuses to construct without its required
// collaborators, so an incomplete hub is a startup error here rather than a
// later panic.
//
// The limiter and the service layer are built here rather than in the router
// because the hub needs the SAME instances: the limiter persists auth
// lockouts and the service layer holds the permission cache the hub
// invalidates, so a second copy of either would silently split that state.
//
// It starts the hub, so every caller must stop it — App.Close does, through
// the "hub" close step; api's tests rely on the goleak ignore for
// ws.(*Hub).Run.func1 exactly as they did when NewRouter started it.
func StartRuntime(cfg *config.Config, database *db.DB, pluginRegistry *plugin.Registry) (api.Runtime, error) {
	// Lockouts are persisted to the database so they survive restarts (M2).
	limiter := auth.NewPersistentRateLimiter(database)
	// Service layer — centralises business logic for REST and WS handlers.
	// *db.DB satisfies service.Store directly.
	svc := service.New(database, limiter)

	lk, proc, voiceEnabled := buildVoice(cfg)

	// WebSocket hub — WS does its own in-band auth, so no AuthMiddleware.
	hub, err := ws.NewHub(ws.HubOptions{
		DB:       database,
		Limiter:  limiter,
		Services: svc,
		Settings: svc.Settings,
		Readers:  ws.DBReaders(database),
		Voice:    svc.Voice,
		// nil pluginRegistry means plugins are disabled; the hub no-ops.
		PluginRegistry: pluginRegistry,
		LiveKit:        lk,
		LiveKitProcess: proc,
		// Replay budget knobs land at construction — the dispatch loop
		// reads the ring unlocked.
		ReplayRingSize:  cfg.EventPersistence.ReplayRingSize,
		ReplayColdLimit: cfg.EventPersistence.ReplayColdLimit,
	})
	if err != nil {
		return api.Runtime{}, fmt.Errorf("app: building hub: %w", err)
	}

	// The plugin event sink consumes the built hub's broadcaster, so it is
	// the surviving two-phase wire (moved from api.routerPluginWiring).
	if pluginRegistry != nil {
		sink := pluginRegistry.Sink()
		sink.SetBroadcaster(hub.BroadcastToChannel)
		hub.SetPluginEventSink(sink)
	}

	// Start the supervised LiveKit process only once the hub holds it
	// (OC-0019): the voice_join guard must be able to fail closed via
	// IsRunning() == false the moment Start fails, never see a half-wired
	// hub with a running process it does not know about.
	if proc != nil {
		if startErr := proc.Start(); startErr != nil {
			slog.Error("failed to start LiveKit process", "error", startErr)
		}
	}

	go hub.Run()

	return api.Runtime{Hub: hub, Limiter: limiter, Services: svc, VoiceEnabled: voiceEnabled}, nil
}

// buildVoice creates the LiveKit client and, when OwnCord manages the
// companion process, the process manager — construction only; StartRuntime
// starts the process after the hub holds it. It reports whether voice is
// configured; the webhook, LiveKit health and signalling-proxy routes are
// still mounted by the router on exactly that condition (the `lkErr == nil`
// guard, now api.Runtime.VoiceEnabled).
func buildVoice(cfg *config.Config) (*ws.LiveKitClient, *ws.LiveKitProcess, bool) {
	// Create LiveKit client if voice config is present; voice is disabled on failure.
	lk, lkErr := ws.NewLiveKitClient(&cfg.Voice)
	if lkErr != nil {
		slog.Warn("failed to create LiveKit client, voice disabled", "error", lkErr)
		return nil, nil, false
	}

	// Optionally build a companion LiveKit process — either from a
	// configured binary or via checksum-verified auto-download (the
	// download happens in the background inside Start). The hub keeps the
	// process even if Start() later fails (OC-0019): its only hub consumer
	// is the voice_join guard (`h.lkProcess != nil && !h.lkProcess.IsRunning()`),
	// which reads a nil process as "LiveKit is externally managed, don't
	// check". OwnCord being told to manage LiveKit and failing to launch it
	// must fail joins closed via IsRunning() == false, not wave them
	// through with no SFU running.
	if cfg.Voice.LiveKitBinaryPath != "" || cfg.Voice.AutoDownloadLiveKit {
		return lk, ws.NewLiveKitProcess(&cfg.Voice, &cfg.TLS, cfg.Server.DataDir), true
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
	return lk, nil, true
}
