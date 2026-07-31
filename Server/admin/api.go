package admin

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
	"github.com/owncord/server/updater"
)

// ─── NewAdminAPI ──────────────────────────────────────────────────────────────

// NewAdminAPI returns a chi router with all /admin/api/* routes. All routes
// are protected by adminAuthMiddleware which requires the ADMINISTRATOR bit,
// except for the setup endpoints which are unauthenticated.
//
// The optional trailing SetupOptions enables the first-run wizard's
// config.yaml write-back and restart; without it the setup endpoints keep
// their legacy account-only behaviour (the case in most tests).
func NewAdminAPI(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater, logBuf *RingBuffer, allowedOrigins []string, permInvalidator PermissionInvalidator, mod *service.ModerationService, opts ...SetupOptions) http.Handler {
	r := chi.NewRouter()

	var setupOpts SetupOptions
	if len(opts) > 0 {
		setupOpts = opts[0]
	}

	// Setup endpoints — unauthenticated, only functional when no users exist.
	setupLimiter := auth.NewRateLimiter()
	r.Get("/setup/status", handleSetupStatus(database, setupOpts))
	r.Post("/setup", handleSetup(database, setupLimiter, allowedOrigins, hub, setupOpts))

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
		r.Patch("/users/{id}", handlePatchUser(database, hub, permInvalidator, mod))
		r.Delete("/users/{id}/sessions", handleForceLogout(database))
		r.Get("/channels", handleListChannels(database))
		r.Post("/channels", handleCreateChannel(database, hub))
		r.Patch("/channels/{id}", handlePatchChannel(database, hub))
		r.Delete("/channels/{id}", handleDeleteChannel(database, hub))
		r.Get("/channels/{id}/permissions", handleGetChannelPermissions(database))
		r.Put("/channels/{id}/permissions/{roleId}", handlePutChannelPermission(database, hub, permInvalidator))
		r.Delete("/channels/{id}/permissions/{roleId}", handleDeleteChannelPermission(database, hub, permInvalidator))
		r.Get("/audit-log", handleGetAuditLog(database))
		// API tokens — Owner-only. Minting a network-reachable, revocation-
		// surviving bearer credential is gated like backups/updates.
		r.Get("/tokens", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleListAPITokens(database)).ServeHTTP(w, req)
		}))
		r.Post("/tokens", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleCreateAPIToken(database)).ServeHTTP(w, req)
		}))
		r.Delete("/tokens/{id}", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleRevokeAPIToken(database)).ServeHTTP(w, req)
		}))
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
		r.Get("/updates", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleCheckUpdate(u)).ServeHTTP(w, req)
		}))
		r.Post("/updates/apply", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleApplyUpdate(u, hub, version)).ServeHTTP(w, req)
		}))
	})

	return r
}
