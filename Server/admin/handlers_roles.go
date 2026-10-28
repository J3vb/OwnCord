package admin

import (
	"errors"
	"net/http"

	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Role Handlers ───────────────────────────────────────────────────────────
//
// The whole group sits behind requirePerm(MANAGE_ROLES); RoleService re-checks
// the bit and owns the hierarchy rules (manage only below your own position,
// never grant a bit you lack, Owner/default undeletable), so these handlers
// stay adapters: decode, call, respond.
//
// Permission-cache invalidation and the live fan-out (the hub's role refresh
// worker, WP 4.4b) belong to RoleService since WP 5.1a: a second caller of the
// service gets the same effects, and nothing after the commit reads
// r.Context(), so a request deadline or an aborted client cannot cut them.

// roleServiceUnavailable writes the fail-closed response used when the server
// was constructed without a RoleService. Refusing beats falling back to an
// unchecked UPDATE, mirroring the nil-ModerationService branches.
func roleServiceUnavailable(w http.ResponseWriter) {
	writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "role service unavailable")
}

// writeRoleErr maps RoleService errors onto admin API responses. Separate from
// writeModerationErr only because NOT_FOUND means "role", not "user".
func writeRoleErr(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrConflict) {
		writeErr(w, http.StatusConflict, "ROLE_CONFLICT", err.Error())
		return
	}
	writeSvcErr(w, err, "role not found", "", "role action failed")
}

// roleRequest is the JSON body for POST /roles and PATCH /roles/{id}. Every
// field is a pointer so PATCH can tell "absent" from "set to zero" — a mask of
// 0 (a role that may do nothing) and an empty color are both legitimate values.
type roleRequest struct {
	Name        *string `json:"name"`
	Color       *string `json:"color"`
	Permissions *int64  `json:"permissions"`
	Position    *int    `json:"position"`
	// Hoist and Mentionable (WP 6.3c): absent leaves them unchanged on PATCH
	// and false on POST.
	Hoist       *bool `json:"hoist"`
	Mentionable *bool `json:"mentionable"`
	// ExpectedPermissions (PATCH only) is the mask the editor loaded; a
	// stored mask that differs answers 409 ROLE_CONFLICT. Absent skips it.
	ExpectedPermissions *int64 `json:"expected_permissions"`
}

func (r roleRequest) toInput() service.RoleInput {
	return service.RoleInput{
		Name:        r.Name,
		Color:       r.Color,
		Permissions: r.Permissions,
		Position:    r.Position,
		Hoist:       r.Hoist,
		Mentionable: r.Mentionable,

		ExpectedPermissions: r.ExpectedPermissions,
	}
}

// reorderRolesRequest is the JSON body for PATCH /roles/reorder: the ids of
// every role below the caller's own rank, highest first.
type reorderRolesRequest struct {
	RoleIDs []int64 `json:"role_ids"`
}

func handleListRoles(roles *service.RoleService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if roles == nil {
			roleServiceUnavailable(w)
			return
		}
		list, err := roles.ListRoles(r.Context(), actorFromContext(r))
		if err != nil {
			writeRoleErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func handleCreateRole(roles *service.RoleService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if roles == nil {
			roleServiceUnavailable(w)
			return
		}
		var req roleRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		role, err := roles.CreateRole(r.Context(), actorFromContext(r), req.toInput())
		if err != nil {
			writeRoleErr(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, role)
	}
}

func handlePatchRole(roles *service.RoleService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if roles == nil {
			roleServiceUnavailable(w)
			return
		}
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid role id")
			return
		}
		var req roleRequest
		if !decodeJSON(w, r, &req) {
			return
		}

		role, _, err := roles.UpdateRole(r.Context(), actorFromContext(r), id, req.toInput())
		if err != nil {
			writeRoleErr(w, err)
			return
		}

		writeJSON(w, http.StatusOK, role)
	}
}

func handleDeleteRole(roles *service.RoleService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if roles == nil {
			roleServiceUnavailable(w)
			return
		}
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid role id")
			return
		}
		_, _, _, err = roles.DeleteRole(r.Context(), actorFromContext(r), id)
		if err != nil {
			writeRoleErr(w, err)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func handleReorderRoles(roles *service.RoleService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if roles == nil {
			roleServiceUnavailable(w)
			return
		}
		var req reorderRolesRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		updated, err := roles.ReorderRoles(r.Context(), actorFromContext(r), req.RoleIDs)
		if err != nil {
			writeRoleErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, updated)
	}
}
