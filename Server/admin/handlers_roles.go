package admin

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
)

// ─── Role Handlers ───────────────────────────────────────────────────────────
//
// The whole group sits behind requirePerm(MANAGE_ROLES); RoleService re-checks
// the bit and owns the hierarchy rules (manage only below your own position,
// never grant a bit you lack, Owner/default undeletable), so these handlers
// stay adapters: decode, call, invalidate, fan out.
//
// Fan-out after a mutation follows the two existing patterns exactly:
//   - the permission cache is invalidated BEFORE the hub calls, as the
//     channel-override handlers do, so the hub's per-client visibility lookups
//     repopulate from post-change data;
//   - visibility is re-synced with targeted channel_create/channel_delete
//     (RefreshChannelVisibility), not a reconnect — a role's mask is the base
//     for every channel, so the refresh covers all of them.

// roleServiceUnavailable writes the fail-closed response used when the server
// was constructed without a RoleService. Refusing beats falling back to an
// unchecked UPDATE, mirroring the nil-ModerationService branches.
func roleServiceUnavailable(w http.ResponseWriter) {
	writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "role service unavailable")
}

// writeRoleErr maps RoleService errors onto admin API responses. Separate from
// writeModerationErr only because NOT_FOUND means "role", not "user".
func writeRoleErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrForbidden):
		writeErr(w, http.StatusForbidden, "FORBIDDEN", err.Error())
	case errors.Is(err, service.ErrNotFound):
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "role not found")
	case errors.Is(err, service.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "role action failed")
	}
}

// roleRequest is the JSON body for POST /roles and PATCH /roles/{id}. Every
// field is a pointer so PATCH can tell "absent" from "set to zero" — a mask of
// 0 (a role that may do nothing) and an empty color are both legitimate values.
type roleRequest struct {
	Name        *string `json:"name"`
	Color       *string `json:"color"`
	Permissions *int64  `json:"permissions"`
	Position    *int    `json:"position"`
}

func (r roleRequest) toInput() service.RoleInput {
	return service.RoleInput{
		Name:        r.Name,
		Color:       r.Color,
		Permissions: r.Permissions,
		Position:    r.Position,
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

func handleCreateRole(database *db.DB, hub HubBroadcaster, roles *service.RoleService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if roles == nil {
			roleServiceUnavailable(w)
			return
		}
		var req roleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}
		role, err := roles.CreateRole(r.Context(), actorFromContext(r), req.toInput())
		if err != nil {
			writeRoleErr(w, err)
			return
		}
		// A brand-new role has no members, so nothing's cached mask changed and
		// no channel changed visibility — only the role list itself moved.
		broadcastRoles(r, database, hub)
		writeJSON(w, http.StatusCreated, role)
	}
}

func handlePatchRole(database *db.DB, hub HubBroadcaster, permInvalidator PermissionInvalidator, roles *service.RoleService) http.HandlerFunc {
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
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		// Members are read before the update: after it they are the same set,
		// but reading first keeps the invalidation correct even if a concurrent
		// role assignment lands in between (the extra id is a wasted eviction,
		// a missing one is a stale grant).
		affected, affectedOK := roles.AffectedUserIDs(r.Context(), id)

		role, permsChanged, err := roles.UpdateRole(r.Context(), actorFromContext(r), id, req.toInput())
		if err != nil {
			writeRoleErr(w, err)
			return
		}

		if permsChanged {
			if affectedOK {
				invalidateUsers(permInvalidator, affected)
			} else if permInvalidator != nil {
				// The member list was unreadable, so per-user eviction cannot
				// be trusted; drop every cached mask instead (what reorder
				// does on every call) rather than leave revoked grants live.
				permInvalidator.InvalidateAll()
			}
			// READ_MESSAGES may have moved in either direction, so every
			// channel's audience for this role has to be re-derived.
			if hub != nil {
				hub.RefreshAllChannelVisibility()
			}
		}
		broadcastRoles(r, database, hub)
		writeJSON(w, http.StatusOK, role)
	}
}

func handleDeleteRole(database *db.DB, hub HubBroadcaster, permInvalidator PermissionInvalidator, roles *service.RoleService) http.HandlerFunc {
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
		_, fallback, moved, err := roles.DeleteRole(r.Context(), actorFromContext(r), id)
		if err != nil {
			writeRoleErr(w, err)
			return
		}

		// The service already dropped the moved members' cached masks; this
		// covers the handler-side invalidator too (they are the same object in
		// production, distinct in tests).
		invalidateUsers(permInvalidator, moved)
		if hub != nil {
			// Same shape as PATCH /users/{id} role_change: member_update tells
			// every client the user regrouped, and revokes the subscriptions
			// the new role may not read.
			for _, uid := range moved {
				hub.BroadcastMemberUpdate(uid, fallback.Name)
			}
			hub.RefreshAllChannelVisibility()
		}
		broadcastRoles(r, database, hub)
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleReorderRoles(hub HubBroadcaster, permInvalidator PermissionInvalidator, roles *service.RoleService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if roles == nil {
			roleServiceUnavailable(w)
			return
		}
		var req reorderRolesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}
		updated, err := roles.ReorderRoles(r.Context(), actorFromContext(r), req.RoleIDs)
		if err != nil {
			writeRoleErr(w, err)
			return
		}
		// Positions carry no permission bits, so no channel changes visibility;
		// but a cached role snapshot holds the old position, which the
		// hierarchy checks read.
		if permInvalidator != nil {
			permInvalidator.InvalidateAll()
		}
		if hub != nil {
			hub.BroadcastRolesUpdate(updated)
		}
		writeJSON(w, http.StatusOK, updated)
	}
}

// invalidateUsers drops the cached permissions of the given users, if an
// invalidator is wired.
func invalidateUsers(permInvalidator PermissionInvalidator, userIDs []int64) {
	if permInvalidator == nil {
		return
	}
	for _, uid := range userIDs {
		permInvalidator.InvalidateUser(uid)
	}
}

// broadcastRoles re-reads the role list and pushes it to every client. Re-read
// rather than patched locally so the broadcast always reflects committed state,
// including any concurrent change.
func broadcastRoles(r *http.Request, database *db.DB, hub HubBroadcaster) {
	if hub == nil || database == nil {
		return
	}
	list, err := database.ListRoles(r.Context())
	if err != nil {
		// The mutation already committed; clients converge on their next
		// reconnect rather than seeing a failed request.
		slog.Warn("admin: roles_update broadcast skipped, role list unreadable", "err", err)
		return
	}
	hub.BroadcastRolesUpdate(list)
}
