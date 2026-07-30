// Package api provides the HTTP router and handlers for the OwnCord server.
package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/owncord/server/admin"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/plugin"
	"github.com/owncord/server/service"
	"github.com/owncord/server/stackutil"
	"github.com/owncord/server/storage"
	"github.com/owncord/server/telemetry"
	"github.com/owncord/server/updater"
	"github.com/owncord/server/ws"
)

// NewRouter builds and returns the fully configured HTTP handler, the
// WebSocket hub (so the caller can call hub.GracefulStop on shutdown), and a
// cleanup function that stops background goroutines (e.g. rate-limiter cleanup).
//
// pluginRegistry may be nil — in that case the plugin admin endpoints respond
// with 503 on lifecycle calls and an empty list on read.
func NewRouter(cfg *config.Config, database *db.DB, ver string, logBuf *admin.RingBuffer, pluginRegistry *plugin.Registry) (http.Handler, *ws.Hub, func()) {
	r := chi.NewRouter()

	// Middleware stack.
	r.Use(boundRequestID) // must precede RequestID — it reads the header verbatim
	r.Use(middleware.RequestID)
	r.Use(setRequestIDHeader) // echo request ID into response header
	// NOTE: middleware.RealIP is intentionally omitted — trusting X-Real-IP from
	// any source allows IP spoofing for rate-limit bypass. IP header trust is now
	// handled explicitly in clientIPWithProxies using the trusted_proxies config.
	r.Use(recoverer)     // slog-routing panic recovery (replaces chi's stderr-only Recoverer)
	r.Use(requestLogger) // structured request/response logging
	// Phase B Step 8 — OpenTelemetry HTTP tracing. No-op when telemetry is
	// disabled or the otel build tag is not set, so this is safe to mount
	// unconditionally.
	r.Use(telemetry.HTTPMiddleware())
	r.Use(SecurityHeadersWithTLS(cfg.TLS.Mode))
	r.Use(MaxBodySizeUnless(defaultMaxBodySize, "/api/v1/uploads")) // upload route exempt

	// Coraza WAF — opt-in via config.
	if cfg.Server.WAFEnabled {
		r.Use(NewWAFMiddleware(cfg.Server.WAFParanoiaLevel))
	}

	// Health check — unauthenticated, no versioning prefix.
	// The online user count callback is set after hub creation below.
	var getOnlineUsers func() int
	r.Get("/health", handleHealth(func() int {
		if getOnlineUsers != nil {
			return getOnlineUsers()
		}
		return 0
	}))

	// Shared rate limiter for auth endpoints. Lockouts are persisted to the
	// database so they survive server restarts (M2 security hardening).
	limiter := auth.NewPersistentRateLimiter(database)

	// Start background cleanup of stale rate-limiter entries to prevent
	// unbounded memory growth. The goroutine exits when stopCh is closed.
	limiterStopCh := make(chan struct{})
	go limiter.StartCleanup(rateLimiterCleanupInterval, rateLimiterCleanupMaxWindow, limiterStopCh)

	// Versioned API routes.
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/health", handleHealth(func() int {
			if getOnlineUsers != nil {
				return getOnlineUsers()
			}
			return 0
		}))
		r.Get("/info", handleInfo(cfg))
	})

	// Load (or auto-generate) the AES-256 key for TOTP secret encryption (M1).
	totpKey, totpKeyErr := auth.LoadOrGenerateTOTPKey(cfg.Server.DataDir)
	if totpKeyErr != nil {
		slog.Error("failed to load TOTP encryption key", "error", totpKeyErr)
		// Fall through — handlers will still work but cannot encrypt/decrypt.
		// This should not happen in practice since LoadOrGenerateTOTPKey
		// auto-generates a key when none exists.
	}

	// Service layer — centralizes business logic for REST and WS handlers.
	// *db.DB satisfies service.Store directly (the store abstraction was
	// removed in D3).
	svc := service.New(database, limiter)

	// Auth routes: register, login, logout, me.
	MountAuthRoutes(r, database, limiter, cfg.Server.TrustedProxies, totpKey)

	// Profile routes are mounted after hub creation (below) so the hub can
	// broadcast user_update events for real-time profile changes.

	// Invite management routes (require MANAGE_INVITES permission).
	MountInviteRoutes(r, database, svc)

	// Channel and message REST routes.
	MountChannelRoutes(r, database, svc, limiter, cfg.Server.TrustedProxies)

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
		MountUploadRoutes(r, database, store, limiter, cfg.Server.AllowedOrigins, svc.Permissions)
	}

	// WebSocket hub — WS does its own in-band auth, so no AuthMiddleware here.
	hub := ws.NewHub(database, limiter, svc)
	getOnlineUsers = func() int { return hub.ClientCount() }

	// Phase C Step 9 — wire plugin registry and event sink into the hub.
	// nil pluginRegistry means plugins are disabled; the hub no-ops cleanly.
	if pluginRegistry != nil {
		hub.SetPluginRegistry(pluginRegistry)
		sink := pluginRegistry.Sink()
		sink.SetBroadcaster(hub.BroadcastToChannel)
		hub.SetPluginEventSink(sink)
	}

	// Create LiveKit client if voice config is present; voice is disabled on failure.
	lk, lkErr := ws.NewLiveKitClient(&cfg.Voice)
	if lkErr != nil {
		slog.Warn("failed to create LiveKit client, voice disabled", "error", lkErr)
	} else {
		hub.SetLiveKit(lk)

		// Optionally start a companion LiveKit process.
		if cfg.Voice.LiveKitBinaryPath != "" {
			proc := ws.NewLiveKitProcess(&cfg.Voice, &cfg.TLS, cfg.Server.DataDir)
			if startErr := proc.Start(); startErr != nil {
				slog.Error("failed to start LiveKit process", "error", startErr)
			} else {
				hub.SetLiveKitProcess(proc)
			}
		}
	}

	// Warn if LiveKit is externally managed and webhook may be blocked by admin CIDRs.
	if lkErr == nil && cfg.Voice.LiveKitBinaryPath == "" {
		lkHost := ""
		if u, parseErr := url.Parse(cfg.Voice.LiveKitURL); parseErr == nil {
			lkHost = u.Hostname()
		}
		if lkHost != "" && lkHost != "localhost" && lkHost != "127.0.0.1" && lkHost != "::1" {
			slog.Warn("LiveKit is externally managed but webhook endpoint is admin-IP-restricted — "+
				"ensure the LiveKit server's IP is in admin_allowed_cidrs or webhooks will be silently dropped",
				"livekit_host", lkHost)
		}
	}

	// LiveKit webhook endpoint (no auth middleware — uses LiveKit JWT verification).
	if lkErr == nil {
		r.With(AdminIPRestrict(cfg.Server.AdminAllowedCIDRs, cfg.Server.TrustedProxies)).
			Post("/api/v1/livekit/webhook",
				ws.MountWebhookRoute(hub, cfg.Voice.LiveKitAPIKey, cfg.Voice.LiveKitAPISecret))

		// LiveKit health check — admin-IP-restricted.
		r.With(AdminIPRestrict(cfg.Server.AdminAllowedCIDRs, cfg.Server.TrustedProxies)).
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

	// Profile routes: update profile, change password, session management.
	// Mounted after hub creation so the hub can broadcast user_update events.
	MountProfileRoutes(r, database, svc, limiter, cfg.Server.TrustedProxies, hub)

	// DM (direct message) REST routes — mounted after hub creation so the
	// hub can send real-time dm_channel_close events to WebSocket clients.
	MountDMRoutes(r, database, svc, hub)

	// H-8: Connectivity diagnostics restricted to admin users only.
	// Exposes Go runtime version and LiveKit node IP which aid targeted attacks.
	r.With(AuthMiddleware(database),
		RequirePermission(permissions.Administrator),
		RateLimitMiddleware(limiter, 5, time.Minute, cfg.Server.TrustedProxies)).
		Get("/api/v1/diagnostics/connectivity",
			handleDiagnosticsConnectivity(cfg, ver, hub))

	go hub.Run()
	r.Get("/api/v1/ws", ws.ServeWS(hub, database, cfg.Server.AllowedOrigins))

	// Metrics endpoint — admin-IP-restricted, returns runtime stats as JSON.
	r.With(AdminIPRestrict(cfg.Server.AdminAllowedCIDRs, cfg.Server.TrustedProxies)).
		Get("/api/v1/metrics", handleMetrics(
			func() int { return hub.ClientCount() },
			func() int { return hub.VoiceSessionCount() },
			func() uint64 { return hub.BroadcastDropCount() },
			func(ctx context.Context) (bool, error) { return hub.LiveKitHealthCheck(ctx) },
		))

	// Phase B Step 8 — OpenTelemetry Prometheus exporter. Mounted alongside
	// the legacy JSON endpoint when a Prometheus exporter is wired (otel
	// build, exporter == "prometheus"). Returns 404 in the default no-op build
	// because telemetry.PrometheusHandler() returns nil.
	if promH := telemetry.PrometheusHandler(); promH != nil {
		r.With(AdminIPRestrict(cfg.Server.AdminAllowedCIDRs, cfg.Server.TrustedProxies)).
			Mount("/metrics", promH)
	}

	// Admin panel: static files + REST API (Phase 6).
	// Restrict /admin to configured CIDRs (default: private networks only).
	u := updater.NewUpdater(ver, cfg.GitHub.Token, cfg.GitHub.Owner, cfg.GitHub.Repo)
	adminHandler := admin.NewHandler(database, ver, hub, u, logBuf, cfg.Server.AllowedOrigins, svc.Permissions, svc.Moderation)
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
			r.Mount("/api/v1/admin/plugins", NewPluginAdminHandler(pluginRegistry, database))
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

	return r, hub, cleanup
}

// serverStartTime records when the process started; used for uptime in /health.
var serverStartTime = time.Now()

// healthResponse is the JSON shape returned by GET /health.
type healthResponse struct {
	Status      string `json:"status"`
	Uptime      int64  `json:"uptime"`
	OnlineUsers int    `json:"online_users"`
}

// infoResponse is the JSON shape returned by GET /api/v1/info.
type infoResponse struct {
	Name string `json:"name"`
}

func handleHealth(getOnlineUsers func() int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// C-2: Version removed from unauthenticated health endpoint to prevent
		// server fingerprinting. Version is available on the authenticated
		// diagnostics endpoint instead.
		writeJSON(w, http.StatusOK, healthResponse{
			Status:      "ok",
			Uptime:      int64(time.Since(serverStartTime).Seconds()),
			OnlineUsers: getOnlineUsers(),
		})
	}
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
				if rec == http.ErrAbortHandler {
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
