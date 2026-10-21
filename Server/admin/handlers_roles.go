package admin

import (
	"encoding/json"
	"net/http"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── Role Handlers ───────────────────────────────────────────────────────────
//
// The whole group sits behind requirePerm(MANAGE_ROLES); RoleService re-checks
// the bit and owns the hierarchy rules (manage only below your own position,
// never grant a bit you lack, Owner/default undeletable), so these handlers
// stay adapters: decode, call, invalidate, fan out.
//
// Fan-out after a mutation is ONE hub.EnqueueRoleRefresh call (WP 4.4b):
//   - the permission cache is invalidated BEFORE the enqueue, as the
//     channel-override handlers do, so the worker's per-user visibility lookups
//     repopulate from post-change data;
//   - the hub's worker then re-syncs only the users whose role changed with
//     targeted channel_create/channel_delete, a paced member_update and one
//     roles_update, off this goroutine. Nothing after the commit reads
//     r.Context(), so a request deadline or an aborted client cannot cut the
//     fan-out.

// roleRevokeInline is how many moved members a role delete releases directly,
// as the request answers; the worker releases every affected member's held
// topics before sending their sidebar.
const roleRevokeInline = 32

// roleServiceUnavailable writes the fail-closed response used when the server
// was constructed without a RoleService. Refusing beats falling back to an
// unchecked UPDATE, mirroring the nil-ModerationService branches.
func roleServiceUnavailable(w http.ResponseWriter) {
	writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "role service unavailable")
}

// writeRoleErr maps RoleService errors onto admin API responses. Separate from
// writeModerationErr only because NOT_FOUND means "role", not "user".
func writeRoleErr(w http.ResponseWriter, err error) {
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

func handleCreateRole(hub HubBroadcaster, roles *service.RoleService) http.HandlerFunc {
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
		enqueueRoles(hub, ws.RoleRefresh{Roles: true})
		writeJSON(w, http.StatusCreated, role)
	}
}

func handlePatchRole(hub HubBroadcaster, permInvalidator PermissionInvalidator, roles *service.RoleService) http.HandlerFunc {
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

		role, res, err := roles.UpdateRole(r.Context(), actorFromContext(r), id, req.toInput())
		if err != nil {
			writeRoleErr(w, err)
			return
		}

		// Any edit drops the members' cached snapshots, not only a permission
		// change: the cache also holds the role row itself (name, colour,
		// position), which GetRoleForUser serves without a store read. It runs
		// before the member_update broadcast so a client reacting to it reads
		// the new row.
		if affectedOK {
			invalidateUsers(permInvalidator, affected)
		} else if permInvalidator != nil {
			// The member list was unreadable, so per-user eviction cannot
			// be trusted; drop every cached mask instead (what reorder
			// does on every call) rather than leave revoked grants live.
			permInvalidator.InvalidateAll()
		}

		// A rename re-keys every member of the role: clients hold a role name
		// string, not an id, so without a member_update each they lose their
		// role color, member-list group and permission-gated affordances until
		// they reconnect — exactly like a role delete's fallback move already
		// does. RoleUpdateResult reports the rename from the pre-update row the
		// service already read, so this handler re-reads nothing. A permission
		// edit may move READ_MESSAGES in either direction, so every channel's
		// audience for this role is re-derived; when the member list was
		// unreadable every connected user counts as affected.
		fan := ws.RoleRefresh{Roles: true}
		if res.Renamed && affectedOK {
			fan.MemberUpdate = affected
		}
		if res.PermsChanged {
			if affectedOK {
				fan.Visibility = affected
			} else {
				fan.AllConnected = true
			}
		}
		enqueueRoles(hub, fan)
		writeJSON(w, http.StatusOK, role)
	}
}

func handleDeleteRole(hub HubBroadcaster, permInvalidator PermissionInvalidator, roles *service.RoleService) http.HandlerFunc {
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
		_, _, moved, err := roles.DeleteRole(r.Context(), actorFromContext(r), id)
		if err != nil {
			writeRoleErr(w, err)
			return
		}

		// The service already dropped the moved members' cached masks; this
		// covers the handler-side invalidator too (they are the same object in
		// production, distinct in tests).
		invalidateUsers(permInvalidator, moved)
		// Same shape as PATCH /users/{id} role_change: member_update tells
		// every client the user regrouped, and the worker revokes the
		// subscriptions the new role may not read. The name is read at send
		// time, so a later edit of the fallback role is announced as committed.
		if hub != nil {
			// The first members' held channels are released here; the worker
			// releases every affected member's held topics before it sends
			// their sidebar.
			for _, uid := range moved[:min(len(moved), roleRevokeInline)] {
				hub.RevokeUnreadableChannels(uid)
			}
		}
		enqueueRoles(hub, ws.RoleRefresh{Visibility: moved, MemberUpdate: moved, Roles: true})
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
		enqueueRoles(hub, ws.RoleRefresh{Roles: true})
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

// enqueueRoles hands the committed mutation's fan-out to the hub's worker. The
// role list is re-read by the worker rather than patched here, so the broadcast
// always reflects committed state, including any concurrent change, and lists
// go out in commit order.
func enqueueRoles(hub HubBroadcaster, r ws.RoleRefresh) {
	if hub == nil {
		return
	}
	hub.EnqueueRoleRefresh(r)
}
