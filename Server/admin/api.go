package admin

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/updater"
)

// ─── NewAdminAPI ──────────────────────────────────────────────────────────────

// NewAdminAPI returns a chi router with all /admin/api/* routes. All routes
// are protected by adminAuthMiddleware which requires the ADMINISTRATOR bit,
// except for the setup endpoints which are unauthenticated.
func NewAdminAPI(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater, logBuf *RingBuffer, allowedOrigins []string) http.Handler {
	r := chi.NewRouter()

	// Setup endpoints — unauthenticated, only functional when no users exist.
	setupLimiter := auth.NewRateLimiter()
	r.Get("/setup/status", handleSetupStatus(database))
	r.Post("/setup", handleSetup(database, setupLimiter, allowedOrigins))

	// SSE log stream — auth is via a single-use ticket from POST /logs/ticket.
	// EventSource cannot send Authorization headers, so the client first
	// obtains a short-lived ticket via the authenticated ticket endpoint,
	// then passes it as ?ticket= to the SSE stream.
	if logBuf != nil {
		r.Get("/logs/stream", handleLogStream(database, logBuf))
	}

	// All remaining routes require authentication and ADMINISTRATOR permission.
	r.Group(func(r chi.Router) {
		r.Use(adminAuthMiddleware(database))

		// Log stream ticket — issues a single-use, 30s TTL ticket for SSE auth.
		r.Post("/logs/ticket", handleLogTicket(database))

		r.Get("/stats", handleGetStats(database, hub))
		r.Get("/users", handleListUsers(database))
		r.Patch("/users/{id}", handlePatchUser(database, hub))
		r.Delete("/users/{id}/sessions", handleForceLogout(database))
		r.Get("/channels", handleListChannels(database))
		r.Post("/channels", handleCreateChannel(database, hub))
		r.Patch("/channels/{id}", handlePatchChannel(database, hub))
		r.Delete("/channels/{id}", handleDeleteChannel(database, hub))
		r.Get("/audit-log", handleGetAuditLog(database))
		r.Get("/settings", handleGetSettings(database))
		r.Patch("/settings", handlePatchSettings(database))
		r.Post("/backup", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleBackup(database)).ServeHTTP(w, req)
		}))
		r.Get("/backups", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleListBackups()).ServeHTTP(w, req)
		}))
		r.Delete("/backups/{name}", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleDeleteBackup(database)).ServeHTTP(w, req)
		}))
		r.Post("/backups/{name}/restore", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleRestoreBackup(database, hub)).ServeHTTP(w, req)
		}))
		r.Get("/updates", handleCheckUpdate(u))
		r.Post("/updates/apply", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleApplyUpdate(u, hub, version)).ServeHTTP(w, req)
		}))
	})

	return r
}
