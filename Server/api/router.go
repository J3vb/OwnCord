// Package api provides the HTTP router and handlers for the OwnCord server.
package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// version is the server version string, overridden at build time via ldflags.
var version = "dev"

// NewRouter builds and returns the fully configured HTTP handler.
func NewRouter(cfg *config.Config, database *db.DB) http.Handler {
	r := chi.NewRouter()

	// Middleware stack.
	r.Use(middleware.RequestID)
	r.Use(setRequestIDHeader) // echo request ID into response header
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	// Health check — unauthenticated, no versioning prefix.
	r.Get("/health", handleHealth)

	// Shared rate limiter for auth endpoints.
	limiter := auth.NewRateLimiter()

	// Versioned API routes.
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/info", handleInfo(cfg))
	})

	// Auth routes: register, login, logout, me.
	MountAuthRoutes(r, database, limiter)

	// Invite management routes (require MANAGE_INVITES permission).
	MountInviteRoutes(r, database)

	// Channel and message REST routes.
	MountChannelRoutes(r, database)

	// WebSocket hub — WS does its own in-band auth, so no AuthMiddleware here.
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	r.Get("/api/v1/ws", ws.ServeWS(hub, database))

	return r
}

// healthResponse is the JSON shape returned by GET /health.
type healthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

// infoResponse is the JSON shape returned by GET /api/v1/info.
type infoResponse struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, healthResponse{
		Status:  "ok",
		Version: version,
	})
}

func handleInfo(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, infoResponse{
			Name:    cfg.Server.Name,
			Version: version,
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
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
