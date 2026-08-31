// Package api provides the HTTP router and handlers for the OwnCord server.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/diskutil"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/stackutil"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/telemetry"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// Runtime holds the process-level collaborators NewRouter mounts its routes
// over. Until B3-3 NewRouter built all of them itself and returned the hub,
// while main.go set the hub's event persister and event store after it
// returned — two owners of one hub. internal/app builds them now
// (app.StartRuntime), applies every pre-Run setter from that one place, and
// hands the result in here; B3-4 turns the required setters into validated
// constructor options at the same single call site.
type Runtime struct {
	// Hub is already wired and running: StartRuntime starts its dispatch
	// goroutine after the last pre-Run setter, exactly where NewRouter used
	// to. Stopping it is the caller's job (App.Close's "hub" step).
	Hub *ws.Hub
	// Limiter backs both the hub and every rate-limited route. One instance:
	// it persists auth lockouts, so a second copy would split that state.
	Limiter *auth.RateLimiter
	// Services is the shared service layer — the same instance the hub holds,
	// so the permission cache the hub invalidates is the one the handlers read.
	Services *service.Services
	// VoiceEnabled is whether StartRuntime's LiveKit client was built. The
	// webhook, LiveKit health and signalling-proxy routes are mounted only
	// then — the `lkErr == nil` guard that used to live in this package.
	VoiceEnabled bool
}

// NewRouter builds and returns the fully configured HTTP handler and a
// cleanup function that stops background goroutines (e.g. rate-limiter
// cleanup).
//
// pluginRegistry may be nil — in that case the plugin admin endpoints respond
// with 503 on lifecycle calls and an empty list on read.
func NewRouter(cfg *config.Config, database *db.DB, ver string, logBuf *admin.RingBuffer, pluginRegistry *plugin.Registry, rt Runtime) (http.Handler, func()) {
	// Install the auth rate multiplier before any route mounts read it.
	setAuthRateScale(cfg.Security.AuthRateLimitMultiplier)

	// Load (or auto-generate) the AES-256 key for TOTP secret encryption
	// (M1). Done first, before any other setup, so a fatal failure here
	// (below) doesn't leave background goroutines or partially-mounted
	// routes behind.
	totpKey := routerTOTPKey(cfg)

	r := chi.NewRouter()

	routerMiddleware(r, cfg)

	// Health check — unauthenticated, no versioning prefix.
	// The hub-backed callbacks are set after hub creation below (late-bound
	// closures, same pattern the old online-user counter used). One shared
	// handler instance backs both /health mounts so they share the check cache.
	var getOnlineUsers func() int
	var hubAlive func() bool
	healthHandler := handleHealth(routerHealthDeps(cfg, database, &getOnlineUsers, &hubAlive))
	r.Get("/health", healthHandler)

	// Shared rate limiter for auth endpoints, built by internal/app so the
	// hub and these routes share one instance (its lockouts are persisted to
	// the database and survive restarts — M2 security hardening).
	limiter := rt.Limiter

	// Start background cleanup of stale rate-limiter entries to prevent
	// unbounded memory growth. The goroutine exits when stopCh is closed.
	limiterStopCh := make(chan struct{})
	go limiter.StartCleanup(rateLimiterCleanupInterval, rateLimiterCleanupMaxWindow, limiterStopCh)

	// Versioned API routes.
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/health", healthHandler)
		r.Get("/info", handleInfo(cfg))
	})

	// Service layer — centralizes business logic for REST and WS handlers.
	// Built by internal/app alongside the hub, which holds the same instance.
	svc := rt.Services

	// Auth routes are mounted after hub creation (below) so self-service
	// account deletion can broadcast member_ban like the admin ban path does.

	// Invite management routes (require MANAGE_INVITES permission).
	MountInviteRoutes(r, database, svc)

	// Channel and message REST routes are mounted after hub creation (below)
	// so the hub can fan a bulk delete out as one chat_bulk_deleted event.

	// GIF proxy — keeps the Klipy API key server-side. Mounted unconditionally;
	// with no key configured the endpoints answer 503 GIF_DISABLED so the
	// client can hide the picker rather than discover a 404.
	MountGIFRoutes(r, database, limiter, cfg)
	if cfg.GIF.APIKey == "" {
		slog.Info("gif.api_key not set — GIF picker disabled (clients will hide it)")
	}

	// DM REST routes are mounted after hub creation (below) so the hub can
	// be passed as a DMBroadcaster for real-time close events.

	// File upload and serving routes.
	store, storeErr := routerUploadRoutes(r, database, limiter, cfg, svc.Permissions)

	// WebSocket hub — built, wired and started by internal/app; WS does its
	// own in-band auth, so no AuthMiddleware here.
	hub := rt.Hub
	getOnlineUsers = func() int { return hub.ClientCount() }
	hubAlive = func() bool { return hub.DispatchAlive() }

	// Auth routes. The service is built after the hub, with the hub as its
	// AuthBroadcaster, so DELETE /api/v1/auth/account fans out member_ban and
	// force-disconnects the deleted user's own socket exactly like the admin
	// ban path does for the same DB state.
	MountAuthRoutes(r, service.NewAuthService(database, limiter, totpKey, hub), AuthMiddleware(database), limiter, cfg.Server.TrustedProxies)

	// Voice: webhook, LiveKit health and signalling-proxy routes. The client
	// and the companion process are built by internal/app, which reports
	// through rt.VoiceEnabled whether there is anything to mount.
	routerVoiceRoutes(r, cfg, limiter, hub, rt.VoiceEnabled)

	// Profile routes: update profile, change password, session management.
	// Mounted after hub creation so the hub can broadcast user_update events.
	// A storage failure leaves store unusable, so the avatar-upload route is
	// simply not registered; the rest of the profile surface is unaffected.
	// Built as a FileStore interface value from scratch — assigning the typed
	// nil pointer would produce a non-nil interface and defeat the mount-time
	// nil check.
	var profileStore FileStore
	if storeErr == nil {
		profileStore = store
	}
	MountProfileRoutes(r, database, svc, profileStore, limiter, cfg.Server.TrustedProxies, hub)

	// DM (direct message) REST routes — mounted after hub creation so the
	// hub can send real-time dm_channel_close events to WebSocket clients.
	MountDMRoutes(r, database, svc, hub)

	// Channel and message REST routes — mounted after hub creation so a
	// message purge can broadcast chat_bulk_deleted to the channel.
	MountChannelRoutes(r, database, svc, limiter, cfg.Server.TrustedProxies, hub)

	// Custom emoji REST routes — mounted after hub creation so an upload or a
	// delete can fan the new set out as an emoji_update. Requires the same file
	// storage the attachment routes use; without it the emoji endpoints are not
	// mounted at all (a 404 the client reads as "this server has no emoji").
	if storeErr == nil {
		MountEmojiRoutes(r, database, svc, store, limiter, hub)
	}

	// H-8: Connectivity diagnostics restricted to admin users only.
	// Exposes Go runtime version and LiveKit node IP which aid targeted attacks.
	r.With(AuthMiddleware(database),
		RequirePermission(permissions.Administrator),
		RateLimitMiddleware(limiter, "diag:", 5, time.Minute, cfg.Server.TrustedProxies)).
		Get("/api/v1/diagnostics/connectivity",
			handleDiagnosticsConnectivity(cfg, ver, hub))

	r.Get("/api/v1/ws", ws.ServeWS(hub, database, cfg.Server.AllowedOrigins, cfg.Server.MaxWSConnections))

	routerMetricsRoutes(r, cfg, database, svc, hub)

	// Admin panel: static files + REST API (Phase 6).
	// Restrict /admin to configured CIDRs (default: private networks only).
	u := updater.NewUpdater(ver, cfg.GitHub.Token, cfg.GitHub.Owner, cfg.GitHub.Repo)
	adminHandler := admin.NewHandler(database, ver, hub, u, logBuf, cfg.Server.AllowedOrigins, svc.Permissions, svc.Moderation, svc.Roles, svc.Settings,
		admin.SetupOptions{ConfigPath: config.DefaultPath, RunningCfg: cfg})
	r.Group(func(r chi.Router) {
		r.Use(AdminIPRestrict(cfg.Server.AdminAllowedCIDRs, cfg.Server.TrustedProxies))
		r.Mount("/admin", adminHandler)

		// Phase C Step 9 — plugin admin REST surface. The IP gate above is
		// only the outer perimeter; plugin lifecycle endpoints additionally
		// require a valid admin Bearer token via admin.RequireAdminAuth so a
		// LAN attacker on the allowed CIDR cannot install/enable plugins
		// without a session. The handler is wired with the live registry
		// constructed in main.go (nil when plugin support is disabled, in
		// which case lifecycle calls return 503 and list returns []).
		r.Group(func(r chi.Router) {
			r.Use(admin.RequireAdminAuth(database))
			r.Mount("/api/v1/admin/plugins", NewPluginAdminHandler(pluginRegistry, database, database))
		})
	})

	// Client auto-update endpoint (unauthenticated). Per-IP rate limited to
	// bound abuse; the signature fetch is cached inside the updater (DoS fix).
	// Dedicated key prefix (mirroring "livekit_proxy:"): the empty-prefix
	// middleware would share per-IP buckets with verify-totp, password change,
	// and the other sensitive endpoints, so a client's 30/min auto-poll could
	// 429 its user's own 2FA or password change.
	MountClientUpdateRoute(
		r.With(rateLimitMiddlewareWithPrefix(limiter, "client_update:", clientUpdateRateLimitPerMinute, time.Minute, cfg.Server.TrustedProxies)),
		u,
	)

	// Issue 15: Warn if AllowedOrigins contains wildcard.
	if slices.Contains(cfg.Server.AllowedOrigins, "*") {
		slog.Warn("AllowedOrigins contains wildcard '*' — consider restricting to specific origins for production use")
	}

	cleanup := func() {
		close(limiterStopCh)
	}

	return r, cleanup
}

// routerTOTPKey loads (or auto-generates) the AES-256 key NewRouter hands to the
// auth routes for TOTP secret encryption (M1).
func routerTOTPKey(cfg *config.Config) []byte {
	totpKey, totpKeyErr := auth.LoadOrGenerateTOTPKey(cfg.Server.DataDir)
	if totpKeyErr != nil {
		if cfg.Server.DataDir != "" {
			// A configured data directory means this is a real deployment —
			// main.go creates cfg.Server.DataDir before calling NewRouter, so
			// by this point LoadOrGenerateTOTPKey only fails for a malformed
			// OWNCORD_TOTP_KEY or a corrupt/truncated totp.key file, never for
			// a missing directory. (The zero-value "" DataDir used by handler
			// tests that never touch TOTP crypto is exempted below so the
			// existing test suite keeps passing.)
			//
			// Continuing here would leave totpKey nil: every AES call in
			// auth.EncryptTOTPSecret/DecryptTOTPSecret then hits
			// aes.NewCipher(nil) and 500s, so every 2FA-enabled account
			// (including the owner) would be locked out of login and unable
			// to re-enroll, forever, while /health kept reporting OK. Refuse
			// to start instead.
			panic(fmt.Sprintf("api: failed to load TOTP encryption key: %v", totpKeyErr))
		}
		slog.Error("failed to load TOTP encryption key", "error", totpKeyErr)
		// Fall through — only reachable when DataDir is unset; TOTP handlers
		// cannot encrypt/decrypt until a data directory is configured.
	}
	return totpKey
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
			// Reader pool, not the writer: a scheduled backup's VACUUM INTO
			// holds the sole writer connection for its whole duration, and
			// the server keeps serving reads throughout — /health must not
			// call that outage (see db.PingRead).
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
	}
}

// routerMiddleware installs NewRouter's global middleware stack. The order is a
// security property (request-id binding before the logger reads it, tracing
// before panic recovery so the panic log carries the trace id, security
// headers and the body cap before any handler runs) — keep it exactly as
// written.
func routerMiddleware(r chi.Router, cfg *config.Config) {
	// Middleware stack.
	r.Use(boundRequestID) // must precede RequestID — it reads the header verbatim
	r.Use(middleware.RequestID)
	r.Use(setRequestIDHeader) // echo request ID into response header
	// NOTE: middleware.RealIP is intentionally omitted — trusting X-Real-IP from
	// any source allows IP spoofing for rate-limit bypass. IP header trust is now
	// handled explicitly in clientIPWithProxies using the trusted_proxies config.
	// Phase B Step 8 — OpenTelemetry HTTP tracing. No-op when telemetry is
	// disabled or the otel build tag is not set, so this is safe to mount
	// unconditionally. Mounted ahead of recoverer, which snapshots the trace
	// id before dispatch: the span must already exist for the panic record to
	// carry trace_id (OC-0346).
	r.Use(telemetry.HTTPMiddleware())
	r.Use(recoverer)     // slog-routing panic recovery (replaces chi's stderr-only Recoverer)
	r.Use(requestLogger) // structured request/response logging
	r.Use(SecurityHeadersWithTLS(cfg.TLS.Mode))
	r.Use(MaxBodySizeUnless(defaultMaxBodySize, bodyCapExemptPrefixes...))

	// Coraza WAF — opt-in via config.
	if cfg.Server.WAFEnabled {
		r.Use(NewWAFMiddlewareCRS(cfg.Server.WAFParanoiaLevel, cfg.Server.WAFCRSMode))
	}
}

// routerUploadRoutes mounts the file upload and serving routes and returns the
// shared file storage (and its construction error) for the profile-avatar and
// emoji mounts, which reuse the same store.
func routerUploadRoutes(r chi.Router, database *db.DB, limiter *auth.RateLimiter, cfg *config.Config, permSvc *service.PermissionService) (*storage.Storage, error) {
	// L12: verify config upload size fits within the HTTP body limit.
	if int64(cfg.Upload.MaxSizeMB)<<20 > uploadMaxBodySize {
		slog.Warn("upload.max_size_mb exceeds HTTP body limit, capping",
			"configured_mb", cfg.Upload.MaxSizeMB,
			"http_limit_bytes", uploadMaxBodySize)
	}
	store, storeErr := storage.New(cfg.Upload.StorageDir, cfg.Upload.MaxSizeMB)
	if storeErr != nil {
		slog.Error("failed to create file storage", "error", storeErr)
	} else {
		MountUploadRoutes(r, database, store, limiter, cfg.Server.AllowedOrigins, permSvc)
	}
	return store, storeErr
}

// routerVoiceRoutes mounts the LiveKit webhook, health and signalling-proxy
// routes. voiceEnabled is internal/app's report that the LiveKit client was
// built (StartRuntime); voice is disabled — and none of these routes are
// mounted — when it was not. Until B3-3 this function also created the client
// and the companion process, which is what gave the hub a second owner.
func routerVoiceRoutes(r chi.Router, cfg *config.Config, limiter *auth.RateLimiter, hub *ws.Hub, voiceEnabled bool) {
	if !voiceEnabled {
		return
	}

	// LiveKit webhook endpoint (no auth middleware — uses LiveKit JWT
	// verification). The IP gate is defence-in-depth on top of that signature
	// check, with its own allowlist key (livekit_webhook_allowed_cidrs) so an
	// externally-hosted LiveKit can be admitted WITHOUT widening the admin
	// panel's perimeter to the SFU's network. Falls back to
	// admin_allowed_cidrs when unset.
	webhookCIDRs := cfg.Server.LiveKitWebhookCIDRs()
	r.With(AdminIPRestrict(webhookCIDRs, cfg.Server.TrustedProxies)).
		Post("/api/v1/livekit/webhook",
			ws.MountWebhookRoute(hub, cfg.Voice.LiveKitAPIKey, cfg.Voice.LiveKitAPISecret))

	// LiveKit health check — same perimeter as the webhook.
	r.With(AdminIPRestrict(webhookCIDRs, cfg.Server.TrustedProxies)).
		Get("/api/v1/livekit/health", handleLiveKitHealth(hub))

	// Reverse proxy LiveKit signaling through OwnCord's HTTPS server.
	// This avoids mixed-content blocks (secure page → insecure WS).
	// Client connects to wss://server:8443/livekit/* → ws://localhost:7880/*
	//
	// NOTE: AuthMiddleware is intentionally omitted. The LiveKit JS SDK's
	// signal requests don't carry OwnCord session tokens — authentication
	// is handled by the LiveKit JWT (access_token query param) which the
	// LiveKit server validates. Users can only obtain a valid JWT through
	// the authenticated voice_join WS flow. Rate limiting prevents abuse.
	r.With(rateLimitMiddlewareWithPrefix(limiter, "livekit_proxy:", livekitProxyRateLimitPerMinute, time.Minute, cfg.Server.TrustedProxies)).
		Handle("/livekit/*", http.StripPrefix("/livekit", NewLiveKitProxy(cfg.Voice.LiveKitURL, cfg.Server.AllowedOrigins)))
}

// routerMetricsRoutes mounts the JSON metrics endpoint and, when an OTel
// Prometheus exporter is wired, the Prometheus handler beside it.
func routerMetricsRoutes(r chi.Router, cfg *config.Config, database *db.DB, svc *service.Services, hub *ws.Hub) {
	// Metrics endpoint — IP-restricted by metrics_allowed_cidrs (falls back to
	// admin_allowed_cidrs) so a central scraper can be admitted without
	// widening /admin. The shape is documented in docs/deployment.md — keep
	// the two in sync.
	r.With(AdminIPRestrict(cfg.Server.MetricsCIDRs(), cfg.Server.TrustedProxies)).
		Get("/api/v1/metrics", handleMetrics(MetricsSources{
			ConnectedUsers: hub.ClientCount,
			VoiceSessions:  hub.VoiceSessionCount,
			BroadcastDrops: hub.BroadcastDropCount,
			LiveKitHealth:  hub.LiveKitHealthCheck,
			ReconnectTiers: hub.ReconnectTierStats,
			Backpressure:   hub.BackpressureStats,
			ConnRejects:    hub.ConnRejectCount,
			PersisterStats: hub.EventPersisterStats,
			DBStats:        func() sql.DBStats { return database.SQLDb().Stats() },
			PermCache:      svc.Permissions.CacheStats,
			DiskFree:       func() (uint64, error) { return diskutil.FreeBytes(cfg.Server.DataDir) },
		}))

	// Phase B Step 8 — OpenTelemetry Prometheus exporter. Mounted alongside
	// the legacy JSON endpoint when a Prometheus exporter is wired (otel
	// build, exporter == "prometheus"). Returns 404 in the default no-op build
	// because telemetry.PrometheusHandler() returns nil.
	if promH := telemetry.PrometheusHandler(); promH != nil {
		r.With(AdminIPRestrict(cfg.Server.MetricsCIDRs(), cfg.Server.TrustedProxies)).
			Mount("/metrics", promH)
	}
}

// serverStartTime records when the process started; used for uptime in /health.
var serverStartTime = time.Now()

// healthResponse is the JSON shape returned by GET /health.
type healthResponse struct {
	Status      string `json:"status"` // "ok" | "degraded"
	Uptime      int64  `json:"uptime"`
	OnlineUsers int    `json:"online_users"`
	// Reason names the degraded subsystem ("hub", "database", "disk") and
	// nothing more — this endpoint is unauthenticated, so no error details.
	Reason string `json:"reason,omitempty"`
}

// healthDeps are the liveness probes behind GET /health. Any nil field is
// skipped (treated as healthy) so partial wirings and tests stay simple.
type healthDeps struct {
	onlineUsers   func() int
	dbPing        func(context.Context) error
	dispatchAlive func() bool
	freeDiskBytes func() (uint64, error)
}

const (
	// healthCacheTTL bounds how often the real checks run: the endpoint is
	// unauthenticated AND rate-limit-exempt, so an uncached DB ping per
	// request would be a free amplification lever.
	healthCacheTTL = 5 * time.Second
	// healthDBPingTimeout bounds the SELECT 1 so a wedged writer degrades the
	// health report instead of hanging it.
	healthDBPingTimeout = 1 * time.Second
	// healthMinFreeDiskBytes is the free-space floor under which health
	// reports degraded. SQLite WAL growth, uploads, and backups all share the
	// data volume, so running dry corrupts more than one thing at once.
	healthMinFreeDiskBytes = 256 << 20 // 256 MiB
)

// infoResponse is the JSON shape returned by GET /api/v1/info.
type infoResponse struct {
	Name string `json:"name"`
}

func handleHealth(deps healthDeps) http.HandlerFunc {
	// C-2: Version removed from unauthenticated health endpoint to prevent
	// server fingerprinting. Version is available on the authenticated
	// diagnostics endpoint instead.
	var mu syncutil.Mutex
	var cachedAt time.Time
	var cachedStatus, cachedReason string
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if time.Since(cachedAt) >= healthCacheTTL {
			// WithoutCancel: the result is cached and served to every caller
			// for the next healthCacheTTL, so it must not inherit THIS
			// request's cancellation — a probe that disconnects mid-check
			// would otherwise poison the shared cache with a false
			// "degraded/database" verdict. The DB ping carries its own 1s
			// timeout, so the checks stay bounded regardless.
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
	if deps.freeDiskBytes != nil {
		if free, err := deps.freeDiskBytes(); err == nil && free < healthMinFreeDiskBytes {
			return "degraded", "disk"
		}
	}
	return "ok", ""
}

func handleInfo(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// C-2: Version removed from unauthenticated info endpoint.
		writeJSON(w, http.StatusOK, infoResponse{
			Name: cfg.Server.Name,
		})
	}
}

// livekitHealthResponse is the JSON shape returned by GET /api/v1/livekit/health.
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
// maxRequestIDLen bytes or is not plain printable ASCII, so the
// middleware.RequestID mounted straight after it generates a server-side id
// instead. Without this, chi adopts the header verbatim and the value is
// retained by the admin ring buffer (2000 entries) and echoed back in the
// response header — a one-shot burst of ~1 MiB ids pins hundreds of MB of heap.
//
// The value is dropped rather than truncated: a truncated id is not the
// client's id, so it correlates with nothing while still parking
// attacker-chosen bytes in the log. The request is served either way, and the
// server-generated id is still returned in the X-Request-Id response header.
func boundRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := r.Header.Get(middleware.RequestIDHeader); id != "" && !validRequestID(id) {
			r.Header.Del(middleware.RequestIDHeader)
		}
		next.ServeHTTP(w, r)
	})
}

// validRequestID reports whether id is short enough and printable enough to
// carry through logs and the response header.
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

// truncateForLog bounds a client-controlled string before it becomes a log
// attribute, so it cannot inflate the retained ring-buffer entries.
func truncateForLog(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "...(truncated)"
}

// setRequestIDHeader copies the request ID from context into the response header.
func setRequestIDHeader(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := middleware.GetReqID(r.Context())
		if requestID != "" {
			w.Header().Set("X-Request-Id", requestID)
		}
		next.ServeHTTP(w, r)
	})
}

// recoverer recovers from panics in HTTP handlers and logs them through slog —
// so they reach the admin log stream and are structured — unlike chi's default
// middleware.Recoverer, which writes an unstructured stack to stderr only. The
// stack is captured via stackutil so it never embeds argument values (which on
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
				w.WriteHeader(http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// requestLogger logs every HTTP request with method, path, status, and duration.
// Health checks are logged at Debug level to avoid noise.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		elapsed := time.Since(start)
		status := ww.Status()

		// Health checks at Debug level; errors at Warn; everything else at Info.
		path := r.URL.Path
		reqID := middleware.GetReqID(r.Context())
		attrs := []any{
			"method", r.Method,
			"path", truncateForLog(path, maxLoggedPathLen),
			"status", status,
			"duration_ms", elapsed.Milliseconds(),
			"bytes", ww.BytesWritten(),
			"client_ip", clientIP(r),
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

// writeJSON encodes v as JSON and writes it to w with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("writeJSON: failed to encode response", "error", err)
	}
}
