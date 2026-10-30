// Package api provides the HTTP router and handlers for the OwnCord server.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/diskutil"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/netclass"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/stackutil"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/telemetry"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/J3vb/OwnCord/Server/webclient"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
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

// warnOnServerConfig logs the settings that are legal but rarely what an
// operator meant. Warnings only: config.Load is warn-never-fail by design, so
// a questionable value must not stop a server that was working yesterday.
func warnOnServerConfig(cfg *config.Config) {
	// A wildcard origin accepts every browser page on the internet.
	if slices.Contains(cfg.Server.AllowedOrigins, "*") {
		slog.Warn("AllowedOrigins contains wildcard '*' — consider restricting to specific origins for production use")
	}
	_, bundled := webclient.Assets()
	warnOnBrowserClient(cfg, bundled)
	warnOnVoiceNodeIP(cfg)
	if cfg.Voice.LiveKitURL != "" && cfg.Voice.NodeIP != "" && cfg.Voice.AdvertiseInternalIP {
		slog.Warn("voice.node_ip is ignored while voice.advertise_internal_ip is on — LiveKit detects its public address over STUN instead",
			"node_ip", cfg.Voice.NodeIP,
			"fix", "clear voice.node_ip, or turn voice.advertise_internal_ip off if the pinned address must be advertised")
	}
	warnOnAdminPeerAddress(cfg)
}

// warnOnVoiceNodeIP warns about a voice.node_ip that remote clients cannot route
// to. It is written into livekit.yaml as the external address LiveKit advertises
// in ICE candidates, and livekit_process.go validates it only for YAML-unsafe
// characters. A private, CGNAT or loopback address fails invisibly: joins
// succeed (signalling uses OwnCord's own port) but no media arrives.
// It warns and never refuses: a LAN-only or tailnet-only deployment may
// legitimately advertise a private address.
func warnOnVoiceNodeIP(cfg *config.Config) {
	if cfg.Voice.LiveKitURL == "" || cfg.Voice.NodeIP == "" {
		return
	}
	kind := classifyIP(cfg.Voice.NodeIP)
	if kind == netclass.KindGlobal {
		return
	}
	slog.Warn("voice.node_ip is not a public address — remote clients will join voice and then hear no audio",
		"node_ip", cfg.Voice.NodeIP,
		"address_class", kind,
		"why", "node_ip is the address LiveKit advertises in ICE candidates. A client outside this "+
			"network cannot route to it, so the call connects over signalling and carries no media",
		"fix", "clear voice.node_ip so LiveKit detects this server's public address (or set it to "+
			"that address) and forward UDP "+netclass.VoiceUDPLabel(cfg.Voice.UDPPort)+" — "+
			"see docs/port-forwarding.md. Ignore this if every client is on the LAN or your tailnet")
}

// NewRouter builds the HTTP handler and a cleanup function that stops background
// goroutines. pluginRegistry may be nil: plugin lifecycle endpoints then answer
// 503 and list reads empty.
func NewRouter(cfg *config.Config, database *db.DB, ver string, logBuf *admin.RingBuffer, pluginRegistry *plugin.Registry, rt Runtime) (http.Handler, func()) {
	setAuthRateScale(cfg.Security.AuthRateLimitMultiplier)

	requireBuiltRuntime(rt)

	r := chi.NewRouter()

	routerMiddleware(r, cfg)

	// Health check: unauthenticated, no versioning prefix. Hub-backed callbacks
	// are late-bound closures set after hub creation; one handler instance backs
	// both /health mounts so they share the check cache.
	var getOnlineUsers func() int
	var hubAlive func() bool
	healthHandler := handleHealth(routerHealthDeps(cfg, database, &getOnlineUsers, &hubAlive))
	r.Get("/health", healthHandler)

	// Shared auth rate limiter, built by internal/app so the hub and these
	// routes share one instance; its lockouts persist to the database across
	// restarts.
	limiter := rt.Limiter

	mountPublicV1(r, cfg, healthHandler, routerServerInfoDeps(rt.Services))

	// Service layer, built by internal/app alongside the hub, which holds the
	// same instance.
	svc := rt.Services

	MountInviteRoutes(r, svc)

	mountGIF(r, cfg, svc, limiter)

	// Web Push subscription storage, mounted unconditionally; with push.enabled
	// false every route answers 503 PUSH_DISABLED after authentication.
	MountPushRoutes(r, svc.Sessions, svc.Push, cfg.Push.Enabled)

	store := rt.Storage
	routerUploadRoutes(r, svc.Sessions, limiter, cfg, svc.Uploads, store)

	// WebSocket hub — built, wired and started by internal/app; WS does its
	// own in-band auth, so no AuthMiddleware here.
	hub := rt.Hub
	getOnlineUsers = func() int { return hub.UserCount() }
	hubAlive = func() bool { return hub.DispatchAlive() }

	// Auth routes: StartRuntime built the service over the hub, so DELETE
	// /api/v1/auth/account fans out member_ban and force-disconnects the deleted
	// user's own socket like the admin ban path.
	MountAuthRoutes(r, rt.Auth, AuthMiddleware(svc.Sessions), limiter, cfg.Server.TrustedProxies)

	routerVoiceRoutes(r, cfg, limiter, hub, rt.VoiceEnabled)

	// Profile routes, mounted after hub creation so the hub can broadcast
	// user_update. A storage failure leaves store nil, so the avatar-upload
	// route is not registered. store is built as a FileStore interface value:
	// assigning the typed nil pointer would make a non-nil interface and defeat
	// the mount-time nil check.
	var profileStore FileStore
	if store != nil {
		profileStore = store
	}
	MountProfileRoutes(r, svc, profileStore, limiter, cfg.Server.TrustedProxies, hub, cfg)

	// DM REST routes and the message request inbox, mounted after hub creation
	// so dm_channel_close/dm_channel_open/dm_request events reach WebSocket
	// clients.
	routerDMRoutes(r, svc, hub, limiter, profileStore)

	// Channel, message and NSFW-acknowledgement REST routes — mounted after hub
	// creation so a message purge or an nsfw_ack can broadcast through it.
	routerChannelRoutes(r, svc, limiter, cfg, hub)

	// Custom emoji routes, mounted after hub creation so an upload or delete can
	// fan out an emoji_update. They need the attachment routes' file storage;
	// without it they are not mounted (a 404 the client reads as "this server
	// has no emoji").
	if store != nil {
		MountEmojiRoutes(r, svc, store, limiter, hub)
		// Custom sticker routes, on the same storage and for the
		// same reason. The service is nil when the store cannot hold stickers.
		if svc.Stickers != nil {
			MountStickerRoutes(r, svc, store, limiter, hub)
		}
	}

	// Report intake, moderator actions and appeals, mounted after hub creation
	// so they can notify connected clients.
	routerReportRoutes(r, svc, hub)

	// Connectivity diagnostics restricted to admin users only.
	// Exposes Go runtime version and LiveKit node IP which aid targeted attacks.
	r.With(AuthMiddleware(svc.Sessions),
		RequirePermission(permissions.Administrator),
		RateLimitMiddleware(limiter, "diag:", 5, time.Minute, cfg.Server.TrustedProxies)).
		Get("/api/v1/diagnostics/connectivity",
			handleDiagnosticsConnectivity(cfg, ver, hub))

	r.With(RateLimitMiddleware(limiter, "ws_upgrade:", scaledAuthLimit(wsUpgradeRateLimitPerMinute), time.Minute, cfg.Server.TrustedProxies)).
		Get("/api/v1/ws", ws.ServeWS(hub, cfg.Server.AllowedOrigins, cfg.Server.MaxWSConnections))

	routerMetricsRoutes(r, cfg, database, svc, hub, rt.MetricsWindows)

	u := rt.Updater
	adminHandler := admin.NewHandler(database, ver, hub, u, logBuf, cfg.Server.AllowedOrigins, svc.Permissions, svc,
		adminSetupOptions(cfg, rt))
	// The client's member actions, reachable without the /admin prefix (see
	// admin.NewMemberAPI). Deliberately outside the admin CIDR gate below: they
	// accept only a session or API token issued by this server, plus the
	// per-action permission and rank checks.
	r.Mount("/api/v1/moderation/members", admin.NewMemberAPI(svc, hub, svc.Permissions))
	r.Mount("/api/v1/moderation/channels", admin.NewChannelAPI(svc, hub))
	mountBrowserClient(r, cfg, rt.WebClient)
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
			r.Mount("/api/v1/admin/plugins", NewPluginAdminHandler(pluginRegistry, database, database))
		})
	})

	// Client auto-update endpoint (unauthenticated), per-IP rate limited; the
	// signature fetch is cached inside the updater. It uses a dedicated key
	// prefix (like "livekit_proxy:") because the empty-prefix middleware would
	// share per-IP buckets with verify-totp and password change, so the client's
	// 30/min auto-poll could 429 its user's own 2FA.
	MountClientUpdateRoute(
		r.With(RateLimitMiddleware(limiter, "client_update:", clientUpdateRateLimitPerMinute, time.Minute, cfg.Server.TrustedProxies)),
		u,
	)

	warnOnServerConfig(cfg)

	return r, func() {}
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

// routerHealthDeps builds the liveness probes behind the shared /health
// handler. getOnlineUsers and hubAlive are taken as pointers because NewRouter
// only assigns them once the hub exists, after this handler is already mounted;
// the closures read whatever the variables hold at request time.
func routerHealthDeps(cfg *config.Config, database *db.DB, getOnlineUsers *func() int, hubAlive *func() bool) healthDeps {
	return healthDeps{
		onlineUsers: func() int {
			if *getOnlineUsers != nil {
				return (*getOnlineUsers)()
			}
			return 0
		},
		dbPing: func(ctx context.Context) error {
			if database == nil {
				return nil
			}
			// Reader pool, not the writer: the writer is the single connection
			// every mutation queues on, so a SELECT 1 there would report a
			// writer queue as a liveness failure (see db.PingRead).
			return database.PingRead(ctx)
		},
		dispatchAlive: func() bool {
			if *hubAlive != nil {
				return (*hubAlive)()
			}
			return true
		},
		freeDiskBytes: func() (uint64, error) {
			return diskutil.FreeBytes(cfg.Server.DataDir)
		},
		minFreeDiskBytes: cfg.Server.MinFreeDiskBytes(),
	}
}

// routerMiddleware installs NewRouter's global middleware stack. The order is a
// security property (request-id binding before the logger reads it, tracing
// before panic recovery so the panic log carries the trace id, security
// headers and the body cap before any handler runs) — keep it exactly as
// written.
func routerMiddleware(r chi.Router, cfg *config.Config) {
	r.Use(boundRequestID) // must precede RequestID — it reads the header verbatim
	r.Use(middleware.RequestID)
	r.Use(setRequestIDHeader) // echo request ID into response header
	// NOTE: middleware.RealIP is intentionally omitted — trusting X-Real-IP from
	// any source allows IP spoofing for rate-limit bypass. IP header trust is now
	// handled explicitly in clientIPWithProxies using the trusted_proxies config.
	// OpenTelemetry HTTP tracing; a no-op when telemetry is disabled or the otel
	// tag is unset. Mounted ahead of recoverer, which snapshots the trace id
	// before dispatch: the span must exist for the panic record to carry
	// trace_id.
	r.Use(telemetry.HTTPMiddleware())
	r.Use(recoverer) // slog-routing panic recovery (replaces chi's stderr-only Recoverer)
	// The access log is proxy-aware, so the recommended reverse-proxy
	// deployment records the real client rather than the proxy hop. Parsed
	// once here, never on the request path.
	proxyNets := parseCIDRList(cfg.Server.TrustedProxies)
	r.Use(requestLogger(proxyNets)) // structured request/response logging
	r.Use(SecurityHeadersWithTLS(cfg.TLS.Mode))
	r.Use(MaxBodySizeUnless(defaultMaxBodySize, bodyCapExemptPattern, bodyCapExemptPrefixes...))
	r.Use(requestDeadlineMiddleware()) // 15 s deadline on non-streaming routes

	if cfg.Server.WAFEnabled {
		r.Use(NewWAFMiddlewareCRS(cfg.Server.WAFParanoiaLevel, cfg.Server.WAFCRSMode))
	}
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

var serverStartTime = time.Now()

type healthResponse struct {
	Status      string `json:"status"` // "ok" | "degraded"
	Uptime      int64  `json:"uptime"`
	OnlineUsers int    `json:"online_users"`
	// Reason names the degraded subsystem ("hub", "database", "disk") and
	// nothing more — this endpoint is unauthenticated, so no error details.
	Reason string `json:"reason,omitempty"`
}

type healthDeps struct {
	onlineUsers   func() int
	dbPing        func(context.Context) error
	dispatchAlive func() bool
	freeDiskBytes func() (uint64, error)
	// minFreeDiskBytes is the free-space floor under which health reports
	// degraded: server.min_free_disk_mb, the same number the start-up banner and
	// upload path use. WAL growth, uploads and backups share the data volume, so
	// running dry corrupts more than one thing. 0 disables the check.
	minFreeDiskBytes uint64
}

const (
	// healthCacheTTL bounds how often the real checks run: the endpoint is
	// unauthenticated AND rate-limit-exempt, so an uncached DB ping per
	// request would be a free amplification lever.
	healthCacheTTL = 5 * time.Second
	// healthDBPingTimeout bounds the SELECT 1 so a wedged writer degrades the
	// health report instead of hanging it.
	healthDBPingTimeout = 1 * time.Second
)

// mountPublicV1 registers the unauthenticated /api/v1 routes. Each must be
// declared in publicSurface (auth_posture_test.go) and must keep build identity
// (version, build, commit) off it.
func mountPublicV1(r chi.Router, cfg *config.Config, healthHandler http.HandlerFunc, infoDeps serverInfoDeps) {
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/health", healthHandler)
		r.Get("/info", handleInfo(cfg, infoDeps))
		r.Get("/server-info", handleServerInfo(cfg, infoDeps))
	})
}

type infoResponse struct {
	Name string `json:"name"`
}

func handleHealth(deps healthDeps) http.HandlerFunc {
	// Version is omitted to prevent server fingerprinting; it is on the
	// authenticated diagnostics endpoint.
	var mu syncutil.Mutex
	var cachedAt time.Time
	var cachedStatus, cachedReason string
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if time.Since(cachedAt) >= healthCacheTTL {
			// WithoutCancel: the result is cached for the next healthCacheTTL,
			// so it must not inherit THIS request's cancellation, or a probe
			// that disconnects mid-check would poison the shared cache with a
			// false "degraded/database" verdict. The DB ping has its own 1s
			// timeout, so checks stay bounded.
			cachedStatus, cachedReason = runHealthChecks(context.WithoutCancel(r.Context()), deps)
			cachedAt = time.Now()
		}
		status, reason := cachedStatus, cachedReason
		mu.Unlock()

		online := 0
		if deps.onlineUsers != nil {
			online = deps.onlineUsers()
		}
		code := http.StatusOK
		if status != "ok" {
			code = http.StatusServiceUnavailable
		}
		writeJSON(w, code, healthResponse{
			Status:      status,
			Uptime:      int64(time.Since(serverStartTime).Seconds()),
			OnlineUsers: online,
			Reason:      reason,
		})
	}
}

// runHealthChecks probes the hub dispatch loop, the database, and free disk,
// returning ("ok", "") or ("degraded", <subsystem>). First failure wins, in
// blast-radius order. Probe errors that mean "unknown" (unsupported platform,
// missing dir in tests) count as healthy — only a positive negative degrades.
func runHealthChecks(ctx context.Context, deps healthDeps) (status, reason string) {
	if deps.dispatchAlive != nil && !deps.dispatchAlive() {
		return "degraded", "hub"
	}
	if deps.dbPing != nil {
		pingCtx, cancel := context.WithTimeout(ctx, healthDBPingTimeout)
		err := deps.dbPing(pingCtx)
		cancel()
		if err != nil {
			return "degraded", "database"
		}
	}
	if deps.freeDiskBytes != nil && deps.minFreeDiskBytes > 0 {
		if free, err := deps.freeDiskBytes(); err == nil && free < deps.minFreeDiskBytes {
			return "degraded", "disk"
		}
	}
	return "ok", ""
}

func handleInfo(cfg *config.Config, deps serverInfoDeps) http.HandlerFunc {
	var mu syncutil.Mutex
	var cachedAt time.Time
	cachedName := cfg.Server.Name
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if time.Since(cachedAt) >= serverInfoCacheTTL {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), serverInfoReadTimeout)
			name, err := liveServerName(ctx, cfg, deps)
			cancel()
			if err != nil {
				slog.Error("failed to read server info", "error", err)
				name = cfg.Server.Name
			}
			cachedName, cachedAt = name, time.Now()
		}
		name := cachedName
		mu.Unlock()
		writeJSON(w, http.StatusOK, infoResponse{Name: name})
	}
}

type livekitHealthResponse struct {
	Status           string `json:"status"`
	LiveKitReachable bool   `json:"livekit_reachable"`
	Error            string `json:"error,omitempty"`
}

func handleLiveKitHealth(hub *ws.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ok, err := hub.LiveKitHealthCheck(r.Context())
		if ok {
			writeJSON(w, http.StatusOK, livekitHealthResponse{
				Status:           "ok",
				LiveKitReachable: true,
			})
			return
		}

		errMsg := "unknown"
		if err != nil {
			errMsg = err.Error()
		}
		writeJSON(w, http.StatusServiceUnavailable, livekitHealthResponse{
			Status:           "degraded",
			LiveKitReachable: false,
			Error:            errMsg,
		})
	}
}

// boundRequestID drops a client-supplied X-Request-Id that is over
// maxRequestIDLen bytes or not plain printable ASCII, so the following
// middleware.RequestID generates a server-side id. Otherwise chi adopts the
// header verbatim, the admin ring buffer (2000 entries) retains it and the
// response echoes it: a burst of ~1 MiB ids pins hundreds of MB of heap.
// It drops rather than truncates: a truncated id correlates with nothing yet
// still parks attacker-chosen bytes in the log. The request is served either
// way, with the server-generated id in the response header.
func boundRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := r.Header.Get(middleware.RequestIDHeader); id != "" && !validRequestID(id) {
			r.Header.Del(middleware.RequestIDHeader)
		}
		next.ServeHTTP(w, r)
	})
}

func validRequestID(id string) bool {
	if len(id) > maxRequestIDLen {
		return false
	}
	for i := range len(id) {
		if id[i] < '!' || id[i] > '~' {
			return false
		}
	}
	return true
}

func setRequestIDHeader(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := middleware.GetReqID(r.Context())
		if requestID != "" {
			w.Header().Set("X-Request-Id", requestID)
		}
		next.ServeHTTP(w, r)
	})
}

// recoverer logs handler panics through slog so they reach the admin log stream,
// unlike chi's Recoverer, which writes an unstructured stack to stderr only. The
// stack comes from stackutil so it never embeds argument values (which on
// auth/upload paths can carry tokens or passwords).
func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Capture correlation IDs before dispatch so the recovery closure makes
		// no context calls (which trip contextcheck inside a defer), while the
		// panic log still carries req_id/trace_id.
		reqID := middleware.GetReqID(r.Context())
		traceID := telemetry.TraceIDFromContext(r.Context())
		defer func() {
			if rec := recover(); rec != nil {
				// Preserve chi's behaviour of not swallowing the abort sentinel.
				if err, ok := rec.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(rec)
				}
				attrs := []any{
					"method", r.Method,
					"path", truncateForLog(r.URL.Path, maxLoggedPathLen),
					"panic", rec,
					"stack", stackutil.Capture(),
				}
				if reqID != "" {
					attrs = append(attrs, "req_id", reqID)
				}
				if traceID != "" {
					attrs = append(attrs, "trace_id", traceID)
				}
				slog.Error("http handler panic recovered", attrs...)
				// On Windows a nil deref or invalid address may have
				// left the heap corrupt (golang/go#81238), so it exits for a
				// supervisor restart rather than writing a 500 and continuing
				// on damaged memory. Every other panic stays recovered.
				if stackutil.Recovered(rec) {
					slog.Error("http handler: hardware fault, exiting for supervisor restart",
						"method", r.Method, "path", truncateForLog(r.URL.Path, maxLoggedPathLen))
					stackutil.Fatal()
				}
				w.WriteHeader(http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// requestLogger logs every HTTP request; health checks at Debug.
// clientIPWithProxies resolves client_ip through trusted_proxies so
// reverse-proxy deployments log the real client; proxyNets is parsed once at
// construction, never on the request path.
func requestLogger(proxyNets []*net.IPNet) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			elapsed := time.Since(start)
			status := ww.Status()

			path := r.URL.Path
			reqID := middleware.GetReqID(r.Context())
			attrs := []any{
				"method", r.Method,
				"path", truncateForLog(path, maxLoggedPathLen),
				"status", status,
				"duration_ms", elapsed.Milliseconds(),
				"bytes", ww.BytesWritten(),
				"client_ip", clientIPWithProxies(r, proxyNets),
			}
			if reqID != "" {
				attrs = append(attrs, "req_id", reqID)
			}
			switch {
			case path == "/health" || path == "/api/v1/health":
				slog.Debug("http request", attrs...)
			case status >= 500:
				slog.Error("http request", attrs...)
			case status >= 400:
				slog.Warn("http request", attrs...)
			default:
				slog.Info("http request", attrs...)
			}
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("writeJSON: failed to encode response", "error", err)
	}
}
