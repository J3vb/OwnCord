package admin

import (
	"net/http"
	"slices"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/go-chi/chi/v5"
)

// setupLimiterReapInterval controls how often the setup endpoint's
// dedicated rate limiter reaps stale window entries. Cleanup is
// per-key-window-aware (auth/ratelimit.go's
// entry.window), so there is no separate max-window to tune here — each
// entry retires on its own window. The reap test runs on synctest's fake
// clock rather than shrinking this.
const setupLimiterReapInterval = 5 * time.Minute

// setupLimiterHook, when non-nil, receives the *auth.RateLimiter NewAdminAPI
// creates for the /setup endpoint. Test-only seam: NewAdminAPI returns only
// an http.Handler, so tests otherwise have no way to reach that limiter to
// verify it gets reaped.
var setupLimiterHook func(*auth.RateLimiter)

// startSetupLimiterReap keeps rl's window map bounded for the life of the
// process. Every distinct source IP that ever hits POST /setup leaves an
// entry that Allow itself only prunes on a repeat call from that same key —
// a one-shot caller's entry sits forever unless something sweeps the whole
// map. The app reaps the main limiter with RateLimiter.RunCleanup on its own
// cancellable context (internal/app/limiter_cleanup.go) — but
// mountUserRoutes registers the member-management routes under the
// authenticated perimeter. Ban/unban and role change are authorized inside
// ModerationService (BAN_MEMBERS / MANAGE_ROLES + hierarchy), so PATCH stays
// perimeter-level — a moderator with only BAN_MEMBERS must reach it.
// Force-logout is KICK_MEMBERS; account erasure is ERASE_ACCOUNTS or
// ADMINISTRATOR with the hierarchy re-checked in the service; recovery
// credentials are the owner's or an ISSUE_RECOVERY holder's, with the
// target's rank checked in the service.
func mountUserRoutes(r chi.Router, gates *gateRegistry, svc *service.Services, hub HubBroadcaster, mod *service.ModerationService) {
	mountMemberActionRoutes(r, "/users", svc, hub, mod)
	gates.route(r, gateEraseAccounts, http.MethodDelete, "/users/{id}", handleDeleteUser(mod, hub))
	gates.route(r, gateIssueRecovery, http.MethodPost, "/users/{id}/recovery-credential", handleIssueRecoveryCredential(svc.Auth))
}

// mountMemberActionRoutes registers the member-list actions the desktop client
// uses: list, ban/unban, role change (PATCH), add/remove one role (PUT/DELETE
// roles/{roleId}) and force-logout. They are
// mounted twice, under /admin/api/users for the panel and under
// /api/v1/moderation/members (NewMemberAPI) for the client, so both run the
// same handlers and the same ModerationService rank checks. The list sits at
// base itself, the per-user routes under base/{id}.
func mountMemberActionRoutes(r chi.Router, base string, svc *service.Services, hub HubBroadcaster, mod *service.ModerationService) {
	list := base
	if list == "" {
		list = "/"
	}
	r.Get(list, handleListUsers(svc.Users))
	r.Patch(base+"/{id}", handlePatchUser(svc.Users, hub, mod))
	// Add or remove one role of a member. Authorized in
	// ModerationService, so perimeter-level like PATCH.
	r.Put(base+"/{id}/roles/{roleId}", handleMemberRole(mod, true))
	r.Delete(base+"/{id}/roles/{roleId}", handleMemberRole(mod, false))
	r.With(requirePerm(permissions.KickMembers)).
		Delete(base+"/{id}/sessions", handleForceLogout(mod))
}

// NewMemberAPI serves the member-list actions on the main /api/v1 surface
// (mounted by api.NewRouter at /api/v1/moderation/members). A reverse proxy in
// front of a server may answer /admin/... with a web page, which broke the
// desktop client's member menu; this surface does not depend on that prefix.
// Authentication is the admin perimeter's (a session or API token whose role
// holds a moderation bit) and authorisation is the same per-action permission
// and rank check, in ModerationService. Unlike /admin it is not subject to
// server.admin_allowed_cidrs: these are routine moderator actions. They accept
// only a session or API token issued by this server, and the permission and
// rank checks, not the network, are what bound them.
func NewMemberAPI(svc *service.Services, hub HubBroadcaster, _ PermissionInvalidator) http.Handler {
	r := chi.NewRouter()
	r.Use(adminAuthMiddleware(svc.Sessions))
	mountMemberActionRoutes(r, "", svc, hub, svc.Moderation)
	return r
}

// mountChannelActionRoutes registers the channel actions the desktop client
// uses: create, edit and delete, all under MANAGE_CHANNELS. They are mounted
// twice, under /admin/api/channels for the panel and under
// /api/v1/moderation/channels (NewChannelAPI) for the client, so both run the
// same handlers and the same permission check. The create route sits at base
// itself, the per-channel routes under base/{id}.
func mountChannelActionRoutes(r chi.Router, base string, channels *service.ChannelService, hub HubBroadcaster) {
	create := base
	if create == "" {
		create = "/"
	}
	r.Group(func(r chi.Router) {
		r.Use(requirePerm(permissions.ManageChannels))
		r.Post(create, handleCreateChannel(channels, hub))
		// Categories. "/categories/order" is registered before
		// "/categories/{id}" so "order" is never read as an id.
		r.Get(base+"/categories", handleListCategories(channels))
		r.Post(base+"/categories", handleCreateCategory(channels, hub))
		r.Put(base+"/categories/order", handleReorderCategories(channels, hub))
		r.Patch(base+"/categories/{id}", handleRenameCategory(channels, hub))
		r.Delete(base+"/categories/{id}", handleDeleteCategory(channels, hub))
		r.Patch(base+"/{id}", handlePatchChannel(channels, hub))
		r.Delete(base+"/{id}", handleDeleteChannel(channels, hub))
		r.Put(base+"/{id}/forum", handlePutForumSettings(channels, hub))
	})
}

// NewChannelAPI serves the channel create, edit and delete actions on the main
// /api/v1 surface (mounted by api.NewRouter at /api/v1/moderation/channels),
// for the same reason as NewMemberAPI: a reverse proxy in front of a server may
// answer /admin/... with a web page. Authentication is the admin perimeter's
// (a session or API token issued by this server) and authorisation is the same
// MANAGE_CHANNELS check. Unlike /admin it is not subject to
// server.admin_allowed_cidrs; the token and the permission bit, not the
// network, bound it, so nobody outside this server's own members can reach it.
func NewChannelAPI(svc *service.Services, hub HubBroadcaster) http.Handler {
	r := chi.NewRouter()
	r.Use(adminAuthMiddleware(svc.Sessions))
	mountChannelActionRoutes(r, "", svc.Channels, hub)
	return r
}

// OwnerOnlyRoute is one (method, pattern) pair ownerOnly registered, relative
// to NewAdminAPI's own router (the same shape doRequest's test helper takes
// paths in — no "/admin/api" prefix).
type OwnerOnlyRoute struct {
	Method  string
	Pattern string
}

// ownerOnlyRegistry records every route ownerOnly registers while one
// NewAdminAPI call builds its router. It belongs to that call's AdminAPI, so
// two APIs built in one process (every test does) each keep their own
// complete list. It is only written during construction, on one goroutine,
// and only read afterwards.
type ownerOnlyRegistry struct {
	routes []OwnerOnlyRoute
}

// ownerOnly is the ONE call site every Owner-gated admin route goes through
// (minting or revoking an API token, taking or restoring a backup, checking
// or applying an update, issuing a recovery credential) — registering h on r
// wrapped in ownerOnlyMiddleware, and recording the (method, pattern) pair so
// a test can walk the exact set NewAdminAPI wires (OwnerOnlyRoutesForTest)
// instead of a second, hand-maintained list beside it that the addition of a
// new owner-only route could leave stale (the previous
// test hard-coded six routes and had already drifted, missing backup delete
// and restore).
func (o *ownerOnlyRegistry) ownerOnly(r chi.Router, method, pattern string, h http.Handler) {
	o.routes = append(o.routes, OwnerOnlyRoute{Method: method, Pattern: pattern})
	r.Method(method, pattern, ownerOnlyMiddleware(h))
}

// backupGate is the single-flight state of POST /backup for one
// NewAdminAPI call. Per API, not a package global, so two APIs built in one
// process (every test does) never share a running backup.
type backupGate struct {
	// running is set while a manual backup is being taken; a second POST
	// /backup while it is set is refused with 409 BACKUP_RUNNING.
	running atomic.Bool
	// hold is a test seam: when set it runs inside the guard, before the
	// backup starts. Only export_test.go assigns it.
	hold atomic.Pointer[func()]
}

// AdminAPI is the built /admin/api router together with what NewAdminAPI
// learned while building it. It embeds the router so it stays a chi.Routes
// when mounted: the gendocs route walk descends into it.
type AdminAPI struct {
	chi.Router
	owner  ownerOnlyRegistry
	gates  gateRegistry
	backup backupGate
}

// ownerOnlyRoutes is a copy of the routes this API registered through
// ownerOnly. Read through OwnerOnlyRoutesForTest; production code never
// reads it.
func (a *AdminAPI) ownerOnlyRoutes() []OwnerOnlyRoute {
	return slices.Clone(a.owner.routes)
}

// mountRetentionRoutes registers message retention under
// MANAGE_SERVER: the policy, its effect preview and the per-channel
// overrides — server management, not moderation.
func mountRetentionRoutes(r chi.Router, retention *service.RetentionService) {
	r.Group(func(r chi.Router) {
		r.Use(requirePerm(permissions.ManageServer))
		r.Get("/retention", handleGetRetention(retention))
		r.Get("/retention/channels", handleGetRetentionChannels(retention))
		r.Get("/retention/preview", handleGetRetentionPreview(retention))
		r.Post("/retention/preview", handlePostRetentionPreview(retention))
		r.Put("/channels/{id}/retention", handlePutChannelRetention(retention))
		r.Delete("/channels/{id}/retention", handleDeleteChannelRetention(retention))
	})
}

// NewAdminAPI has no shutdown hook and is called directly by ~180 tests that
// never capture one, so a parked goroutine here would leak under every
// test's goleak check. time.AfterFunc self-rescheduling avoids that: between
// fires there is no live goroutine, only a runtime timer, so nothing needs
// to stop it.
func startSetupLimiterReap(rl *auth.RateLimiter) {
	var reap func()
	reap = func() {
		rl.Cleanup()
		time.AfterFunc(setupLimiterReapInterval, reap)
	}
	time.AfterFunc(setupLimiterReapInterval, reap)
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
// adminRequiredServices fills in every service this mux dereferences without a
// nil guard, from the handle this package already holds.
//
// The distinction that decides what belongs here: a service the ROUTER
// dereferences must exist, because there is no request-time branch left to
// fail closed in — the handler would simply panic. A service only a HANDLER
// dereferences may be nil, because the handler checks it and answers 500
// "… service unavailable"; those (Moderation, Roles, Channels, Settings) are
// deliberately left alone, and the rows that pin their refusals construct
// exactly that.
//
// Sessions and Setup were the first two: without a SessionService no request
// can be authenticated at all, and without a SetupService the unauthenticated
// first-run routes have nothing to answer with, on a server that by definition
// has nobody able to read its logs yet. Users and Tokens joined them when the
// user and token families moved those routes off the raw handle — before that
// they operated on `database`, which is never nil here, so the fail-closed
// posture the doc comment above claimed had quietly stopped being true for
// /stats, /users and /tokens.
func adminRequiredServices(database *db.DB, svc *service.Services) *service.Services {
	// Copy before filling: the bundle the caller passes is the app-wide one
	// the composition root shares with the rest of the server, and these
	// fallbacks are the admin mux's own. Writing them through the pointer
	// would install admin's wiring into everyone else's view of the bundle.
	filled := service.Services{}
	if svc != nil {
		filled = *svc
	}
	if filled.Sessions == nil {
		filled.Sessions = service.NewSessionService(database)
	}
	if filled.Setup == nil {
		filled.Setup = service.NewSetupService(database, nil)
	}
	if filled.Users == nil {
		filled.Users = service.NewUserService(database)
	}
	if filled.Tokens == nil {
		filled.Tokens = service.NewTokenService(database)
	}
	return &filled
}

// mountCategoryPermRoutes registers the category permission template routes
// and the per-channel re-sync. They are admin API only: the member
// API never mounts them.
func mountCategoryPermRoutes(r chi.Router, channels *service.ChannelService) {
	// Re-sync one channel to its category's template.
	r.Post("/channels/{id}/permissions/sync", handleSyncChannelPermissions(channels))
	// Category permission templates: the same row is written
	// to every synced channel in the category, in one transaction.
	r.Get("/channels/categories/{id}/permissions", handleGetCategoryPermissions(channels))
	r.Put("/channels/categories/{id}/permissions/{roleId}", handlePutCategoryPermission(channels))
	r.Delete("/channels/categories/{id}/permissions/{roleId}", handleDeleteCategoryPermission(channels))
	r.Put("/channels/categories/{id}/user-permissions/{userId}", handlePutCategoryUserPermission(channels))
	r.Delete("/channels/categories/{id}/user-permissions/{userId}", handleDeleteCategoryUserPermission(channels))
}

func NewAdminAPI(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater, logBuf *RingBuffer, allowedOrigins []string, _ PermissionInvalidator, svc *service.Services, opts ...SetupOptions) *AdminAPI {
	r := chi.NewRouter()
	// Fresh per call: the registry belongs to the API this call returns, so
	// no other API shares its list.
	api := &AdminAPI{Router: r}
	gates := &api.gates
	backups := &api.backup

	// The four services this mux routes to, named once. NewAdminAPI used to
	// take them as four positional parameters; each service family that moved an
	// admin handler behind a service added another, and the auth family would
	// have added one more. Taking the bundle the caller already holds keeps
	// that growth out of a 200-call-site signature.
	//
	// A nil service the HANDLERS check stays the fail-closed case they
	// implement (they answer 500 "… service unavailable" rather than writing
	// unchecked) — the tests that pin that behaviour pass exactly that. A nil
	// service the ROUTER dereferences has no such branch left, so
	// adminRequiredServices builds those; see its doc comment.
	svc = adminRequiredServices(database, svc)
	mod, roles, settings, channels := svc.Moderation, svc.Roles, svc.Settings, svc.Channels

	var setupOpts SetupOptions
	if len(opts) > 0 {
		setupOpts = opts[0]
	}
	// Resolved once per API, not held in package globals: two APIs built in
	// one process keep their own backup directory and database path.
	paths := newBackupPaths(setupOpts)
	// Per-router so tests that build hundreds of routers never share restart
	// state; a real restart replaces the process and clears it anyway.
	configPending := new(atomic.Bool)
	bundles := newSupportBundles(service.NewDiagnosticsService(database), version, setupOpts.RunningCfg, logBuf, hub)

	// Setup endpoints — unauthenticated. The gate is the durable
	// settings.setup_completed flag (migration 043), read inside the
	// transaction that creates the first owner; the user count is only a
	// pre-migration backstop, so erasing every account does not reopen setup.
	setupLimiter := auth.NewRateLimiter()
	if setupLimiterHook != nil {
		setupLimiterHook(setupLimiter)
	}
	startSetupLimiterReap(setupLimiter)
	r.Get("/setup/status", handleSetupStatus(svc.Setup, svc.Settings, setupOpts))
	r.Post("/setup", handleSetup(svc.Setup, setupLimiter, allowedOrigins, hub, setupOpts))

	// SSE log stream — auth is via a single-use ticket from POST /logs/ticket.
	// EventSource cannot send Authorization headers, so the client first
	// obtains a short-lived ticket via the authenticated ticket endpoint,
	// then passes it as ?ticket= to the SSE stream.
	if logBuf != nil {
		r.Get("/logs/stream", handleLogStream(database, logBuf))
	}
	// The full-archive download redeemed from a single-use link. Like the log
	// stream it carries no Authorization header: the browser opens it as a
	// plain <a href> so the archive streams to disk rather than being buffered
	// in the page. The link token IS the authorisation — random, Owner-bound,
	// single-use and short-lived (POST /archive/link issues it).
	r.Get("/archive/download", handleArchiveDownload(database, setupOpts, paths))
	// One backup file, redeemed from its own single-use link (POST
	// /backups/{name}/link) on the same terms as the archive's.
	r.Get("/backups/{name}/download", handleBackupDownload(database, paths))

	// All remaining routes require authentication plus at least one
	// moderation-capable bit (permissions.AdminPerimeter). Route groups that
	// map onto a specific bit re-check it with requirePerm; the rest
	// (stats, users list, me) are perimeter-level.
	r.Group(func(r chi.Router) {
		r.Use(adminAuthMiddleware(svc.Sessions))

		// Log stream ticket — issues a single-use, 30s TTL ticket for SSE auth.
		// VIEW_DIAGNOSTICS-gated (ADMINISTRATOR implies it) to match
		// handleLogStream's own re-check: server logs are not scoped to any
		// narrower moderation bit.
		gates.route(r, gateViewDiagnostics, http.MethodPost, "/logs/ticket", handleLogTicket(database))

		// Runtime log level: read the level in force, set a timed
		// debug boost that reverts on its own, or revert it at once.
		// VIEW_DIAGNOSTICS like the log stream it tunes.
		gates.route(r, gateViewDiagnostics, http.MethodGet, "/logs/level", handleGetLogLevel(setupOpts.LogLevel))
		gates.route(r, gateViewDiagnostics, http.MethodPatch, "/logs/level", handleSetLogLevel(database, setupOpts.LogLevel))
		gates.route(r, gateViewDiagnostics, http.MethodDelete, "/logs/level", handleRevertLogLevel(database, setupOpts.LogLevel))

		r.Get("/stats", handleGetStats(svc.Users, hub))
		r.Get("/me", handleGetMe(settings, version))
		gates.route(r, gateViewDiagnostics, http.MethodPost, "/support-bundles/preview", http.HandlerFunc(bundles.preview))
		gates.route(r, gateViewDiagnostics, http.MethodPost, "/support-bundles/download", http.HandlerFunc(bundles.download))
		// Attention panel: server health detail, VIEW_DIAGNOSTICS like
		// the support bundle that carries the same counters.
		gates.route(r, gateViewDiagnostics, http.MethodGet, "/attention", handleGetAttention(svc.Attention))
		mountUserRoutes(r, gates, svc, hub, mod)
		// The approval-mode registration queue: deciding who joins
		// is server management, not moderation of existing members.
		r.With(requirePerm(permissions.ManageServer)).
			Get("/registrations", handleListRegistrations(svc.Users))
		r.With(requirePerm(permissions.ManageServer)).
			Post("/registrations/{id}/approve", handleApproveRegistration(svc.Users))
		r.With(requirePerm(permissions.ManageServer)).
			Post("/registrations/{id}/deny", handleDenyRegistration(svc.Users))
		mountRetentionRoutes(r, svc.Retention)

		mountChannelActionRoutes(r, "/channels", channels, hub)
		r.Group(func(r chi.Router) {
			r.Use(requirePerm(permissions.ManageChannels))
			r.Get("/channels", handleListChannels(channels))
			r.Get("/channels/{id}/permissions", handleGetChannelPermissions(channels))
			r.Put("/channels/{id}/permissions/{roleId}", handlePutChannelPermission(channels))
			r.Delete("/channels/{id}/permissions/{roleId}", handleDeleteChannelPermission(channels))
			// Per-user overrides — the last layer of the resolution order,
			// gated on the same MANAGE_CHANNELS bit as the role layer.
			r.Put("/channels/{id}/user-permissions/{userId}", handlePutChannelUserPermission(channels))
			r.Delete("/channels/{id}/user-permissions/{userId}", handleDeleteChannelUserPermission(channels))
			mountCategoryPermRoutes(r, channels)
			// Explain a member's effective access and preview a
			// proposed override — read-only, same bit as editing overrides.
			r.Get("/channels/{id}/access/explain", handleExplainAccess(channels))
			r.Post("/channels/{id}/access/preview", handlePreviewAccess(channels))
		})

		// Role CRUD. MANAGE_ROLES gates the group; RoleService additionally
		// enforces the hierarchy (manage only roles below your own position,
		// never grant a bit your role lacks) and refuses to delete the Owner
		// or the default role.
		r.Group(func(r chi.Router) {
			r.Use(requirePerm(permissions.ManageRoles))
			r.Get("/roles", handleListRoles(roles))
			r.Post("/roles", handleCreateRole(roles))
			// Registered before /roles/{id} so "reorder" is never parsed as an id.
			r.Patch("/roles/reorder", handleReorderRoles(roles))
			r.Patch("/roles/{id}", handlePatchRole(roles))
			r.Delete("/roles/{id}", handleDeleteRole(roles))
		})

		r.With(requirePerm(permissions.ViewAuditLog)).
			Get("/audit-log", handleGetAuditLog(settings))
		// API tokens — the owner's or a MANAGE_TOKENS holder's, who
		// sees and revokes only their own. Minting a network-reachable,
		// revocation-surviving bearer credential is gated like backups/updates.
		gates.route(r, gateManageTokens, http.MethodGet, "/tokens", handleListAPITokens(svc.Tokens))
		gates.route(r, gateManageTokens, http.MethodPost, "/tokens", handleCreateAPIToken(svc.Tokens))
		gates.route(r, gateManageTokens, http.MethodDelete, "/tokens/{id}", handleRevokeAPIToken(svc.Tokens))
		registerConfigOverrideRoutes(r, gates, database, setupOpts, configPending)
		r.Group(func(r chi.Router) {
			r.Use(requirePerm(permissions.ManageServer))
			r.Get("/settings", handleGetSettings(settings))
			r.Patch("/settings", handlePatchSettings(settings, svc.Retention, hub))
			r.Put("/afk-channel", handlePutAFKChannel(channels, hub))
			r.Get("/config", handleGetConfigFacts(setupOpts.RunningCfg))
		})
		mountBackupRoutes(r, gates, backups, database, setupOpts, paths)
		gates.route(r, gateManageUpdates, http.MethodGet, "/updates", handleCheckUpdate(u))
		gates.route(r, gateManageUpdates, http.MethodPost, "/updates/apply", handleApplyUpdate(database, u, hub, version, setupOpts.Background, setupOpts.Shutdown))
	})

	return api
}

// mountBackupRoutes registers the backup, restore and archive routes. Create
// and link are the owner's or a MANAGE_BACKUPS holder's; list also
// admits a RESTORE_BACKUPS holder, who must pick the backup to restore; delete,
// restore and the full archive are the owner's or a RESTORE_BACKUPS holder's.
// The backup schedule and retention stay Owner-only, as settings
// keys. They share the one backupPaths this API resolved from its
// SetupOptions, so no handler reads a directory from process-wide state.
func mountBackupRoutes(r chi.Router, gates *gateRegistry, backups *backupGate, database *db.DB, setupOpts SetupOptions, paths backupPaths) {
	gates.route(r, gateManageBackups, http.MethodPost, "/backup", handleBackup(database, paths, backups))
	gates.route(r, gateListBackups, http.MethodGet, "/backups", handleListBackups(paths))
	gates.route(r, gateRestoreBackups, http.MethodDelete, "/backups/{name}", handleDeleteBackup(database, paths))
	gates.route(r, gateRestoreBackups, http.MethodPost, "/backups/{name}/restore", handleRestoreBackup(database, paths))
	gates.route(r, gateManageBackups, http.MethodPost, "/backups/{name}/link", handleBackupLink(database, paths))
	gates.route(r, gateRestoreBackups, http.MethodGet, "/archive", handleArchive(database, setupOpts, paths))
	gates.route(r, gateRestoreBackups, http.MethodPost, "/archive/link", handleArchiveLink(database))
}

// registerConfigOverrideRoutes mounts the admin-panel config overrides, the
// owner's or a MANAGE_CONFIG holder's: reading and writing
// config-overrides.json and restarting the process to apply them (or on
// demand). Changing a server-wide setting and restarting is gated like backups
// and updates.
func registerConfigOverrideRoutes(r chi.Router, gates *gateRegistry, database *db.DB, setupOpts SetupOptions, pending *atomic.Bool) {
	gates.route(r, gateManageConfig, http.MethodGet, "/config/settings", handleGetConfigOverrides(setupOpts, pending))
	gates.route(r, gateManageConfig, http.MethodPatch, "/config/settings", handlePatchConfigOverrides(database, setupOpts, pending))
	gates.route(r, gateManageConfig, http.MethodPost, "/restart", handleRestartForConfig(database, setupOpts, pending))
}
