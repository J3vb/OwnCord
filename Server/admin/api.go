package admin

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
	"github.com/owncord/server/updater"
)

// ─── NewAdminAPI ──────────────────────────────────────────────────────────────

// NewAdminAPI returns a chi router with all /admin/api/* routes. All routes
// are protected by adminAuthMiddleware which requires the ADMINISTRATOR bit,
// except for the setup endpoints which are unauthenticated.
func NewAdminAPI(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater, logBuf *RingBuffer) http.Handler {
	r := chi.NewRouter()

	// Setup endpoints — unauthenticated, only functional when no users exist.
	r.Get("/setup/status", handleSetupStatus(database))
	r.Post("/setup", handleSetup(database))

	// SSE log stream — does its own auth via query param token because
	// EventSource cannot send Authorization headers.
	if logBuf != nil {
		r.Get("/logs/stream", handleLogStream(logBuf, database))
	}

	// All remaining routes require authentication and ADMINISTRATOR permission.
	r.Group(func(r chi.Router) {
		r.Use(adminAuthMiddleware(database))

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
		r.Get("/backups", handleListBackups())
		r.Delete("/backups/{name}", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleDeleteBackup(database)).ServeHTTP(w, req)
		}))
		r.Post("/backups/{name}/restore", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleRestoreBackup(database)).ServeHTTP(w, req)
		}))
		r.Get("/updates", handleCheckUpdate(u))
		r.Post("/updates/apply", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleApplyUpdate(u, hub, version)).ServeHTTP(w, req)
		}))
	})

	return r
}
