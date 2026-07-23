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
type channelPermissionsResponse struct {
	ChannelID int64                    `json:"channel_id"`
	Roles     []db.ChannelRoleOverride `json:"roles"`
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
		writeJSON(w, http.StatusOK, channelPermissionsResponse{ChannelID: ch.ID, Roles: overrides})
	}
}

// putChannelPermissionRequest is the JSON body for PUT .../permissions/{roleId}.
type putChannelPermissionRequest struct {
	Allow int64 `json:"allow"`
	Deny  int64 `json:"deny"`
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

		if err := database.DeleteChannelOverride(r.Context(), ch.ID, roleID); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to delete channel permission")
			return
		}

		actor := actorFromContext(r)
		slog.Info("channel permissions cleared", "actor_id", actor, "channel_id", ch.ID, "role_id", roleID)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "channel_perms_clear", "channel", ch.ID,
			fmt.Sprintf("cleared overrides for role %d on #%s", roleID, ch.Name))

		if permInvalidator != nil {
			permInvalidator.InvalidateAll()
		}
		if hub != nil {
			hub.RefreshChannelVisibility(ch)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
