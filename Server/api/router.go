// Package api provides the HTTP router and handlers for the OwnCord server.
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/owncord/server/admin"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
	"github.com/owncord/server/storage"
	"github.com/owncord/server/updater"
	"github.com/owncord/server/ws"
)

// NewRouter builds and returns the fully configured HTTP handler and the
// WebSocket hub (so the caller can call hub.GracefulStop on shutdown).
func NewRouter(cfg *config.Config, database *db.DB, ver string, logBuf *admin.RingBuffer) (http.Handler, *ws.Hub) {
	r := chi.NewRouter()

	// Middleware stack.
	r.Use(middleware.RequestID)
	r.Use(setRequestIDHeader) // echo request ID into response header
	// NOTE: middleware.RealIP is intentionally omitted — trusting X-Real-IP from
	// any source allows IP spoofing for rate-limit bypass. IP header trust is now
	// handled explicitly in clientIPWithProxies using the trusted_proxies config.
	r.Use(middleware.Recoverer)
	r.Use(requestLogger) // structured request/response logging
	r.Use(SecurityHeadersWithTLS(cfg.TLS.Mode))
	r.Use(MaxBodySizeUnless(1<<20, "/api/v1/uploads")) // 1 MiB default; upload route exempt

	// Health check — unauthenticated, no versioning prefix.
	// The online user count callback is set after hub creation below.
	var getOnlineUsers func() int
	r.Get("/health", handleHealth(ver, func() int {
		if getOnlineUsers != nil {
			return getOnlineUsers()
		}
		return 0
	}))

	// Shared rate limiter for auth endpoints.
	limiter := auth.NewRateLimiter()

	// Start background cleanup of stale rate-limiter entries to prevent
	// unbounded memory growth. The goroutine exits when stopCh is closed.
	limiterStopCh := make(chan struct{})
	go limiter.StartCleanup(5*time.Minute, 15*time.Minute, limiterStopCh)

	// Versioned API routes.
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/health", handleHealth(ver, func() int {
			if getOnlineUsers != nil {
				return getOnlineUsers()
			}
			return 0
		}))
		r.Get("/info", handleInfo(cfg, ver))
	})

	// Auth routes: register, login, logout, me.
	MountAuthRoutes(r, database, limiter, cfg.Server.TrustedProxies)

	// Invite management routes (require MANAGE_INVITES permission).
	MountInviteRoutes(r, database)

	// Channel and message REST routes.
	MountChannelRoutes(r, database)

	// DM REST routes are mounted after hub creation (below) so the hub can
	// be passed as a DMBroadcaster for real-time close events.

	// File upload and serving routes.
	store, storeErr := storage.New(cfg.Upload.StorageDir, cfg.Upload.MaxSizeMB)
	if storeErr != nil {
		slog.Error("failed to create file storage", "error", storeErr)
	} else {
		MountUploadRoutes(r, database, store, cfg.Server.AllowedOrigins)
	}

	// WebSocket hub — WS does its own in-band auth, so no AuthMiddleware here.
	hub := ws.NewHub(database, limiter)
	getOnlineUsers = func() int { return hub.ClientCount() }

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
		r.With(AdminIPRestrict(cfg.Server.AdminAllowedCIDRs)).
			Post("/api/v1/livekit/webhook",
				ws.MountWebhookRoute(hub, cfg.Voice.LiveKitAPIKey, cfg.Voice.LiveKitAPISecret))

		// LiveKit health check — admin-IP-restricted.
		r.With(AdminIPRestrict(cfg.Server.AdminAllowedCIDRs)).
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
		r.With(RateLimitMiddleware(limiter, 30, time.Minute)).
			Handle("/livekit/*", http.StripPrefix("/livekit", NewLiveKitProxy(cfg.Voice.LiveKitURL, cfg.Server.AllowedOrigins)))
	}

	// DM (direct message) REST routes — mounted after hub creation so the
	// hub can send real-time dm_channel_close events to WebSocket clients.
	MountDMRoutes(r, database, hub)

	// Connectivity diagnostics — any authenticated user can check.
	r.With(AuthMiddleware(database)).Get("/api/v1/diagnostics/connectivity",
		handleDiagnosticsConnectivity(cfg, ver, hub))

	go hub.Run()
	r.Get("/api/v1/ws", ws.ServeWS(hub, database, cfg.Server.AllowedOrigins))

	// Metrics endpoint — admin-IP-restricted, returns runtime stats as JSON.
	r.With(AdminIPRestrict(cfg.Server.AdminAllowedCIDRs)).
		Get("/api/v1/metrics", handleMetrics(
			func() int { return hub.ClientCount() },
			func() int { return hub.VoiceSessionCount() },
			func() (bool, error) { return hub.LiveKitHealthCheck() },
		))

	// Admin panel: static files + REST API (Phase 6).
	// Restrict /admin to configured CIDRs (default: private networks only).
	u := updater.NewUpdater(ver, cfg.GitHub.Token, "J3vb", "OwnCord")
	adminHandler := admin.NewHandler(database, ver, hub, u, logBuf)
	r.Group(func(r chi.Router) {
		r.Use(AdminIPRestrict(cfg.Server.AdminAllowedCIDRs))
		r.Mount("/admin", adminHandler)
	})

	// Client auto-update endpoint (unauthenticated).
	MountClientUpdateRoute(r, u)

	return r, hub
}

// serverStartTime records when the process started; used for uptime in /health.
var serverStartTime = time.Now()

// healthResponse is the JSON shape returned by GET /health.
type healthResponse struct {
	Status      string `json:"status"`
	Version     string `json:"version"`
	Uptime      int64  `json:"uptime"`
	OnlineUsers int    `json:"online_users"`
}

// infoResponse is the JSON shape returned by GET /api/v1/info.
type infoResponse struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func handleHealth(ver string, getOnlineUsers func() int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, healthResponse{
			Status:      "ok",
			Version:     ver,
			Uptime:      int64(time.Since(serverStartTime).Seconds()),
			OnlineUsers: getOnlineUsers(),
		})
	}
}

func handleInfo(cfg *config.Config, ver string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, infoResponse{
			Name:    cfg.Server.Name,
			Version: ver,
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
		ok, err := hub.LiveKitHealthCheck()
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
			"path", path,
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
	_ = json.NewEncoder(w).Encode(v)
}
