package admin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// request runs one request through h with role in the context, the way
// adminAuthMiddleware leaves it; a nil role leaves the context empty.
func gateRequest(h http.Handler, role *db.Role) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	if role != nil {
		req = req.WithContext(context.WithValue(req.Context(), adminRoleKey, role))
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

// TestRouteGate_FailsClosedWithoutARole: a request that reaches a gate with no
// role in its context is unauthenticated, never admitted.
func TestRouteGate_FailsClosedWithoutARole(t *testing.T) {
	reached := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { reached = true })
	for _, g := range []routeGate{gateManageConfig, gateViewDiagnostics} {
		if w := gateRequest(gateMiddleware(g, next), nil); w.Code != http.StatusUnauthorized {
			t.Errorf("gate %s without a role = %d, want 401", g.name, w.Code)
		}
	}
	if reached {
		t.Error("a gate admitted a request with no role")
	}
}

// TestRouteGate_OwnerTierIgnoresAdministrator pins the two tiers at the gate
// itself: an Administrator without the bit is refused by an owner-tier gate and
// admitted by an administrator-tier gate.
func TestRouteGate_OwnerTierIgnoresAdministrator(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	administrator := &db.Role{ID: permissions.AdminRoleID, Position: 80, Permissions: permissions.Administrator}
	for _, g := range []routeGate{gateRestoreBackups, gateManageConfig, gateManageUpdates, gateManageTokens, gateIssueRecovery} {
		if w := gateRequest(gateMiddleware(g, next), administrator); w.Code != http.StatusForbidden {
			t.Errorf("owner-tier gate %s admitted an Administrator without the bit (%d)", g.name, w.Code)
		}
	}
	for _, g := range []routeGate{gateViewDiagnostics, gateEraseAccounts} {
		if w := gateRequest(gateMiddleware(g, next), administrator); w.Code != http.StatusNoContent {
			t.Errorf("administrator-tier gate %s refused an Administrator (%d)", g.name, w.Code)
		}
	}
}

// TestOwnerOnlyRegistry_RecordsAndGates: no production route is owner-only
// since WP 8.4d, so this keeps the registry honest for the next one: it records
// the pair it registers and refuses a role below the owner.
func TestOwnerOnlyRegistry_RecordsAndGates(t *testing.T) {
	var reg ownerOnlyRegistry
	r := chi.NewRouter()
	reg.ownerOnly(r, http.MethodGet, "/x", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	if len(reg.routes) != 1 || reg.routes[0] != (OwnerOnlyRoute{Method: http.MethodGet, Pattern: "/x"}) {
		t.Fatalf("recorded routes = %+v", reg.routes)
	}
	serve := func(role *db.Role) int {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req = req.WithContext(context.WithValue(req.Context(), adminRoleKey, role))
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w.Code
	}
	if got := serve(&db.Role{ID: 9, Position: 50, Permissions: permissions.AllPerms}); got != http.StatusForbidden {
		t.Errorf("below-owner role = %d, want 403", got)
	}
	if got := serve(&db.Role{ID: permissions.OwnerRoleID, Position: permissions.OwnerRolePosition}); got != http.StatusNoContent {
		t.Errorf("owner = %d, want 204", got)
	}
}
