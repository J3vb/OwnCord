package api

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/diskutil"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/telemetry"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

// routeDeps is everything a route group may mount over: the config, the
// collaborators internal/app built, and the few values NewRouter derives once.
type routeDeps struct {
	cfg      *config.Config
	database *db.DB
	ver      string
	logBuf   *admin.RingBuffer
	plugins  *plugin.Registry
	rt       Runtime
	svc      *service.Services
	hub      *ws.Hub
	limiter  *auth.RateLimiter
	// store is the upload file store, nil when it could not be opened.
	store *storage.Storage
	// files is store as a FileStore interface value, nil when store is nil:
	// assigning the typed nil pointer would make a non-nil interface and defeat
	// the mount-time nil checks.
	files      FileStore
	slowRoutes *metrics.SlowRoutes
}

func newRouteDeps(cfg *config.Config, database *db.DB, ver string, logBuf *admin.RingBuffer, plugins *plugin.Registry, rt Runtime, slowRoutes *metrics.SlowRoutes) *routeDeps {
	d := &routeDeps{
		cfg: cfg, database: database, ver: ver, logBuf: logBuf, plugins: plugins, rt: rt,
		svc: rt.Services, hub: rt.Hub, limiter: rt.Limiter, store: rt.Storage, slowRoutes: slowRoutes,
	}
	if d.store != nil {
		d.files = d.store
	}
	return d
}

// routeGroup mounts one feature's routes.
type routeGroup struct {
	name  string
	mount func(r chi.Router, d *routeDeps)
}

// routeGroups is every feature's routes, mounted in this order after the
// middleware and health routes. A new feature adds its group here and keeps
// its handlers and Mount function in its own file.
var routeGroups = []routeGroup{
	{"invites", func(r chi.Router, d *routeDeps) { MountInviteRoutes(r, d.svc) }},
	{"gif", func(r chi.Router, d *routeDeps) { mountGIF(r, d.cfg, d.svc, d.limiter) }},
	// Link previews and outside images for the browser client, which has no
	// native broker of its own. Only mounted when the browser client is.
	{"externalContent", func(r chi.Router, d *routeDeps) {
		mountExternalContent(r, d.cfg, d.svc.Sessions, d.limiter)
	}},
	// Web Push subscription storage, mounted unconditionally; with push.enabled
	// false every route answers 503 PUSH_DISABLED after authentication.
	{"push", func(r chi.Router, d *routeDeps) {
		MountPushRoutes(r, d.svc.Sessions, d.svc.Push, d.cfg.Push.Enabled)
	}},
	{"uploads", func(r chi.Router, d *routeDeps) {
		routerUploadRoutes(r, d.svc.Sessions, d.limiter, d.cfg, d.svc.Uploads, d.store)
	}},
	// StartRuntime built the auth service over the hub, so DELETE
	// /api/v1/auth/account fans out member_ban and force-disconnects the deleted
	// user's own socket like the admin ban path.
	{"auth", func(r chi.Router, d *routeDeps) {
		MountAuthRoutes(r, d.rt.Auth, AuthMiddleware(d.svc.Sessions), d.limiter, d.cfg.Server.TrustedProxies)
	}},
	{"voice", func(r chi.Router, d *routeDeps) {
		routerVoiceRoutes(r, d.cfg, d.limiter, d.hub, d.rt.VoiceEnabled)
	}},
	// The hub broadcasts user_update. Without file storage the avatar-upload
	// route is not registered.
	{"profile", func(r chi.Router, d *routeDeps) {
		MountProfileRoutes(r, d.svc, d.files, d.limiter, d.cfg.Server.TrustedProxies, d.hub, d.cfg)
	}},
	// dm_channel_close/dm_channel_open/dm_request events reach WebSocket clients.
	{"dms", func(r chi.Router, d *routeDeps) { routerDMRoutes(r, d.svc, d.hub, d.limiter, d.files) }},
	// Channel, message and NSFW-acknowledgement routes; a message purge or an
	// nsfw_ack broadcasts through the hub.
	{"channels", func(r chi.Router, d *routeDeps) { routerChannelRoutes(r, d.svc, d.limiter, d.cfg, d.hub) }},
	// The signed-in user's own uploads: storage figure, list and removal.
	// Removing the file of a message tells its readers.
	{"userUploads", func(r chi.Router, d *routeDeps) {
		MountUserUploadRoutes(r, d.svc, d.files, d.limiter, d.cfg.Server.TrustedProxies, d.hub)
	}},
	// Custom emoji and stickers fan out emoji_update/sticker_update. They need
	// the attachment routes' file storage; without it they are not mounted (a
	// 404 the client reads as "this server has no emoji"). The sticker service
	// is nil when the store cannot hold stickers.
	{"emojiAndStickers", func(r chi.Router, d *routeDeps) {
		if d.store == nil {
			return
		}
		MountEmojiRoutes(r, d.svc, d.store, d.limiter, d.hub)
		if d.svc.Stickers != nil {
			MountStickerRoutes(r, d.svc, d.store, d.limiter, d.hub)
		}
	}},
	// Report intake, moderator actions and appeals; they notify connected clients.
	{"reports", func(r chi.Router, d *routeDeps) { routerReportRoutes(r, d.svc, d.hub) }},
	// Connectivity diagnostics, administrators only: they expose the Go runtime
	// version and the LiveKit node IP, which aid targeted attacks.
	{"diagnostics", func(r chi.Router, d *routeDeps) {
		r.With(AuthMiddleware(d.svc.Sessions),
			RequirePermission(permissions.Administrator),
			RateLimitMiddleware(d.limiter, "diag:", 5, time.Minute, d.cfg.Server.TrustedProxies)).
			Get("/api/v1/diagnostics/connectivity",
				handleDiagnosticsConnectivity(d.cfg, d.ver, d.hub))
	}},
	// WebSocket upgrade; WS does its own in-band auth, so no AuthMiddleware.
	{"websocket", func(r chi.Router, d *routeDeps) {
		r.With(RateLimitMiddleware(d.limiter, "ws_upgrade:", scaledAuthLimit(wsUpgradeRateLimitPerMinute), time.Minute, d.cfg.Server.TrustedProxies)).
			Get("/api/v1/ws", ws.ServeWS(d.hub, d.cfg.Server.AllowedOrigins, d.cfg.Server.MaxWSConnections))
	}},
	{"metrics", func(r chi.Router, d *routeDeps) {
		routerMetricsRoutes(r, d.cfg, d.database, d.svc, d.hub, d.rt.MetricsWindows)
	}},
	{"admin", mountAdminRoutes},
	// Client auto-update endpoint (unauthenticated), per-IP rate limited; the
	// signature fetch is cached inside the updater. It uses a dedicated key
	// prefix (like "livekit_proxy:") because the empty-prefix middleware would
	// share per-IP buckets with verify-totp and password change, so the client's
	// 30/min auto-poll could 429 its user's own 2FA.
	{"clientUpdate", func(r chi.Router, d *routeDeps) {
		MountClientUpdateRoute(
			r.With(RateLimitMiddleware(d.limiter, "client_update:", clientUpdateRateLimitPerMinute, time.Minute, d.cfg.Server.TrustedProxies)),
			d.rt.Updater,
		)
	}},
}

// mountAdminRoutes mounts the admin panel, the client's member and channel
// moderation actions, and the browser client.
func mountAdminRoutes(r chi.Router, d *routeDeps) {
	svc, hub, cfg := d.svc, d.hub, d.cfg
	adminHandler := admin.NewHandler(d.database, d.ver, hub, d.rt.Updater, d.logBuf, cfg.Server.AllowedOrigins, svc.Permissions, svc,
		withSystemDatabase(adminSetupOptions(cfg, d.rt, newDiscordImporter(d.database, svc, hub, d.store, d.rt), d.database.TotalAttachmentBytes, d.slowRoutes), d.database))
	// The client's member actions, reachable without the /admin prefix (see
	// admin.NewMemberAPI). Deliberately outside the admin CIDR gate below: they
	// accept only a session or API token issued by this server, plus the
	// per-action permission and rank checks.
	r.Mount("/api/v1/moderation/members", admin.NewMemberAPI(svc, hub, svc.Permissions))
	r.Mount("/api/v1/moderation/channels", admin.NewChannelAPI(svc, hub))
	mountBrowserClient(r, cfg, d.rt.WebClient)
	r.Group(func(r chi.Router) {
		r.Use(AdminIPRestrict("server.admin_allowed_cidrs", cfg.Server.AdminAllowedCIDRs, cfg.Server.TrustedProxies))
		r.Mount("/admin", adminHandler)

		// Plugin admin REST surface. The IP gate above is only the outer
		// perimeter; lifecycle endpoints also require a valid admin Bearer token
		// (admin.RequireAdminAuth) so a LAN attacker on the allowed CIDR cannot
		// install or enable plugins. The registry is nil when plugin support is
		// disabled: lifecycle calls then return 503 and list returns [].
		r.Group(func(r chi.Router) {
			r.Use(admin.RequireAdminAuth(svc.Sessions))
			r.Mount("/api/v1/admin/plugins", NewPluginAdminHandler(d.plugins, d.database, d.database))
		})
	})
}

func routerUploadRoutes(r chi.Router, sessions *service.SessionService, limiter *auth.RateLimiter, cfg *config.Config, uploads *service.UploadService, store *storage.Storage) {
	if cfg.Upload.MaxSizeMB == 0 {
		slog.Warn("upload.max_size_mb is 0, uploads are disabled")
	}
	if store != nil {
		MountUploadRoutes(r, sessions, store, limiter, cfg.Server.AllowedOrigins, uploads)
	}
}

func routerDMRoutes(r chi.Router, svc *service.Services, hub *ws.Hub, limiter *auth.RateLimiter, store FileStore) {
	MountDMRoutes(r, svc, hub, limiter, store)
	MountDMRequestRoutes(r, svc, hub)
}

func routerChannelRoutes(r chi.Router, svc *service.Services, limiter *auth.RateLimiter, cfg *config.Config, hub *ws.Hub) {
	MountChannelRoutes(r, svc, limiter, cfg.Server.TrustedProxies, hub)
	MountNSFWRoutes(r, svc, hub)
	MountThreadRoutes(r, svc)
	MountChannelMediaRoutes(r, svc, limiter, cfg.Server.TrustedProxies)
}

// routerReportRoutes mounts report intake, the reporter's status view, the
// moderation queue, warning/timeout/notice-ack and appeals. All gate on
// MODERATE_MEMBERS and the hub broadcasts mod_queue/mod_action/appeal_status.
func routerReportRoutes(r chi.Router, svc *service.Services, hub *ws.Hub) {
	MountReportRoutes(r, svc, hub)
	MountModerationQueueRoutes(r, svc, hub)
	MountModerationRoutes(r, svc, hub)
	MountAppealRoutes(r, svc)
	MountModerationAppealRoutes(r, svc)
}

// routerVoiceRoutes mounts the LiveKit webhook, health and signalling-proxy
// routes; none are mounted when voiceEnabled (internal/app's report that the
// LiveKit client was built) is false.
func routerVoiceRoutes(r chi.Router, cfg *config.Config, limiter *auth.RateLimiter, hub *ws.Hub, voiceEnabled bool) {
	if !voiceEnabled {
		return
	}

	// LiveKit webhook (no auth middleware; LiveKit JWT verification). The IP
	// gate is defence in depth, with its own allowlist key
	// (livekit_webhook_allowed_cidrs) so an external LiveKit can be admitted
	// WITHOUT widening the admin perimeter. Falls back to admin_allowed_cidrs
	// when unset.
	webhookCIDRs := cfg.Server.LiveKitWebhookCIDRs()
	r.With(AdminIPRestrict("server.livekit_webhook_allowed_cidrs", webhookCIDRs, cfg.Server.TrustedProxies)).
		Post("/api/v1/livekit/webhook",
			hub.NewLiveKitWebhookHandler(cfg.Voice.LiveKitAPIKey, cfg.Voice.LiveKitAPISecret))

	r.With(AdminIPRestrict("server.livekit_webhook_allowed_cidrs", webhookCIDRs, cfg.Server.TrustedProxies)).
		Get("/api/v1/livekit/health", handleLiveKitHealth(hub))

	// Reverse proxy of LiveKit signalling through OwnCord's HTTPS server avoids
	// mixed-content blocks (secure page -> insecure WS):
	// wss://server:8443/livekit/* -> ws://localhost:7880/*.
	// AuthMiddleware is deliberately omitted: LiveKit signal requests carry a
	// LiveKit JWT, not an OwnCord session, as the access_token query param (JS
	// SDK) or Authorization: Bearer (Rust SDK, Linux native voice), which the
	// proxy forwards. Users only get a JWT via the authenticated voice_join
	// flow; rate limiting prevents abuse.
	r.With(RateLimitMiddleware(limiter, "livekit_proxy:", livekitProxyRateLimitPerMinute, time.Minute, cfg.Server.TrustedProxies)).
		Handle("/livekit/*", http.StripPrefix("/livekit", NewLiveKitProxy(cfg.Voice.LiveKitURL, cfg.Server.AllowedOrigins)))
}

func routerMetricsRoutes(r chi.Router, cfg *config.Config, database *db.DB, svc *service.Services, hub *ws.Hub, windows *metrics.Windows) {
	// A nil *Windows must not become a non-nil method value (nil = no source).
	var windowSnapshot func(time.Duration) (metrics.WindowSnapshot, bool)
	if windows != nil {
		windowSnapshot = windows.Snapshot
	}
	// Metrics endpoint — IP-restricted by metrics_allowed_cidrs (falls back to
	// admin_allowed_cidrs) so a central scraper can be admitted without widening
	// /admin. The shape is documented in docs/deployment.md — keep the two in sync.
	src := MetricsSources{
		ConnectedUsers:      hub.UserCount,
		VoiceSessions:       hub.VoiceSessionCount,
		BroadcastDrops:      hub.BroadcastDropCount,
		TopicSheds:          hub.TopicShedCount,
		BroadcastMs:         hub.BroadcastMs,
		DispatchLagMs:       hub.DispatchLagMs,
		ChatAckMs:           hub.ChatAckMs,
		VoiceJoinMs:         hub.VoiceJoinMs,
		BroadcastQueueDepth: hub.BroadcastQueueDepth,
		SeqMuMaxHoldMs:      hub.SeqMuMaxHoldMs,
		LiveKitHealth:       hub.LiveKitHealthCheck,
		ReconnectTiers:      hub.ReconnectTierStats,
		ReconnectRingMisses: hub.ReconnectRingMissCount,
		Backpressure:        hub.BackpressureStats,
		PresenceDrops:       hub.PresenceDropCount,
		LossMarks:           hub.LossMarkCount,
		ConnRejects:         hub.ConnRejectCount,
		PersisterStats:      hub.EventPersisterStats,
		DBStats:             func() sql.DBStats { return database.SQLDb().Stats() },
		DBReaderStats:       func() sql.DBStats { return database.SQLReaderDB().Stats() },
		PermCache:           svc.Permissions.CacheStats,
		DiskFree:            func() (uint64, error) { return diskutil.FreeBytes(cfg.Server.DataDir) },
		DiskMinFree:         cfg.Server.MinFreeDiskBytes(),
		UploadBytes:         database.TotalAttachmentBytes,
		WALBytes:            database.WALBytes,
		PushCounters:        pushCountersSource(svc),
		Windows:             windowSnapshot,
		LatencyCounts:       hub.LatencyCounts,
	}
	perimeter := AdminIPRestrict("server.metrics_allowed_cidrs", cfg.Server.MetricsCIDRs(), cfg.Server.TrustedProxies)
	r.With(perimeter).Get("/api/v1/metrics", handleMetrics(src))
	// Same figures in Prometheus text, in every build and behind the same
	// perimeter; the OTel exporter below is the -tags otel alternative.
	r.With(perimeter).Get("/api/v1/metrics/prometheus", handlePrometheusMetrics(src))

	// OTel Prometheus exporter, mounted when wired (otel build, exporter ==
	// "prometheus"); the default no-op build gets 404 because
	// telemetry.PrometheusHandler() returns nil.
	if promH := telemetry.PrometheusHandler(); promH != nil {
		r.With(AdminIPRestrict("server.metrics_allowed_cidrs", cfg.Server.MetricsCIDRs(), cfg.Server.TrustedProxies)).
			Mount("/metrics", promH)
	}
}

// pushCountersSource returns nil when dispatch was never constructed
// (push.enabled and push.dispatch_enabled not both true), so handleMetrics
// leaves the push_* fields at zero rather than calling into a nil
// *service.PushDispatcher.
func pushCountersSource(svc *service.Services) func() (dispatched, failed, pruned uint64) {
	if svc == nil || svc.PushDispatch == nil {
		return nil
	}
	return svc.PushDispatch.Counters
}

// withSystemDatabase gives the admin System health page its database card.
func withSystemDatabase(opts admin.SetupOptions, database *db.DB) admin.SetupOptions {
	opts.System.Database = func(ctx context.Context) (admin.SystemDatabase, error) {
		st, err := database.HealthStats(ctx)
		if err != nil {
			return admin.SystemDatabase{}, fmt.Errorf("system health database: %w", err)
		}
		return admin.SystemDatabase{
			FileBytes: st.FileBytes, WALBytes: st.WALBytes, SchemaVersion: st.SchemaVersion,
			ReadersInUse: st.ReadersInUse, ReadersOpen: st.ReadersOpen, ReadersMax: st.ReadersMax,
			ReaderWaitCount: st.ReaderWaitCount, ReaderWaitMs: st.ReaderWaitMs,
			WriterWaitCount: st.WriterWaitCount, WriterWaitMs: st.WriterWaitMs,
		}, nil
	}
	return opts
}
