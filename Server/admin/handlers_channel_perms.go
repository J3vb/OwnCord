package admin

import (
	"net/http"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

//
// Per-role and per-user allow/deny permission overrides on a channel. Denying ReadMessages hides the channel
// from a role entirely ("private channel"); the read side is enforced by ListVisibleChannels, the WS ready
// payload and per-message checks.
//
// Thin adapters over service.ChannelService, which owns the escalation guard (clearing a deny is a grant),
// hierarchy rules, mask clamping, writes, audit rows, cache invalidation and visibility refresh.

// getPermChannel resolves the channel through the one guild-channel policy
// (ChannelService.ResolveGuildChannel): a DM id answers exactly like a missing id, so this surface never
// confirms which ids are private conversations. Returns nil when a response is already written.
func getPermChannel(channels *service.ChannelService, w http.ResponseWriter, r *http.Request) *db.Channel {
	return resolveGuildChannel(channels, w, r)
}

// writeOverrideErr maps override-mutation errors; unlike writeChannelErr it passes the service's NotFound
// text through, since "role not found" and "user not found" differ.
func writeOverrideErr(w http.ResponseWriter, err error) {
	writeSvcErr(w, err, "", "", "channel permission action failed")
}

// channelPermissionsResponse is GET .../permissions. Roles lists EVERY role (zero allow/deny when no
// override); Users lists only members with a per-user override row, since every member is not a sensible list
// and the matrix editor adds one by writing a row.
type channelPermissionsResponse struct {
	ChannelID int64                    `json:"channel_id"`
	Roles     []db.ChannelRoleOverride `json:"roles"`
	Users     []db.ChannelUserOverride `json:"users"`
	// PermissionsSynced: the overrides follow the category's template. Admin-only; not on the websocket payload.
	PermissionsSynced bool `json:"permissions_synced"`
}

func handleGetChannelPermissions(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch := getPermChannel(channels, w, r)
		if ch == nil {
			return
		}
		overrides, userOverrides, err := channels.ChannelPermissions(r.Context(), ch.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to list channel permissions")
			return
		}
		synced, err := channels.ChannelPermissionsSynced(r.Context(), ch.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to list channel permissions")
			return
		}
		writeJSON(w, http.StatusOK, channelPermissionsResponse{
			ChannelID:         ch.ID,
			Roles:             overrides,
			Users:             userOverrides,
			PermissionsSynced: synced,
		})
	}
}

type putChannelPermissionRequest struct {
	Allow int64 `json:"allow"`
	Deny  int64 `json:"deny"`
}

// overrideMutationSetup decodes the preamble shared by every override mutation: resolved channel, the id path
// param and the actor's role. body says whether a JSON body is decoded into req; ok=false means a response
// was written.
func overrideMutationSetup(channels *service.ChannelService, w http.ResponseWriter, r *http.Request, param, invalidMsg string, req *putChannelPermissionRequest) (ch *db.Channel, targetID int64, actorRole *db.Role, ok bool) {
	ch = getPermChannel(channels, w, r)
	if ch == nil {
		return nil, 0, nil, false
	}
	targetID, err := pathInt64(r, param)
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, invalidMsg)
		return nil, 0, nil, false
	}
	if req != nil {
		if !decodeJSON(w, r, req) {
			return nil, 0, nil, false
		}
	}
	actorRole = actorRoleFromContext(r)
	if actorRole == nil {
		writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "not authenticated")
		return nil, 0, nil, false
	}
	return ch, targetID, actorRole, true
}

func handlePutChannelPermission(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req putChannelPermissionRequest
		ch, roleID, actorRole, ok := overrideMutationSetup(channels, w, r, "roleId", "invalid role id", &req)
		if !ok {
			return
		}

		res, err := channels.PutRoleOverride(r.Context(), actorFromContext(r), actorRole, ch, roleID, req.Allow, req.Deny)
		if err != nil {
			writeOverrideErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, db.ChannelRoleOverride{
			RoleID:      res.Role.ID,
			RoleName:    res.Role.Name,
			Position:    res.Role.Position,
			Permissions: res.Role.Permissions,
			Allow:       res.Allow,
			Deny:        res.Deny,
		})
	}
}

func handleDeleteChannelPermission(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, roleID, actorRole, ok := overrideMutationSetup(channels, w, r, "roleId", "invalid role id", nil)
		if !ok {
			return
		}

		_, err := channels.DeleteRoleOverride(r.Context(), actorFromContext(r), actorRole, ch, roleID)
		if err != nil {
			writeOverrideErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

//
// channel_user_overrides is the last resolution layer (base role perms -> role override -> user override), so
// these endpoints can grant one member a channel their role is denied, or take it away, without minting a
// role. The service invalidates only the target user's cached permissions: a per-user override cannot change
// anyone else's verdict.

func handlePutChannelUserPermission(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req putChannelPermissionRequest
		ch, userID, actorRole, ok := overrideMutationSetup(channels, w, r, "userId", "invalid user id", &req)
		if !ok {
			return
		}

		res, err := channels.PutUserOverride(r.Context(), actorFromContext(r), actorRole, ch, userID, req.Allow, req.Deny)
		if err != nil {
			writeOverrideErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, db.ChannelUserOverride{
			UserID:   res.User.ID,
			Username: res.User.Username,
			RoleID:   res.User.RoleID,
			Allow:    res.Allow,
			Deny:     res.Deny,
		})
	}
}

func handleDeleteChannelUserPermission(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, userID, actorRole, ok := overrideMutationSetup(channels, w, r, "userId", "invalid user id", nil)
		if !ok {
			return
		}

		_, err := channels.DeleteUserOverride(r.Context(), actorFromContext(r), actorRole, ch, userID)
		if err != nil {
			writeOverrideErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
