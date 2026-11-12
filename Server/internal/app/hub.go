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
	"github.com/J3vb/OwnCord/Server/livekitproc"
	"github.com/J3vb/OwnCord/Server/lkstats"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/sysstats"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/J3vb/OwnCord/Server/ws"
)

// StartRuntime builds the collaborators the hub and the router share,
// constructs the hub with everything it must hold before Run, and starts the
// dispatch goroutine; an incomplete hub is a startup error here, not a later
// panic. The limiter and services are built here because the hub needs the same instances (one lockout and
// permission-cache state). wireAuth runs before the dispatch goroutine. It starts the hub: callers must
// stop it.
func StartRuntime(cfg *config.Config, database *db.DB, pluginRegistry *plugin.Registry, in RuntimeInputs) (api.Runtime, error) {
	limiter := auth.NewPersistentRateLimiter(database)
	limiter.SetAdmissionBudget(cfg.Security.ExpensiveAuthConcurrency)
	svc := service.New(database, limiter)
	// Before NewHub: its first settings-cache fill reads the file-type lists auth_ok carries.
	svc.Uploads.SetStorageLimits(storageLimits(cfg))

	lk, proc, voiceEnabled := buildVoice(cfg)

	hub, err := ws.NewHub(ws.HubOptions{
		DB:              database,
		Limiter:         limiter,
		Services:        svc,
		Settings:        svc.Settings,
		Readers:         ws.DBReaders(database),
		Voice:           svc.Voice,
		Presence:        svc.Users,
		Auth:            svc.Sessions,
		ChannelPrivacy:  svc.ChannelPrivacy,
		PluginRegistry:  pluginRegistry,
		LiveKit:         lk,
		LiveKitProcess:  proc,
		ReplayRingSize:  cfg.EventPersistence.ReplayRingSize,
		ReplayColdLimit: cfg.EventPersistence.ReplayColdLimit,
		VoiceQuality:    cfg.Voice.Quality,
		UploadPolicy: ws.UploadPolicy{
			MaxUploadBytes:        int64(cfg.Upload.MaxSizeMB) << 20,
			Thumbnails:            true,
			StagedLifetimeSeconds: int64(service.StagedUploadLifetime / time.Second),
		},
		UploadFileTypes: svc.Uploads,
		TrustedProxies:  cfg.Server.TrustedProxies,
	})
	if err != nil {
		return api.Runtime{}, fmt.Errorf("app: building hub: %w", err)
	}

	// The plugin event sink consumes the built hub's broadcaster, so this is a
	// two-phase wire.
	if pluginRegistry != nil {
		sink := pluginRegistry.Sink()
		sink.SetBroadcaster(hub.BroadcastToChannel)
		hub.SetPluginEventSink(sink)
	}

	// Built before the LiveKit process starts so an error return cannot leave
	// that child running.
	writerStats, readerStats := service.PoolStatsSources(database)
	windows, err := newMetricsWindows(hub, writerStats, readerStats)
	if err != nil {
		return api.Runtime{}, err
	}

	// Start the LiveKit process only once the hub holds it: voice_join must
	// fail closed (IsRunning() == false) the moment Start fails, never see a
	// hub with a running process it does not know of.
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
		SystemStats:  sysstats.NewSampler(),
		LiveKitStats: liveKitStats(cfg, hub, voiceEnabled),
		Auth:         authSvc, Storage: in.Storage,
		Updater: updater.NewUpdater(in.Version, cfg.GitHub.Token, cfg.GitHub.Owner, cfg.GitHub.Repo),
	}, nil
}

type liveKitHub interface {
	LiveKitManaged() bool
	LiveKitPID() (int, bool)
	LiveKitRoomUsage(ctx context.Context) (rooms, participants int, err error)
}

// liveKitStats picks the LiveKit card's source (see lkstats.Detect), or nil
// when voice is off or there is nothing to read.
func liveKitStats(cfg *config.Config, hub liveKitHub, voiceEnabled bool) *lkstats.Sampler {
	metricsURL := cfg.Voice.LiveKitMetricsURL
	if metricsURL != "" && !config.ValidMetricsURL(metricsURL) {
		slog.Warn("config: voice.livekit_metrics_url is not an http(s) URL", "effect", "ignored, the address is guessed from voice.livekit_url")
		metricsURL = ""
	}
	return lkstats.Detect{
		Voice:      voiceEnabled,
		Managed:    hub.LiveKitManaged(),
		MetricsURL: metricsURL,
		LiveKitURL: cfg.Voice.LiveKitURL,
		PID:        hub.LiveKitPID,
		RoomUsage:  hub.LiveKitRoomUsage,
	}.Pick(slog.Default())
}

// storageLimits is the upload service's per-user quota (upload.user_quota_mb, 0
// = unlimited) and headroom floor (server.min_free_disk_mb) probed on the
// upload volume, which may not be the data volume /health watches, plus the
// file-type lists.
func storageLimits(cfg *config.Config) service.StorageLimits {
	return service.StorageLimits{
		UserQuotaBytes: cfg.Upload.UserQuotaBytes(),
		MinFreeBytes:   cfg.Server.MinFreeDiskBytes(),
		Dir:            cfg.Upload.StorageDir,
		MaxUploadBytes: int64(cfg.Upload.MaxSizeMB) << 20,
		FileTypes:      storage.FileTypePolicy{Blocked: cfg.Upload.BlockedExtensions, Allowed: cfg.Upload.AllowedExtensions},
	}
}

// buildVoice creates the LiveKit client and, when OwnCord manages the companion
// process, its manager; the process starts later, once the hub holds it.
func buildVoice(cfg *config.Config) (*ws.LiveKitClient, *livekitproc.Process, bool) {
	lk, lkErr := ws.NewLiveKitClient(&cfg.Voice)
	if lkErr != nil {
		slog.Warn("failed to create LiveKit client, voice disabled", "error", lkErr)
		return nil, nil, false
	}

	// The hub keeps the process even if Start() later fails: its only consumer
	// is the voice_join guard, which reads a nil process as "externally
	// managed, don't check", so a failed launch must fail joins closed rather
	// than wave them through with no SFU running.
	if cfg.Voice.LiveKitBinaryPath != "" || cfg.Voice.AutoDownloadLiveKit {
		return lk, livekitproc.New(&cfg.Voice, &cfg.TLS, cfg.Server.DataDir), true
	}

	// No webhook warning: the generated livekit.yaml sets no `webhook:` block,
	// so an external LiveKit never calls OwnCord's webhook.
	return lk, nil, true
}

// newAttention builds the admin attention panel over counters the server
// already keeps.
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
			return admin.NewestBackup(admin.ResolveBackupDir(cfg.Backup.Dir), cfg.Database.Path)
		},
		Certificate: admin.ServedCertificate,
		VoiceHealth: func(ctx context.Context) service.VoiceHealth {
			// A managed companion reports the supervisor's own state, which
			// probes nothing; otherwise probe the external client's health
			// (self-bounded), or report unconfigured.
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

type dispatchHub interface {
	GracefulStopContext(ctx context.Context, reason ws.RestartReason)
	Done() <-chan struct{}
	JoinBackground(ctx context.Context) (stragglers int)
}

// stopHub is the hub close step: GracefulStopContext, then wait for the
// dispatch goroutine, since GracefulStopContext only signals the loop; without
// the join, Run returned with the loop alive and Close released what it reads.
func stopHub(ctx context.Context, hub dispatchHub, reason ws.RestartReason) error {
	hub.GracefulStopContext(ctx, reason)
	var err error
	select {
	case <-hub.Done():
	case <-ctx.Done():
		err = fmt.Errorf("hub dispatch did not exit: %w", ctx.Err())
	}
	// The hub's background jobs get a short grace, then are cancelled and
	// joined before the database closes. Not part of the dispatch goroutine's
	// exit: a job may need a lock Run would hold.
	if n := hub.JoinBackground(ctx); n > 0 {
		slog.Warn("hub background jobs still running at shutdown, abandoning them", "count", n)
	}
	return err
}
