package admin

import (
	"net/http"
	"slices"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// routeGate is one named admin route gate (WP 8.4d): a predicate over the role
// adminAuthMiddleware resolved (the top role's identity with the OR of every
// held role's permissions) and the 403 text a refusal carries. Every gate asks
// a permissions predicate, so no route re-derives the rule.
type routeGate struct {
	// name is the gate's label in the route inventory (GatedRoute.Gate).
	name  string
	allow func(perms, roleID int64, position int) bool
	msg   string
}

// The gates. The owner-tier ones pass the owner or an explicit holder of the
// bit and refuse an Administrator without it; the administrator-tier ones
// (diagnostics, erase) keep passing an Administrator. See
// permissions.OwnerTierBits.
var (
	gateManageBackups = routeGate{
		name:  "manage_backups",
		allow: permissions.CanManageBackups,
		msg:   "owner role or MANAGE_BACKUPS permission required",
	}
	gateListBackups = routeGate{
		name:  "list_backups",
		allow: permissions.CanListBackups,
		msg:   "owner role, MANAGE_BACKUPS or RESTORE_BACKUPS permission required",
	}
	gateRestoreBackups = routeGate{
		name:  "restore_backups",
		allow: permissions.CanRestoreBackups,
		msg:   "owner role or RESTORE_BACKUPS permission required",
	}
	gateManageConfig = routeGate{
		name:  "manage_config",
		allow: permissions.CanManageConfig,
		msg:   "owner role or MANAGE_CONFIG permission required",
	}
	gateManageUpdates = routeGate{
		name:  "manage_updates",
		allow: permissions.CanManageUpdates,
		msg:   "owner role or MANAGE_UPDATES permission required",
	}
	gateManageTokens = routeGate{
		name:  "manage_tokens",
		allow: permissions.CanManageTokens,
		msg:   "owner role or MANAGE_TOKENS permission required",
	}
	gateIssueRecovery = routeGate{
		name:  "issue_recovery",
		allow: permissions.CanIssueRecovery,
		msg:   "owner role or ISSUE_RECOVERY permission required",
	}
	gateViewDiagnostics = routeGate{
		name:  "view_diagnostics",
		allow: func(perms, _ int64, _ int) bool { return permissions.CanViewDiagnostics(perms) },
		msg:   "VIEW_DIAGNOSTICS permission required",
	}
	gateEraseAccounts = routeGate{
		name:  "erase_accounts",
		allow: func(perms, _ int64, _ int) bool { return permissions.CanEraseAccounts(perms) },
		msg:   "ERASE_ACCOUNTS permission required",
	}
)

// GatedRoute is one route registered through gateRegistry.route: the (method,
// pattern) pair relative to NewAdminAPI's own router, and the name of the gate
// it sits behind.
type GatedRoute struct {
	Method  string
	Pattern string
	Gate    string
}

// gateRegistry records every route registered behind a routeGate while one
// NewAdminAPI call builds its router, so a test walks the exact set instead of
// a second hand-kept list the next added route could leave stale. Like
// ownerOnlyRegistry it belongs to that call's AdminAPI and is only written
// during construction.
type gateRegistry struct {
	routes []GatedRoute
}

// route registers h on r behind gate and records the route. It is the ONE call
// site for every owner-or-bit and administrator-or-bit route (WP 8.4d),
// generalising the owner-or-MANAGE_BACKUPS gate of WP 8.4c.
func (g *gateRegistry) route(r chi.Router, gate routeGate, method, pattern string, h http.Handler) {
	g.routes = append(g.routes, GatedRoute{Method: method, Pattern: pattern, Gate: gate.name})
	r.Method(method, pattern, gateMiddleware(gate, h))
}

// gatedRoutes is a copy of the routes this API registered through the gate
// registry. Read through GatedRoutesForTest; production code never reads it.
func (a *AdminAPI) gatedRoutes() []GatedRoute {
	return slices.Clone(a.gates.routes)
}
