package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/diskutil"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/J3vb/OwnCord/Server/ws"
)

// StartRuntime builds the collaborators the hub and the router share,
// constructs the hub with everything it must hold before Run (HubOptions), and
// starts the dispatch goroutine. ws.NewHub refuses to construct without its
// required collaborators, so an incomplete hub is a startup error here rather
// than a later panic.
//
// The limiter and the service layer are built here, not in the router, because
// the hub needs the same instances: the limiter persists auth lockouts and the
// service layer holds the permission cache the hub invalidates, so a second
// copy of either would split that state.
//
// It also builds the AuthService (over the hub, its AuthBroadcaster, and the
// totp-key stage's key) and the Updater, takes the one storage.Storage the
// maintenance loop and the erasure replay share, and runs wireAuth (every
// service setter needing the hub or the store) before the dispatch goroutine
// starts, so no setter runs after Run and a restart never runs one twice.
// api.NewRouter only mounts.
//
// It starts the hub, so every caller must stop it: App.Close does, through the
// "hub" close step, and api's tests rely on the goleak ignore for
// ws.(*Hub).Run.func1.
func StartRuntime(cfg *config.Config, database *db.DB, pluginRegistry *plugin.Registry, in RuntimeInputs) (api.Runtime, error) {
	// Lockouts are persisted to the database so they survive restarts.
	limiter := auth.NewPersistentRateLimiter(database)
	// The one admission budget for expensive authentication work lives in the
	// limiter, so sizing it here covers every route and the hub alike.
	limiter.SetAdmissionBudget(cfg.Security.ExpensiveAuthConcurrency)
	// Service layer: business logic for REST and WS handlers.
	svc := service.New(database, limiter)
	// Before NewHub: its first settings-cache fill reads the file-type lists
	// auth_ok carries.
	svc.Uploads.SetStorageLimits(storageLimits(cfg))

	lk, proc, voiceEnabled := buildVoice(cfg)

	// WS does its own in-band auth, so no AuthMiddleware.
	hub, err := ws.NewHub(ws.HubOptions{
		DB:       database,
		Limiter:  limiter,
		Services: svc,
		Settings: svc.Settings,
		Readers:  ws.DBReaders(database),
		Voice:    svc.Voice,
		Presence: svc.Users,
		Auth:     svc.Sessions,
		// Channel-level private flag on channel frames.
		ChannelPrivacy: svc.ChannelPrivacy,
		// nil pluginRegistry means plugins are disabled; the hub no-ops.
		PluginRegistry: pluginRegistry,
		LiveKit:        lk,
		LiveKitProcess: proc,
		// Replay budget knobs land at construction; the dispatch loop reads the
		// ring unlocked.
		ReplayRingSize:  cfg.EventPersistence.ReplayRingSize,
		ReplayColdLimit: cfg.EventPersistence.ReplayColdLimit,
		// voice_join's fallback for a channel with no voice_quality override.
		// Startup-only, as the setup wizard treats voice.quality as requiring a
		// restart.
		VoiceQuality: cfg.Voice.Quality,
		// auth_ok's upload_policy: the composer's pre-check.
		UploadPolicy:    ws.UploadPolicy{MaxUploadBytes: int64(cfg.Upload.MaxSizeMB) << 20, Thumbnails: true},
		UploadFileTypes: svc.Uploads,
		// server.trusted_proxies: the handshake log and the ws_connect audit
		// row resolve the client address through it.
		TrustedProxies: cfg.Server.TrustedProxies,
	})
	if err != nil {
		return api.Runtime{}, fmt.Errorf("app: building hub: %w", err)
	}

	// The plugin event sink consumes the built hub's broadcaster, so this is
	// the two-phase wire.
	if pluginRegistry != nil {
		sink := pluginRegistry.Sink()
		sink.SetBroadcaster(hub.BroadcastToChannel)
		hub.SetPluginEventSink(sink)
	}

	// Windowed figures for /api/v1/metrics, built here and started by startHub.
	// Built before the LiveKit process starts so an error return cannot leave
	// that child running.
	writerStats, readerStats := service.PoolStatsSources(database)
	windows, err := newMetricsWindows(hub, writerStats, readerStats)
	if err != nil {
		return api.Runtime{}, err
	}

	// Start the supervised LiveKit process only once the hub holds it: the
	// voice_join guard must fail closed via IsRunning() == false the moment
	// Start fails, never see a hub with a running process it does not know of.
	if proc != nil {
		if startErr := proc.Start(); startErr != nil {
			slog.Error("failed to start LiveKit process", "error", startErr)
		}
	}

	svc.Attention = newAttention(cfg, hub, database, svc.Settings)

	authSvc := service.NewAuthService(database, limiter, in.TOTPKey, hub)
	wireAuth(svc, authSvc, in.Storage, hub)

	if beforeHubRun != nil {
		beforeHubRun(svc)
	}
	go hub.Run()
	hub.RearmTimeoutExpiries()
	// Load the active-timeout mirror up front; on failure Subject retries on
	// first use and fails closed until it succeeds.
	if err := svc.Permissions.RefreshTimeouts(context.Background()); err != nil {
		slog.Error("boot: load active timeouts", "err", err)
	}

	return api.Runtime{
		Hub: hub, Limiter: limiter, Services: svc, VoiceEnabled: voiceEnabled, MetricsWindows: windows,
		Auth: authSvc, Storage: in.Storage,
		Updater: updater.NewUpdater(in.Version, cfg.GitHub.Token, cfg.GitHub.Owner, cfg.GitHub.Repo),
	}, nil
}

// storageLimits is the two bounds on the upload service: the per-user quota
// (upload.user_quota_mb, 0 = unlimited) and the headroom floor
// (server.min_free_disk_mb) probed on the upload volume, which may not be the
// data volume /health watches; plus config.yaml's file-type lists.
func storageLimits(cfg *config.Config) service.StorageLimits {
	return service.StorageLimits{
		UserQuotaBytes: cfg.Upload.UserQuotaBytes(),
		MinFreeBytes:   cfg.Server.MinFreeDiskBytes(),
		Dir:            cfg.Upload.StorageDir,
		MaxUploadBytes: int64(cfg.Upload.MaxSizeMB) << 20,
		FileTypes:      storage.FileTypePolicy{Blocked: cfg.Upload.BlockedExtensions, Allowed: cfg.Upload.AllowedExtensions},
	}
}

// buildVoice creates the LiveKit client and, when OwnCord manages the
// companion process, the process manager; construction only, StartRuntime
// starts the process after the hub holds it. It reports whether voice is
// configured, which api.Runtime.VoiceEnabled carries to the router for the
// webhook, LiveKit health and signalling-proxy routes.
func buildVoice(cfg *config.Config) (*ws.LiveKitClient, *ws.LiveKitProcess, bool) {
	// Voice is disabled when the client cannot be created.
	lk, lkErr := ws.NewLiveKitClient(&cfg.Voice)
	if lkErr != nil {
		slog.Warn("failed to create LiveKit client, voice disabled", "error", lkErr)
		return nil, nil, false
	}

	// Optionally build a companion LiveKit process, from a configured binary
	// or a checksum-verified auto-download (in the background inside Start).
	// The hub keeps the process even if Start() later fails: its only consumer
	// is the voice_join guard (`h.lkProcess != nil && !h.lkProcess.IsRunning()`),
	// which reads a nil process as "externally managed, don't check", so a
	// failed launch must fail joins closed rather than wave them through with
	// no SFU running.
	if cfg.Voice.LiveKitBinaryPath != "" || cfg.Voice.AutoDownloadLiveKit {
		return lk, ws.NewLiveKitProcess(&cfg.Voice, &cfg.TLS, cfg.Server.DataDir), true
	}

	// No webhook warning here: the generated livekit.yaml sets no `webhook:`
	// block, so an externally managed LiveKit never calls OwnCord's webhook in
	// the shipped configuration. The gate stays on the route itself (see
	// server.livekit_webhook_allowed_cidrs in docs/server-configuration.md).
	return lk, nil, true
}

// newAttention builds the admin attention panel over counters the server
// already keeps: the data volume's free space, the writer pool's cumulative
// wait, the reconnect tiers, the hub's broadcast drops and send-queue overflow
// disconnects, and the newest backup file.
func newAttention(cfg *config.Config, hub *ws.Hub, database *db.DB, settings *service.SettingsService) *service.AttentionService {
	return service.NewAttentionService(service.AttentionThresholds{
		DiskWarnFreeBytes:     cfg.Attention.DiskWarnFreeBytes(),
		DiskCriticalFreeBytes: cfg.Server.MinFreeDiskBytes(),
		WriterWaitMsPerMin:    float64(cfg.Attention.WriterWaitMsPerMin),
		ReconnectsPerMin:      float64(cfg.Attention.ReconnectsPerMin),
		DeliveryDropsPerMin:   float64(cfg.Attention.DeliveryDropsPerMin),
	}, service.AttentionSources{
		DiskFree:   func() (uint64, error) { return diskutil.FreeBytes(cfg.Server.DataDir) },
		WriterWait: service.WriterWaitSource(database),
		Reconnects: func() uint64 {
			buffer, cold, full := hub.ReconnectTierStats()
			return buffer + cold + full
		},
		DeliveryDrops: hub.DeliveryDropCount,
		DispatchAlive: hub.DispatchAlive,
		BackupSchedule: func(ctx context.Context) (string, error) {
			return settings.Setting(ctx, "backup_schedule")
		},
		LastBackup: func() (time.Time, error) {
			return admin.NewestBackup(admin.ResolveBackupDir(cfg.Backup.Dir))
		},
		Certificate: admin.ServedCertificate,
		VoiceHealth: func(ctx context.Context) service.VoiceHealth {
			// OwnCord-managed companion: report the supervisor's own state,
			// which probes nothing. Otherwise the hub's LiveKit client is
			// external; probe its health (self-bounded), or report unconfigured.
			if hub.LiveKitManaged() {
				status := hub.LiveKitProcessStatus()
				return service.VoiceHealth{
					Managed:  true,
					Running:  status.Running,
					Restarts: status.Restarts,
					GaveUp:   status.GaveUp,
				}
			}
			if hub.URL() == "" {
				return service.VoiceHealth{}
			}
			reachable, _ := hub.LiveKitHealthCheck(ctx)
			return service.VoiceHealth{Reachable: &reachable}
		},
	})
}

// dispatchHub is the slice of *ws.Hub the hub close step drives.
type dispatchHub interface {
	GracefulStopContext(ctx context.Context, reason ws.RestartReason)
	Done() <-chan struct{}
	JoinBackground(ctx context.Context) (stragglers int)
}

// stopHub is the hub close step: GracefulStopContext, then wait for the
// dispatch goroutine to exit. GracefulStopContext only signals the loop, and on
// an early start failure the goroutine may not even have been scheduled; without
// the join, Run returned with the loop alive and Close released what it reads.
func stopHub(ctx context.Context, hub dispatchHub, reason ws.RestartReason) error {
	hub.GracefulStopContext(ctx, reason)
	var err error
	select {
	case <-hub.Done():
	case <-ctx.Done():
		err = fmt.Errorf("hub dispatch did not exit: %w", ctx.Err())
	}
	// The hub's own background jobs (a voice leave's LiveKit removal and
	// delete retries) get a short grace, then are cancelled and joined inside
	// the step's budget and before the database closes. Not part of the
	// dispatch goroutine's exit: a job may need a lock Run would hold. After a
	// dispatch timeout ctx is spent, so jobs are cancelled and counted, not
	// waited for.
	if n := hub.JoinBackground(ctx); n > 0 {
		slog.Warn("hub background jobs still running at shutdown, abandoning them", "count", n)
	}
	return err
}
