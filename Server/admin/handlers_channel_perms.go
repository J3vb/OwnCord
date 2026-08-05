package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// ─── Channel Permission Override Handlers ────────────────────────────────────
//
// These endpoints manage per-role allow/deny permission overrides on a
// channel (the channel_overrides table). Denying ReadMessages hides the
// channel from a role entirely ("private channel"); the read side is already
// enforced by ListVisibleChannels, the WS ready payload, and the per-message
// permission checks.

// getPermChannel loads the channel for an override request and writes the
// appropriate error response when it is missing or a DM. Returns nil when a
// response has already been written.
func getPermChannel(database *db.DB, w http.ResponseWriter, r *http.Request) *db.Channel {
	id, err := pathInt64(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid channel id")
		return nil
	}
	ch, err := database.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch channel")
		return nil
	}
	if ch == nil {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "channel not found")
		return nil
	}
	if ch.Type == "dm" {
		writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "DM channels do not support permission overrides")
		return nil
	}
	return ch
}

// channelPermissionsResponse is the JSON shape for GET .../permissions.
// Roles lists EVERY role (zero allow/deny when it carries no override), while
// Users lists only the members who actually have a per-user override row —
// every member of a server is not a sensible list to ship, and the matrix
// editor adds a member by writing one.
type channelPermissionsResponse struct {
	ChannelID int64                    `json:"channel_id"`
	Roles     []db.ChannelRoleOverride `json:"roles"`
	Users     []db.ChannelUserOverride `json:"users"`
}

func handleGetChannelPermissions(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch := getPermChannel(database, w, r)
		if ch == nil {
			return
		}
		overrides, err := database.ListChannelRoleOverrides(r.Context(), ch.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list channel permissions")
			return
		}
		userOverrides, err := database.ListChannelUserOverrides(r.Context(), ch.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list channel user permissions")
			return
		}
		writeJSON(w, http.StatusOK, channelPermissionsResponse{
			ChannelID: ch.ID,
			Roles:     overrides,
			Users:     userOverrides,
		})
	}
}

// putChannelPermissionRequest is the JSON body for PUT .../permissions/{roleId}.
type putChannelPermissionRequest struct {
	Allow int64 `json:"allow"`
	Deny  int64 `json:"deny"`
}

// requireGrantableOverride refuses to write a channel override whose allow or
// deny mask contains a bit the actor's own role does not hold. Without this,
// any MANAGE_CHANNELS holder could grant themselves or another user a
// permission (e.g. MANAGE_SERVER) they were never assigned by writing a
// channel-scoped override. ADMINISTRATOR bypasses, mirroring
// service.requireGrantable's escalation rule for role permission masks.
func requireGrantableOverride(actorRole *db.Role, allow, deny int64) error {
	if permissions.HasAdmin(actorRole.Permissions) {
		return nil
	}
	if escalated := (allow | deny) &^ actorRole.Permissions; escalated != 0 {
		return fmt.Errorf("cannot grant a permission your own role lacks (%s)", permissions.Name(escalated&-escalated))
	}
	return nil
}

func handlePutChannelPermission(database *db.DB, hub HubBroadcaster, permInvalidator PermissionInvalidator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch := getPermChannel(database, w, r)
		if ch == nil {
			return
		}
		roleID, err := pathInt64(r, "roleId")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid role id")
			return
		}
		role, err := database.GetRoleByID(r.Context(), roleID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch role")
			return
		}
		if role == nil {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "role not found")
			return
		}

		var req putChannelPermissionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}
		// Drop unknown bits so garbage input cannot persist undefined perms.
		allow := req.Allow & permissions.AllPerms
		deny := req.Deny & permissions.AllPerms

		actorRole := actorRoleFromContext(r)
		if actorRole == nil {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
			return
		}
		// Escalation guard: a MANAGE_CHANNELS holder without ADMINISTRATOR
		// cannot grant bits their own role lacks via a channel override.
		if err := requireGrantableOverride(actorRole, allow, deny); err != nil {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", err.Error())
			return
		}
		// Hierarchy guard: a role override can only target a role strictly
		// below the actor's own position, mirroring service.requireBelowActor.
		if role.Position >= actorRole.Position {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", "cannot manage a role at or above your own rank")
			return
		}

		if err := database.UpsertChannelOverride(r.Context(), ch.ID, roleID, allow, deny); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to save channel permission")
			return
		}

		actor := actorFromContext(r)
		slog.Info("channel permissions updated", "actor_id", actor, "channel_id", ch.ID,
			"role_id", roleID, "allow", allow, "deny", deny)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "channel_perms_update", "channel", ch.ID,
			fmt.Sprintf("set overrides for role %s on #%s (allow=%#x deny=%#x)", role.Name, ch.Name, allow, deny))

		if permInvalidator != nil {
			permInvalidator.InvalidateAll()
		}
		if hub != nil {
			hub.RefreshChannelVisibility(ch)
		}
		writeJSON(w, http.StatusOK, db.ChannelRoleOverride{
			RoleID:      role.ID,
			RoleName:    role.Name,
			Position:    role.Position,
			Permissions: role.Permissions,
			Allow:       allow,
			Deny:        deny,
		})
	}
}

func handleDeleteChannelPermission(database *db.DB, hub HubBroadcaster, permInvalidator PermissionInvalidator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch := getPermChannel(database, w, r)
		if ch == nil {
			return
		}
		roleID, err := pathInt64(r, "roleId")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid role id")
			return
		}
		role, err := database.GetRoleByID(r.Context(), roleID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch role")
			return
		}
		if role == nil {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "role not found")
			return
		}

		actorRole := actorRoleFromContext(r)
		if actorRole == nil {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
			return
		}
		// Hierarchy guard: deleting an override is a permission mutation with the
		// same authority as writing one (removing a deny row restores exactly the
		// access the PUT path refuses to grant), so gate it identically to
		// handlePutChannelPermission.
		if role.Position >= actorRole.Position {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", "cannot manage a role at or above your own rank")
			return
		}

		if err := database.DeleteChannelOverride(r.Context(), ch.ID, roleID); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to delete channel permission")
			return
		}

		actor := actorFromContext(r)
		slog.Info("channel permissions cleared", "actor_id", actor, "channel_id", ch.ID, "role_id", roleID)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "channel_perms_clear", "channel", ch.ID,
			fmt.Sprintf("cleared overrides for role %s on #%s", role.Name, ch.Name))

		if permInvalidator != nil {
			permInvalidator.InvalidateAll()
		}
		if hub != nil {
			hub.RefreshChannelVisibility(ch)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// ─── Per-user overrides ──────────────────────────────────────────────────────
//
// channel_user_overrides is the last layer of the resolution order (base role
// perms -> role override -> user override), so these two endpoints can grant a
// single member access to a channel their role is denied, or take it away
// without minting a role for them.
//
// Unlike the role endpoints they invalidate only the target user's cached
// permissions (InvalidateUser): a per-user override cannot change anyone else's
// verdict, and blowing the whole cache away for one member would cost every
// connected client a repopulate.

// getPermUser resolves the {userId} path parameter for a per-user override
// request, writing the error response itself. Returns nil when a response has
// already been written.
func getPermUser(database *db.DB, w http.ResponseWriter, r *http.Request) *db.User {
	userID, err := pathInt64(r, "userId")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid user id")
		return nil
	}
	user, err := database.GetUserByID(r.Context(), userID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch user")
		return nil
	}
	if user == nil {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "user not found")
		return nil
	}
	return user
}

// requireManageableUser refuses a per-user channel override that targets a
// member whose role sits at or above the actor's own rank, mirroring the
// hierarchy guard the role-layer handler applies (handlePutChannelPermission).
// Without it a MANAGE_CHANNELS holder could deny a higher-ranked member access
// to a channel via the per-user layer, which is last in the resolution order
// and therefore beats that member's role allow. ADMINISTRATOR bypasses. Writes
// the error response and returns false when the action must be refused.
func requireManageableUser(database *db.DB, w http.ResponseWriter, r *http.Request, target *db.User, actorRole *db.Role) bool {
	if permissions.HasAdmin(actorRole.Permissions) {
		return true
	}
	targetRole, err := database.GetRoleByID(r.Context(), target.RoleID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch target role")
		return false
	}
	if targetRole != nil && targetRole.Position >= actorRole.Position {
		writeErr(w, http.StatusForbidden, "FORBIDDEN", "cannot manage a user ranked at or above your own")
		return false
	}
	return true
}

func handlePutChannelUserPermission(database *db.DB, hub HubBroadcaster, permInvalidator PermissionInvalidator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch := getPermChannel(database, w, r)
		if ch == nil {
			return
		}
		user := getPermUser(database, w, r)
		if user == nil {
			return
		}

		var req putChannelPermissionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}
		// Drop unknown bits so garbage input cannot persist undefined perms.
		allow := req.Allow & permissions.AllPerms
		deny := req.Deny & permissions.AllPerms

		actorRole := actorRoleFromContext(r)
		if actorRole == nil {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
			return
		}
		// Escalation guard: a MANAGE_CHANNELS holder without ADMINISTRATOR
		// cannot grant bits their own role lacks via a per-user override.
		if err := requireGrantableOverride(actorRole, allow, deny); err != nil {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", err.Error())
			return
		}
		// Hierarchy guard: cannot override a member ranked at or above you.
		if !requireManageableUser(database, w, r, user, actorRole) {
			return
		}

		if err := database.UpsertChannelUserOverride(r.Context(), ch.ID, user.ID, allow, deny); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to save channel user permission")
			return
		}

		actor := actorFromContext(r)
		slog.Info("channel user permissions updated", "actor_id", actor, "channel_id", ch.ID,
			"user_id", user.ID, "allow", allow, "deny", deny)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "channel_user_perms_update", "channel", ch.ID,
			fmt.Sprintf("set overrides for user %s on #%s (allow=%#x deny=%#x)", user.Username, ch.Name, allow, deny))

		// Invalidate BEFORE the hub call: RefreshChannelVisibility resolves the
		// target's visibility through the same cache (see handlePutChannelPermission).
		if permInvalidator != nil {
			permInvalidator.InvalidateUser(user.ID)
		}
		if hub != nil {
			hub.RefreshChannelVisibility(ch)
		}
		writeJSON(w, http.StatusOK, db.ChannelUserOverride{
			UserID:   user.ID,
			Username: user.Username,
			RoleID:   user.RoleID,
			Allow:    allow,
			Deny:     deny,
		})
	}
}

func handleDeleteChannelUserPermission(database *db.DB, hub HubBroadcaster, permInvalidator PermissionInvalidator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch := getPermChannel(database, w, r)
		if ch == nil {
			return
		}
		user := getPermUser(database, w, r)
		if user == nil {
			return
		}
		actorRole := actorRoleFromContext(r)
		if actorRole == nil {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
			return
		}
		// Hierarchy guard: clearing a higher-ranked member's override is the
		// same authority as writing one, so gate it identically.
		if !requireManageableUser(database, w, r, user, actorRole) {
			return
		}

		if err := database.DeleteChannelUserOverride(r.Context(), ch.ID, user.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to delete channel user permission")
			return
		}

		actor := actorFromContext(r)
		slog.Info("channel user permissions cleared", "actor_id", actor, "channel_id", ch.ID, "user_id", user.ID)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "channel_user_perms_clear", "channel", ch.ID,
			fmt.Sprintf("cleared overrides for user %s on #%s", user.Username, ch.Name))

		if permInvalidator != nil {
			permInvalidator.InvalidateUser(user.ID)
		}
		if hub != nil {
			hub.RefreshChannelVisibility(ch)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
