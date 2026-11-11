package admin

import (
	"errors"
	"net/http"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

//
// The whole group sits behind requirePerm(MANAGE_ROLES); RoleService re-checks the bit and owns the hierarchy
// rules (manage only below your own position, never grant a bit you lack, Owner/default undeletable), so
// handlers stay adapters. Permission-cache invalidation and the live fan-out belong to RoleService, so a
// second caller gets the same effects and nothing after the commit reads r.Context(): a request deadline or
// aborted client cannot cut them.

// roleServiceUnavailable is the fail-closed response when the server was built without a RoleService:
// refusing beats an unchecked UPDATE (as the nil-ModerationService branches).
func roleServiceUnavailable(w http.ResponseWriter) {
	writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "role service unavailable")
}

// writeRoleErr maps RoleService errors; separate from writeModerationErr only because NOT_FOUND means "role",
// not "user".
func writeRoleErr(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrConflict) {
		writeErr(w, http.StatusConflict, httperr.CodeRoleConflict, err.Error())
		return
	}
	writeSvcErr(w, err, "role not found", "", "role action failed")
}

// roleRequest is the body for POST /roles and PATCH /roles/{id}. Fields are pointers so PATCH can tell absent
// from zero: a mask of 0 and an empty color are both legitimate.
type roleRequest struct {
	Name        *string `json:"name"`
	Color       *string `json:"color"`
	Permissions *int64  `json:"permissions"`
	Position    *int    `json:"position"`
	// Hoist and Mentionable: absent leaves them unchanged on PATCH
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

// reorderRolesRequest lists the ids of every role below the caller's rank, highest first.
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
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid role id")
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
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid role id")
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
