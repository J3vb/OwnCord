package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/diskutil"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

// routerHealthDeps builds the liveness probes behind the shared /health handler. getOnlineUsers and
// hubAlive are pointers because NewRouter assigns them once the hub exists; closures read them at request
// time.
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
			// Reader pool, not the writer: a SELECT 1 on the single writer would report a writer queue as a
			// liveness failure (see db.PingRead).
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

var serverStartTime = time.Now()

type healthResponse struct {
	Status      string `json:"status"` // "ok" | "degraded"
	Uptime      int64  `json:"uptime"`
	OnlineUsers int    `json:"online_users"`
	// Names the degraded subsystem ("hub", "database", "disk") and nothing more: unauthenticated, so no error
	// details.
	Reason string `json:"reason,omitempty"`
}

type healthDeps struct {
	onlineUsers   func() int
	dbPing        func(context.Context) error
	dispatchAlive func() bool
	freeDiskBytes func() (uint64, error)
	// The free-space floor under which health reports degraded (server.min_free_disk_mb, shared with the
	// start-up banner and upload path); WAL growth, uploads and backups share the volume. 0 disables the
	// check.
	minFreeDiskBytes uint64
}

const (
	// Bounds how often the real checks run: unauthenticated AND rate-limit-exempt, so an uncached ping would
	// be an amplification lever.
	healthCacheTTL = 5 * time.Second
	// Bounds the SELECT 1 so a wedged writer degrades the report instead of hanging it.
	healthDBPingTimeout = 1 * time.Second
)

// mountPublicV1 registers the unauthenticated /api/v1 routes; each must be in publicSurface
// (auth_posture_test.go) and keep build identity off.
func mountPublicV1(r chi.Router, cfg *config.Config, healthHandler http.HandlerFunc, svc *service.Services) {
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/health", healthHandler)
		r.Get("/info", handleInfo(cfg, svc))
		r.Get("/server-info", handleServerInfo(cfg, svc))
	})
}

type infoResponse struct {
	Name string `json:"name"`
}

func handleHealth(deps healthDeps) http.HandlerFunc {
	// Version is omitted to prevent fingerprinting; it is on the authenticated diagnostics endpoint.
	var mu syncutil.Mutex
	var cachedAt time.Time
	var cachedStatus, cachedReason string
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if time.Since(cachedAt) >= healthCacheTTL {
			// WithoutCancel: the result is cached, so a probe that disconnects mid-check must not poison the
			// shared cache with a false "degraded/database"; the DB ping has its own timeout, so checks stay
			// bounded.
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

// runHealthChecks probes the hub dispatch loop, the database and free disk, returning ("ok", "") or
// ("degraded", <subsystem>); first failure wins. Errors meaning "unknown" count as healthy, only a positive
// negative degrades.
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

func handleInfo(cfg *config.Config, svc *service.Services) http.HandlerFunc {
	var mu syncutil.Mutex
	var cachedAt time.Time
	cachedName := cfg.Server.Name
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if time.Since(cachedAt) >= serverInfoCacheTTL {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), serverInfoReadTimeout)
			name, err := liveServerName(ctx, cfg, svc)
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
		ok, err := hub.LiveKitHealthProbe(r.Context())
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
