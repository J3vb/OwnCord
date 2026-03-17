// Package api provides the HTTP router and handlers for the OwnCord server.
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/owncord/server/admin"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
	"github.com/owncord/server/updater"
	"github.com/owncord/server/ws"
)

// NewRouter builds and returns the fully configured HTTP handler.
func NewRouter(cfg *config.Config, database *db.DB, ver string) http.Handler {
	r := chi.NewRouter()

	// Middleware stack.
	r.Use(middleware.RequestID)
	r.Use(setRequestIDHeader) // echo request ID into response header
	// NOTE: middleware.RealIP is intentionally omitted — trusting X-Real-IP from
	// any source allows IP spoofing for rate-limit bypass. IP header trust is now
	// handled explicitly in clientIPWithProxies using the trusted_proxies config.
	r.Use(middleware.Recoverer)
	r.Use(SecurityHeaders)
	r.Use(MaxBodySize(1 << 20)) // 1 MiB default; upload routes use their own limit

	// Health check — unauthenticated, no versioning prefix.
	r.Get("/health", handleHealth(ver))

	// Shared rate limiter for auth endpoints.
	limiter := auth.NewRateLimiter()

	// Versioned API routes.
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/health", handleHealth(ver))
		r.Get("/info", handleInfo(cfg, ver))
	})

	// Auth routes: register, login, logout, me.
	MountAuthRoutes(r, database, limiter)

	// Invite management routes (require MANAGE_INVITES permission).
	MountInviteRoutes(r, database)

	// Channel and message REST routes.
	MountChannelRoutes(r, database)

	// Voice credentials REST route.
	MountVoiceRoutes(r, cfg, database)

	// WebSocket hub — WS does its own in-band auth, so no AuthMiddleware here.
	hub := ws.NewHub(database, limiter)

	// Create SFU if voice config is present; voice is disabled on failure.
	sfu, sfuErr := ws.NewSFU(&cfg.Voice)
	if sfuErr != nil {
		slog.Warn("failed to create SFU, voice disabled", "error", sfuErr)
	} else {
		hub.SetSFU(sfu)
	}

	ws.InitSettingsCache(database)
	go hub.Run()
	r.Get("/api/v1/ws", ws.ServeWS(hub, database, cfg.Server.AllowedOrigins))

	// Admin panel: static files + REST API (Phase 6).
	u := updater.NewUpdater(ver, cfg.GitHub.Token, "J3vb", "OwnCord")
	r.Mount("/admin", admin.NewHandler(database, ver, hub, u))

	return r
}

// serverStartTime records when the process started; used for uptime in /health.
var serverStartTime = time.Now()

// healthResponse is the JSON shape returned by GET /health.
type healthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
	Uptime  int64  `json:"uptime"`
}

// infoResponse is the JSON shape returned by GET /api/v1/info.
type infoResponse struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func handleHealth(ver string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, healthResponse{
			Status:  "ok",
			Version: ver,
			Uptime:  int64(time.Since(serverStartTime).Seconds()),
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

// writeJSON encodes v as JSON and writes it to w with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
