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

// setupLimiterReapInterval is how often the setup endpoint's rate limiter reaps stale window entries.
const setupLimiterReapInterval = 5 * time.Minute

// setupLimiterHook receives the limiter NewAdminAPI creates for /setup. Test-only seam: NewAdminAPI
// returns only an http.Handler.
var setupLimiterHook func(*auth.RateLimiter)

// mountUserRoutes registers the member-management routes. Ban/unban and role change are authorized in
// ModerationService, so PATCH stays perimeter-level: a moderator with only BAN_MEMBERS must reach it.
// Force-logout is KICK_MEMBERS; erasure is ERASE_ACCOUNTS or ADMINISTRATOR; recovery credentials are the
// owner's or an ISSUE_RECOVERY holder's. Rank is re-checked in the service.
func mountUserRoutes(r chi.Router, gates *gateRegistry, svc *service.Services, hub HubBroadcaster, mod *service.ModerationService) {
	mountMemberActionRoutes(r, "/users", svc, hub, mod)
	gates.route(r, gateEraseAccounts, http.MethodDelete, "/users/{id}", handleDeleteUser(mod, hub))
	gates.route(r, gateIssueRecovery, http.MethodPost, "/users/{id}/recovery-credential", handleIssueRecoveryCredential(svc.Auth))
}

// mountMemberActionRoutes registers the member-list actions, mounted under both /admin/api/users and
// /api/v1/moderation/members (NewMemberAPI) so both run the same handlers and rank checks.
func mountMemberActionRoutes(r chi.Router, base string, svc *service.Services, hub HubBroadcaster, mod *service.ModerationService) {
	list := base
	if list == "" {
		list = "/"
	}
	r.Get(list, handleListUsers(svc.Users))
	r.Patch(base+"/{id}", handlePatchUser(svc.Users, hub, mod))
	r.Put(base+"/{id}/roles/{roleId}", handleMemberRole(mod, true))
	r.Delete(base+"/{id}/roles/{roleId}", handleMemberRole(mod, false))
	r.With(requirePerm(permissions.KickMembers)).
		Delete(base+"/{id}/sessions", handleForceLogout(mod))
}

// NewMemberAPI serves the member-list actions on /api/v1/moderation/members: a reverse proxy may answer
// /admin/... with a web page, which broke the desktop client's member menu. Authentication is the admin
// perimeter's; authorisation is the per-action permission and rank check in ModerationService. Unlike /admin
// it is not subject to server.admin_allowed_cidrs: the session/token, permission and rank checks bound it.
func NewMemberAPI(svc *service.Services, hub HubBroadcaster, _ PermissionInvalidator) http.Handler {
	r := chi.NewRouter()
	r.Use(adminAuthMiddleware(svc.Sessions))
	mountMemberActionRoutes(r, "", svc, hub, svc.Moderation)
	return r
}

// mountChannelActionRoutes registers channel create, edit and delete (MANAGE_CHANNELS), mounted under both
// /admin/api/channels and /api/v1/moderation/channels (NewChannelAPI) so both run the same handlers.
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

// NewChannelAPI serves channel create, edit and delete on /api/v1/moderation/channels, for the same reason
// as NewMemberAPI. Authentication is the admin perimeter's and authorisation is the MANAGE_CHANNELS check;
// unlike /admin it is not subject to server.admin_allowed_cidrs.
func NewChannelAPI(svc *service.Services, hub HubBroadcaster) http.Handler {
	r := chi.NewRouter()
	r.Use(adminAuthMiddleware(svc.Sessions))
	mountChannelActionRoutes(r, "", svc.Channels, hub)
	return r
}

// OwnerOnlyRoute is one (method, pattern) pair ownerOnly registered, relative to NewAdminAPI's router.
type OwnerOnlyRoute struct {
	Method  string
	Pattern string
}

// ownerOnlyRegistry records every route ownerOnly registers during one NewAdminAPI call; per API so tests
// building many APIs each keep their own list.
type ownerOnlyRegistry struct {
	routes []OwnerOnlyRoute
}

// ownerOnly is the one call site every Owner-gated admin route goes through. It records the (method, pattern)
// pair so a test can walk the exact set (OwnerOnlyRoutesForTest) instead of a hand-kept list.
func (o *ownerOnlyRegistry) ownerOnly(r chi.Router, method, pattern string, h http.Handler) {
	o.routes = append(o.routes, OwnerOnlyRoute{Method: method, Pattern: pattern})
	r.Method(method, pattern, ownerOnlyMiddleware(h))
}

// backupGate is the single-flight state of POST /backup, per API rather than a package global.
type backupGate struct {
	// running is set during a manual backup; a second POST /backup is refused with 409 BACKUP_RUNNING.
	running atomic.Bool
	// hold is a test seam run inside the guard, before the backup or restore starts.
	hold atomic.Pointer[func()]
}

// AdminAPI is the built /admin/api router plus what NewAdminAPI learned; it embeds the router so the gendocs
// route walk descends into it.
type AdminAPI struct {
	chi.Router
	owner  ownerOnlyRegistry
	gates  gateRegistry
	backup backupGate
}

// ownerOnlyRoutes copies the routes registered through ownerOnly; production code never reads it.
func (a *AdminAPI) ownerOnlyRoutes() []OwnerOnlyRoute {
	return slices.Clone(a.owner.routes)
}

// mountRetentionRoutes registers message retention under MANAGE_SERVER: server management, not moderation.
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

// startSetupLimiterReap keeps rl's window map bounded: Allow prunes a key only on a repeat call from it. The
// app reaps the main limiter on its own context, but NewAdminAPI has no shutdown hook, so a parked goroutine
// would leak under goleak; a self-rescheduling time.AfterFunc leaves only a runtime timer.
func startSetupLimiterReap(rl *auth.RateLimiter) {
	var reap func()
	reap = func() {
		rl.Cleanup()
		time.AfterFunc(setupLimiterReapInterval, reap)
	}
	time.AfterFunc(setupLimiterReapInterval, reap)
}

// adminRequiredServices fills in every service this mux dereferences without a nil guard. The router has no
// request-time branch to fail closed, so a nil one would panic; a service only a handler dereferences may
// stay nil because the handler answers 500 "... service unavailable".
func adminRequiredServices(database *db.DB, svc *service.Services) *service.Services {
	// Copy before filling: the bundle is shared app-wide, and writing through the pointer would leak admin's
	// wiring into it.
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

// mountCategoryPermRoutes registers the category permission template routes and the per-channel re-sync.
// Admin API only: the member API never mounts them.
func mountCategoryPermRoutes(r chi.Router, channels *service.ChannelService) {
	r.Post("/channels/{id}/permissions/sync", handleSyncChannelPermissions(channels))
	// Templates: the same row is written to every synced channel in the category, in one transaction.
	r.Get("/channels/categories/{id}/permissions", handleGetCategoryPermissions(channels))
	r.Put("/channels/categories/{id}/permissions/{roleId}", handlePutCategoryPermission(channels))
	r.Delete("/channels/categories/{id}/permissions/{roleId}", handleDeleteCategoryPermission(channels))
	r.Put("/channels/categories/{id}/user-permissions/{userId}", handlePutCategoryUserPermission(channels))
	r.Delete("/channels/categories/{id}/user-permissions/{userId}", handleDeleteCategoryUserPermission(channels))
}

// NewAdminAPI returns a chi router with all /admin/api/* routes. All but the unauthenticated setup endpoints
// sit behind adminAuthMiddleware (any role holding an AdminPerimeter bit); groups then require the specific
// bit (requirePerm) or the Owner role (ownerOnlyMiddleware).
// The optional SetupOptions enables the setup wizard's config.yaml write-back and restart.
func NewAdminAPI(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater, logBuf *RingBuffer, allowedOrigins []string, _ PermissionInvalidator, svc *service.Services, opts ...SetupOptions) *AdminAPI {
	r := chi.NewRouter()
	api := &AdminAPI{Router: r}
	gates := &api.gates
	backups := &api.backup

	// A nil service the HANDLERS check stays fail-closed (500 "... service unavailable"); the ROUTER has no such
	// branch, so adminRequiredServices builds those.
	svc = adminRequiredServices(database, svc)
	mod, roles, settings, channels := svc.Moderation, svc.Roles, svc.Settings, svc.Channels

	var setupOpts SetupOptions
	if len(opts) > 0 {
		setupOpts = opts[0]
	}
	// Resolved per API so two APIs in one process keep their own backup directory and database path.
	paths := newBackupPaths(setupOpts)
	// Per-router so tests never share restart state.
	configPending := new(atomic.Bool)
	diagnostics := service.NewDiagnosticsService(database)
	bundles := newSupportBundles(diagnostics, version, setupOpts.RunningCfg, logBuf, hub)

	// Setup endpoints are unauthenticated. The gate is the durable settings.setup_completed flag, read in the
	// transaction that creates the first owner; the user count is only a pre-migration backstop, so erasing
	// every account does not reopen setup.
	setupLimiter := auth.NewRateLimiter()
	if setupLimiterHook != nil {
		setupLimiterHook(setupLimiter)
	}
	startSetupLimiterReap(setupLimiter)
	r.Get("/setup/status", handleSetupStatus(svc.Setup, svc.Settings, setupOpts))
	r.Post("/setup", handleSetup(svc.Setup, setupLimiter, allowedOrigins, hub, setupOpts))

	// SSE log stream: EventSource cannot send Authorization headers, so auth is a single-use ticket from
	// POST /logs/ticket, passed as ?ticket=.
	if logBuf != nil {
		r.Get("/logs/stream", handleLogStream(database, logBuf))
	}
	// Archive download from a single-use link: opened as a plain <a href> so it streams to disk, hence no
	// Authorization header. The link token IS the authorisation: random, Owner-bound, single-use, short-lived.
	r.Get("/archive/download", handleArchiveDownload(database, setupOpts, paths))
	// One backup file, redeemed from its own single-use link on the same terms.
	r.Get("/backups/{name}/download", handleBackupDownload(database, paths))

	// All remaining routes need authentication plus an AdminPerimeter bit; groups re-check the specific bit with
	// requirePerm, the rest (stats, users list, me) are perimeter-level.
	r.Group(func(r chi.Router) {
		r.Use(adminAuthMiddleware(svc.Sessions))

		// Log stream ticket: single-use, 30s TTL, VIEW_DIAGNOSTICS-gated to match handleLogStream's own re-check.
		gates.route(r, gateViewDiagnostics, http.MethodPost, "/logs/ticket", handleLogTicket(database))

		// Runtime log level: read, timed debug boost, or revert. VIEW_DIAGNOSTICS like the log stream it tunes.
		gates.route(r, gateViewDiagnostics, http.MethodGet, "/logs/level", handleGetLogLevel(setupOpts.LogLevel))
		gates.route(r, gateViewDiagnostics, http.MethodPatch, "/logs/level", handleSetLogLevel(database, setupOpts.LogLevel))
		gates.route(r, gateViewDiagnostics, http.MethodDelete, "/logs/level", handleRevertLogLevel(database, setupOpts.LogLevel))
		gates.route(r, gateViewDiagnostics, http.MethodGet, "/logs/history", handleLogHistory(setupOpts.LogHistoryDir))

		r.Get("/stats", handleGetStats(svc.Users, hub))
		r.Get("/me", handleGetMe(settings, version))
		gates.route(r, gateViewDiagnostics, http.MethodPost, "/support-bundles/preview", http.HandlerFunc(bundles.preview))
		gates.route(r, gateViewDiagnostics, http.MethodPost, "/support-bundles/download", http.HandlerFunc(bundles.download))
		// Attention panel health detail: VIEW_DIAGNOSTICS like the support bundle that carries the same counters.
		gates.route(r, gateViewDiagnostics, http.MethodGet, "/attention", handleGetAttention(svc.Attention))
		mountSystemRoutes(r, gates, setupOpts.System, hub, svc.Attention, diagnostics, version)
		mountUserRoutes(r, gates, svc, hub, mod)
		// Registration queue: deciding who joins is server management, not moderation.
		r.With(requirePerm(permissions.ManageServer)).
			Get("/registrations", handleListRegistrations(svc.Users))
		r.With(requirePerm(permissions.ManageServer)).
			Post("/registrations/{id}/approve", handleApproveRegistration(svc.Users))
		r.With(requirePerm(permissions.ManageServer)).
			Post("/registrations/{id}/deny", handleDenyRegistration(svc.Users))
		mountRetentionRoutes(r, svc.Retention)
		mountStorageRoutes(r, newStorageAPI(svc, hub, setupOpts, paths))

		mountChannelActionRoutes(r, "/channels", channels, hub)
		mountDiscordImportRoutes(r, newDiscordImportAPI(svc.Retention, setupOpts))
		r.Group(func(r chi.Router) {
			r.Use(requirePerm(permissions.ManageChannels))
			r.Get("/channels", handleListChannels(channels))
			r.Get("/channels/{id}/permissions", handleGetChannelPermissions(channels))
			r.Put("/channels/{id}/permissions/{roleId}", handlePutChannelPermission(channels))
			r.Delete("/channels/{id}/permissions/{roleId}", handleDeleteChannelPermission(channels))
			// Per-user overrides: the last resolution layer, gated on the same MANAGE_CHANNELS bit as the role layer.
			r.Put("/channels/{id}/user-permissions/{userId}", handlePutChannelUserPermission(channels))
			r.Delete("/channels/{id}/user-permissions/{userId}", handleDeleteChannelUserPermission(channels))
			mountCategoryPermRoutes(r, channels)
			r.Get("/channels/{id}/access/explain", handleExplainAccess(channels))
			r.Post("/channels/{id}/access/preview", handlePreviewAccess(channels))
		})

		// Role CRUD under MANAGE_ROLES; RoleService enforces the hierarchy and refuses to delete the Owner or
		// default role.
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
		// API tokens: the owner's or a MANAGE_TOKENS holder's, who sees only their own. Minting a
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
		mountBackupRoutes(r, gates, backups, database, svc.Attention, setupOpts, paths)
		gates.route(r, gateManageUpdates, http.MethodGet, "/updates", handleCheckUpdate(u))
		gates.route(r, gateManageUpdates, http.MethodPost, "/updates/apply", handleApplyUpdate(database, u, hub, version, setupOpts.Background, setupOpts.Shutdown))
	})

	return api
}

// mountDiscordImportRoutes registers the Discord import routes behind MANAGE_CHANNELS (import creates a
// channel). "/latest" and "/upload" register before "{id}" so neither is read as an id.
func mountDiscordImportRoutes(r chi.Router, imp *discordImportAPI) {
	r.Group(func(r chi.Router) {
		r.Use(requirePerm(permissions.ManageChannels))
		r.Get("/discord-imports/latest", imp.handleLatest)
		r.Post("/discord-imports/upload", imp.handleUpload)
		r.Get("/discord-imports/{id}", imp.handleStatus)
		r.Post("/discord-imports/{id}/cancel", imp.handleCancel)
	})
}

// mountBackupRoutes registers backup, restore and archive routes. Create and link: owner or MANAGE_BACKUPS;
// list also admits RESTORE_BACKUPS (who must pick the backup); delete, restore and archive: owner or
// RESTORE_BACKUPS. Schedule and retention stay Owner-only. All share the one backupPaths from SetupOptions.
func mountBackupRoutes(r chi.Router, gates *gateRegistry, backups *backupGate, database *db.DB, attention *service.AttentionService, setupOpts SetupOptions, paths backupPaths) {
	gates.route(r, gateManageBackups, http.MethodPost, "/backup", handleBackup(database, paths, backups, attention))
	gates.route(r, gateListBackups, http.MethodGet, "/backups", handleListBackups(paths))
	gates.route(r, gateRestoreBackups, http.MethodDelete, "/backups/{name}", handleDeleteBackup(database, paths))
	gates.route(r, gateRestoreBackups, http.MethodPost, "/backups/{name}/restore", handleRestoreBackup(database, paths, backups))
	gates.route(r, gateManageBackups, http.MethodPost, "/backups/{name}/link", handleBackupLink(database, paths))
	gates.route(r, gateRestoreBackups, http.MethodGet, "/archive", handleArchive(database, setupOpts, paths))
	gates.route(r, gateRestoreBackups, http.MethodPost, "/archive/link", handleArchiveLink(database))
}

// registerConfigOverrideRoutes mounts config-overrides.json read/write and restart: changing a server-wide
// setting and restarting is gated like backups and updates (owner or MANAGE_CONFIG).
func registerConfigOverrideRoutes(r chi.Router, gates *gateRegistry, database *db.DB, setupOpts SetupOptions, pending *atomic.Bool) {
	gates.route(r, gateManageConfig, http.MethodGet, "/config/settings", handleGetConfigOverrides(setupOpts, pending))
	gates.route(r, gateManageConfig, http.MethodPatch, "/config/settings", handlePatchConfigOverrides(database, setupOpts, pending))
	gates.route(r, gateManageConfig, http.MethodPost, "/restart", handleRestartForConfig(database, setupOpts, pending))
}
