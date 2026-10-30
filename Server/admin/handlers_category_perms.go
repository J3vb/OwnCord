package admin

import (
	"errors"
	"net/http"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

//
// A category's overrides are a template its synced channels follow. These
// adapters mirror the channel override handlers: decode, delegate to
// service.ChannelService (which holds every guard, writes the category row and
// the same row on each synced channel in one transaction, then drops the
// affected users' cached permissions and refreshes channel visibility for each
// channel the write touched), and respond. Mounted on /admin/api only, behind MANAGE_CHANNELS
// like the channel override routes.

// categoryPermissionsResponse is the JSON shape for GET .../permissions on a
// category: every role (zero masks when it carries no template row) and the
// members that have one.
type categoryPermissionsResponse struct {
	CategoryID int64                    `json:"category_id"`
	Roles      []db.ChannelRoleOverride `json:"roles"`
	Users      []db.ChannelUserOverride `json:"users"`
}

// writeCategoryPermErr is writeOverrideErr plus the one conflict a template
// write or a sync can answer: the rows changed under it, nothing was written.
func writeCategoryPermErr(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrPermsChanged) {
		writeErr(w, http.StatusConflict, httperr.CodePermissionsChanged, err.Error())
		return
	}
	writeOverrideErr(w, err)
}

// categoryPermSetup decodes the preamble every category template mutation
// shares: the category id, the target id from param, the optional body and the
// authenticated actor's role. ok is false when a response has been written.
func categoryPermSetup(channels *service.ChannelService, w http.ResponseWriter, r *http.Request, param, invalidMsg string, req *putChannelPermissionRequest) (categoryID, targetID int64, actorRole *db.Role, ok bool) {
	if channels == nil {
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "channel service unavailable")
		return 0, 0, nil, false
	}
	categoryID, err := pathInt64(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid category id")
		return 0, 0, nil, false
	}
	targetID, err = pathInt64(r, param)
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, invalidMsg)
		return 0, 0, nil, false
	}
	if req != nil {
		if !decodeJSON(w, r, req) {
			return 0, 0, nil, false
		}
	}
	actorRole = actorRoleFromContext(r)
	if actorRole == nil {
		writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "not authenticated")
		return 0, 0, nil, false
	}
	return categoryID, targetID, actorRole, true
}

func handleGetCategoryPermissions(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		categoryID, _, _, ok := categoryPermSetup(channels, w, r, "id", "invalid category id", nil)
		if !ok {
			return
		}
		roles, users, err := channels.CategoryPermissions(r.Context(), categoryID)
		if err != nil {
			writeCategoryPermErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, categoryPermissionsResponse{CategoryID: categoryID, Roles: roles, Users: users})
	}
}

func handlePutCategoryPermission(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req putChannelPermissionRequest
		categoryID, roleID, actorRole, ok := categoryPermSetup(channels, w, r, "roleId", "invalid role id", &req)
		if !ok {
			return
		}
		res, err := channels.PutCategoryRoleOverride(r.Context(), actorFromContext(r), actorRole, categoryID, roleID, req.Allow, req.Deny)
		if err != nil {
			writeCategoryPermErr(w, err)
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

func handleDeleteCategoryPermission(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		categoryID, roleID, actorRole, ok := categoryPermSetup(channels, w, r, "roleId", "invalid role id", nil)
		if !ok {
			return
		}
		_, err := channels.DeleteCategoryRoleOverride(r.Context(), actorFromContext(r), actorRole, categoryID, roleID)
		if err != nil {
			writeCategoryPermErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handlePutCategoryUserPermission(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req putChannelPermissionRequest
		categoryID, userID, actorRole, ok := categoryPermSetup(channels, w, r, "userId", "invalid user id", &req)
		if !ok {
			return
		}
		res, err := channels.PutCategoryUserOverride(r.Context(), actorFromContext(r), actorRole, categoryID, userID, req.Allow, req.Deny)
		if err != nil {
			writeCategoryPermErr(w, err)
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

func handleDeleteCategoryUserPermission(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		categoryID, userID, actorRole, ok := categoryPermSetup(channels, w, r, "userId", "invalid user id", nil)
		if !ok {
			return
		}
		_, err := channels.DeleteCategoryUserOverride(r.Context(), actorFromContext(r), actorRole, categoryID, userID)
		if err != nil {
			writeCategoryPermErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleSyncChannelPermissions re-syncs one channel to its category's
// template. 400 when the channel has no category, 403 when the actor could not
// have written the rows it would remove or write.
func handleSyncChannelPermissions(channels *service.ChannelService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch := getPermChannel(channels, w, r)
		if ch == nil {
			return
		}
		actorRole := actorRoleFromContext(r)
		if actorRole == nil {
			writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "not authenticated")
			return
		}
		_, err := channels.SyncChannelPermissions(r.Context(), actorFromContext(r), actorRole, ch)
		if err != nil {
			writeCategoryPermErr(w, err)
			return
		}
		synced, err := channels.ChannelPermissionsSynced(r.Context(), ch.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to read channel permissions")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"channel_id": ch.ID, "permissions_synced": synced})
	}
}
