package admin

import (
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/go-chi/chi/v5"
)

// setupLimiterReapInterval and setupLimiterReapMaxWindow control how often
// the setup endpoint's dedicated rate limiter reaps stale window entries.
// Vars, not consts, so tests can shrink them instead of waiting on the real
// interval (see export_test.go).
var (
	setupLimiterReapInterval  = 5 * time.Minute
	setupLimiterReapMaxWindow = 15 * time.Minute
)

// setupLimiterHook, when non-nil, receives the *auth.RateLimiter NewAdminAPI
// creates for the /setup endpoint. Test-only seam: NewAdminAPI returns only
// an http.Handler, so tests otherwise have no way to reach that limiter to
// verify it gets reaped.
var setupLimiterHook func(*auth.RateLimiter)

// startSetupLimiterReap keeps rl's window map bounded for the life of the
// process. Every distinct source IP that ever hits POST /setup leaves an
// entry that Allow itself only prunes on a repeat call from that same key —
// a one-shot caller's entry sits forever unless something sweeps the whole
// map. api/router.go reaps its own limiter with RateLimiter.StartCleanup, a
// goroutine parked in a ticker select until a stop channel closes — but
// NewAdminAPI has no shutdown hook and is called directly by ~180 tests that
// never capture one, so a parked goroutine here would leak under every
// test's goleak check. time.AfterFunc self-rescheduling avoids that: between
// fires there is no live goroutine, only a runtime timer, so nothing needs
// to stop it.
func startSetupLimiterReap(rl *auth.RateLimiter) {
	// Capture the timing once, synchronously, on the caller's goroutine.
	// The rescheduled AfterFunc callbacks below must never re-read the
	// package vars themselves: those callbacks run on their own goroutine
	// indefinitely (nothing stops the chain), so a later test's
	// SetSetupLimiterReapTiming restoring the vars on its own goroutine
	// would otherwise race an in-flight reap here.
	interval, maxWindow := setupLimiterReapInterval, setupLimiterReapMaxWindow
	var reap func()
	reap = func() {
		rl.Cleanup(maxWindow)
		time.AfterFunc(interval, reap)
	}
	time.AfterFunc(interval, reap)
}

// ─── NewAdminAPI ──────────────────────────────────────────────────────────────

// NewAdminAPI returns a chi router with all /admin/api/* routes. All routes
// except the unauthenticated setup endpoints are protected by
// adminAuthMiddleware, which admits any role holding a bit of
// permissions.AdminPerimeter; route groups then require the specific bit
// (requirePerm) or the Owner role (ownerOnlyMiddleware).
//
// The optional trailing SetupOptions enables the first-run wizard's
// config.yaml write-back and restart; without it the setup endpoints keep
// their legacy account-only behaviour (the case in most tests).
func NewAdminAPI(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater, logBuf *RingBuffer, allowedOrigins []string, permInvalidator PermissionInvalidator, mod *service.ModerationService, roles *service.RoleService, settings *service.SettingsService, channels *service.ChannelService, opts ...SetupOptions) http.Handler {
	r := chi.NewRouter()

	var setupOpts SetupOptions
	if len(opts) > 0 {
		setupOpts = opts[0]
	}

	// Setup endpoints — unauthenticated, only functional when no users exist.
	setupLimiter := auth.NewRateLimiter()
	if setupLimiterHook != nil {
		setupLimiterHook(setupLimiter)
	}
	startSetupLimiterReap(setupLimiter)
	r.Get("/setup/status", handleSetupStatus(database, setupOpts))
	r.Post("/setup", handleSetup(database, setupLimiter, allowedOrigins, hub, setupOpts))

	// SSE log stream — auth is via a single-use ticket from POST /logs/ticket.
	// EventSource cannot send Authorization headers, so the client first
	// obtains a short-lived ticket via the authenticated ticket endpoint,
	// then passes it as ?ticket= to the SSE stream.
	if logBuf != nil {
		r.Get("/logs/stream", handleLogStream(database, logBuf))
	}

	// All remaining routes require authentication plus at least one
	// moderation-capable bit (permissions.AdminPerimeter). Route groups that
	// map onto a specific bit re-check it with requirePerm; the rest
	// (stats, users list, me) are perimeter-level.
	r.Group(func(r chi.Router) {
		r.Use(adminAuthMiddleware(database))

		// Log stream ticket — issues a single-use, 30s TTL ticket for SSE auth.
		// ADMINISTRATOR-gated to match handleLogStream's own re-check: server
		// logs are not scoped to any narrower moderation bit.
		r.With(requirePerm(permissions.Administrator)).
			Post("/logs/ticket", handleLogTicket(database))

		r.Get("/stats", handleGetStats(database, hub))
		r.Get("/me", handleGetMe())
		r.Get("/users", handleListUsers(database))
		// Ban/unban and role change are authorized inside ModerationService
		// (BAN_MEMBERS / MANAGE_ROLES + hierarchy), so the route itself stays
		// perimeter-level — a moderator with only BAN_MEMBERS must reach it.
		r.Patch("/users/{id}", handlePatchUser(database, hub, permInvalidator, mod))
		r.With(requirePerm(permissions.KickMembers)).
			Delete("/users/{id}/sessions", handleForceLogout(mod))

		r.Group(func(r chi.Router) {
			r.Use(requirePerm(permissions.ManageChannels))
			r.Get("/channels", handleListChannels(channels))
			r.Post("/channels", handleCreateChannel(channels, hub))
			r.Patch("/channels/{id}", handlePatchChannel(channels, hub))
			r.Delete("/channels/{id}", handleDeleteChannel(channels, hub))
			r.Get("/channels/{id}/permissions", handleGetChannelPermissions(database, channels))
			r.Put("/channels/{id}/permissions/{roleId}", handlePutChannelPermission(database, channels, hub, permInvalidator))
			r.Delete("/channels/{id}/permissions/{roleId}", handleDeleteChannelPermission(database, channels, hub, permInvalidator))
			// Per-user overrides — the last layer of the resolution order,
			// gated on the same MANAGE_CHANNELS bit as the role layer.
			r.Put("/channels/{id}/user-permissions/{userId}", handlePutChannelUserPermission(database, channels, hub, permInvalidator))
			r.Delete("/channels/{id}/user-permissions/{userId}", handleDeleteChannelUserPermission(database, channels, hub, permInvalidator))
		})

		// Role CRUD. MANAGE_ROLES gates the group; RoleService additionally
		// enforces the hierarchy (manage only roles below your own position,
		// never grant a bit your role lacks) and refuses to delete the Owner
		// or the default role.
		r.Group(func(r chi.Router) {
			r.Use(requirePerm(permissions.ManageRoles))
			r.Get("/roles", handleListRoles(roles))
			r.Post("/roles", handleCreateRole(database, hub, roles))
			// Registered before /roles/{id} so "reorder" is never parsed as an id.
			r.Patch("/roles/reorder", handleReorderRoles(hub, permInvalidator, roles))
			r.Patch("/roles/{id}", handlePatchRole(database, hub, permInvalidator, roles))
			r.Delete("/roles/{id}", handleDeleteRole(database, hub, permInvalidator, roles))
		})

		r.With(requirePerm(permissions.ViewAuditLog)).
			Get("/audit-log", handleGetAuditLog(database))
		// API tokens — Owner-only. Minting a network-reachable, revocation-
		// surviving bearer credential is gated like backups/updates.
		r.Get("/tokens", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(handleListAPITokens(database)).ServeHTTP(w, req)
		}))
		r.Post("/tokens", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(handleCreateAPIToken(database)).ServeHTTP(w, req)
		}))
		r.Delete("/tokens/{id}", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(handleRevokeAPIToken(database)).ServeHTTP(w, req)
		}))
		r.Group(func(r chi.Router) {
			r.Use(requirePerm(permissions.ManageServer))
			r.Get("/settings", handleGetSettings(settings))
			r.Patch("/settings", handlePatchSettings(settings))
		})
		r.Post("/backup", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(handleBackup(database)).ServeHTTP(w, req)
		}))
		r.Get("/backups", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(handleListBackups()).ServeHTTP(w, req)
		}))
		r.Delete("/backups/{name}", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(handleDeleteBackup(database)).ServeHTTP(w, req)
		}))
		r.Post("/backups/{name}/restore", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(handleRestoreBackup(database, hub)).ServeHTTP(w, req)
		}))
		r.Get("/updates", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(handleCheckUpdate(u)).ServeHTTP(w, req)
		}))
		r.Post("/updates/apply", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(handleApplyUpdate(u, hub, version)).ServeHTTP(w, req)
		}))
	})

	return r
}
