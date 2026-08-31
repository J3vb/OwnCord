package admin

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Channel Permission Override Handlers ────────────────────────────────────
//
// These endpoints manage per-role and per-user allow/deny permission
// overrides on a channel. Denying ReadMessages hides the channel from a role
// entirely ("private channel"); the read side is already enforced by
// ListVisibleChannels, the WS ready payload, and the per-message permission
// checks.
//
// Thin adapters over service.ChannelService (B3-8 channel family, part 2):
// the escalation guard (clearing a deny is a grant), the hierarchy rules,
// mask clamping, the writes and their audit rows all live in the service.
// The handlers decode, delegate, invalidate cached permissions from the
// result, and fan the visibility refresh out to the hub.

// getPermChannel resolves the channel for an override request through the
// one S-04 policy (service.ChannelService.ResolveGuildChannel): a DM id
// answers exactly like a missing id, so this surface no longer confirms
// which ids are private conversations (A-2026-08-02). Returns nil when a
// response has already been written.
func getPermChannel(channels *service.ChannelService, w http.ResponseWriter, r *http.Request) *db.Channel {
	return resolveGuildChannel(channels, w, r)
}

// writeOverrideErr maps override-mutation errors onto admin API responses.
// Unlike writeChannelErr it passes the service's NotFound text through —
// the override paths distinguish "role not found" from "user not found".
func writeOverrideErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrForbidden):
		writeErr(w, http.StatusForbidden, "FORBIDDEN", err.Error())
	case errors.Is(err, service.ErrNotFound):
		writeErr(w, http.StatusNotFound, "NOT_FOUND", err.Error())
	case errors.Is(err, service.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "channel permission action failed")
	}
}

// applyOverrideResult runs the post-mutation fan-out: cached-permission
// invalidation narrowed to who the mutation can affect (with the full-flush
// fail-safe — a missed eviction is a stale grant), BEFORE the hub call,
// because RefreshChannelVisibility resolves visibility through the same
// cache.
func applyOverrideResult(res service.OverrideResult, ch *db.Channel, hub HubBroadcaster, permInvalidator PermissionInvalidator) {
	if permInvalidator != nil {
		if res.AffectedAll {
			permInvalidator.InvalidateAll()
		} else {
			invalidateUsers(permInvalidator, res.AffectedUsers)
		}
	}
	if hub != nil {
		hub.RefreshChannelVisibility(ch)
	}
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

func handleGetChannelPermissions(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch := getPermChannel(channels, w, r)
		if ch == nil {
			return
		}
		overrides, userOverrides, err := channels.ChannelPermissions(r.Context(), ch.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list channel permissions")
			return
		}
		writeJSON(w, http.StatusOK, channelPermissionsResponse{
			ChannelID: ch.ID,
			Roles:     overrides,
			Users:     userOverrides,
		})
	}
}

// putChannelPermissionRequest is the JSON body for PUT .../permissions/{roleId}
// and .../user-permissions/{userId}.
type putChannelPermissionRequest struct {
	Allow int64 `json:"allow"`
	Deny  int64 `json:"deny"`
}

// overrideMutationSetup decodes the shared preamble of every override
// mutation: the resolved channel, the {id path param}, and the
// authenticated actor's role. body reports whether a JSON body must be
// decoded into req. Returns ok=false when a response has been written.
func overrideMutationSetup(channels *service.ChannelService, w http.ResponseWriter, r *http.Request, param, invalidMsg string, req *putChannelPermissionRequest) (ch *db.Channel, targetID int64, actorRole *db.Role, ok bool) {
	ch = getPermChannel(channels, w, r)
	if ch == nil {
		return nil, 0, nil, false
	}
	targetID, err := pathInt64(r, param)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", invalidMsg)
		return nil, 0, nil, false
	}
	if req != nil {
		if err := json.NewDecoder(r.Body).Decode(req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return nil, 0, nil, false
		}
	}
	actorRole = actorRoleFromContext(r)
	if actorRole == nil {
		writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
		return nil, 0, nil, false
	}
	return ch, targetID, actorRole, true
}

func handlePutChannelPermission(channels *service.ChannelService, hub HubBroadcaster, permInvalidator PermissionInvalidator) http.HandlerFunc {
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
		applyOverrideResult(res, ch, hub, permInvalidator)
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

func handleDeleteChannelPermission(channels *service.ChannelService, hub HubBroadcaster, permInvalidator PermissionInvalidator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, roleID, actorRole, ok := overrideMutationSetup(channels, w, r, "roleId", "invalid role id", nil)
		if !ok {
			return
		}

		res, err := channels.DeleteRoleOverride(r.Context(), actorFromContext(r), actorRole, ch, roleID)
		if err != nil {
			writeOverrideErr(w, err)
			return
		}
		applyOverrideResult(res, ch, hub, permInvalidator)
		w.WriteHeader(http.StatusNoContent)
	}
}

// ─── Per-user channel overrides ──────────────────────────────────────────────
//
// channel_user_overrides is the last layer of the resolution order (base role
// perms -> role override -> user override), so these two endpoints can grant a
// single member access to a channel their role is denied, or take it away
// without minting a role for them. They invalidate only the target user's
// cached permissions: a per-user override cannot change anyone else's verdict.

func handlePutChannelUserPermission(channels *service.ChannelService, hub HubBroadcaster, permInvalidator PermissionInvalidator) http.HandlerFunc {
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
		applyOverrideResult(res, ch, hub, permInvalidator)
		writeJSON(w, http.StatusOK, db.ChannelUserOverride{
			UserID:   res.User.ID,
			Username: res.User.Username,
			RoleID:   res.User.RoleID,
			Allow:    res.Allow,
			Deny:     res.Deny,
		})
	}
}

func handleDeleteChannelUserPermission(channels *service.ChannelService, hub HubBroadcaster, permInvalidator PermissionInvalidator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, userID, actorRole, ok := overrideMutationSetup(channels, w, r, "userId", "invalid user id", nil)
		if !ok {
			return
		}

		res, err := channels.DeleteUserOverride(r.Context(), actorFromContext(r), actorRole, ch, userID)
		if err != nil {
			writeOverrideErr(w, err)
			return
		}
		applyOverrideResult(res, ch, hub, permInvalidator)
		w.WriteHeader(http.StatusNoContent)
	}
}
