package admin

import (
	"errors"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// statsResponse is the dashboard payload: database stats plus the TLS mode and served certificate. The
// fingerprint is what users compare out of band before accepting the trust prompt; omitted when none (TLS
// off, ACME before its first handshake).
type statsResponse struct {
	*db.ServerStats
	TLSMode                string `json:"tls_mode,omitempty"`
	CertificateFingerprint string `json:"certificate_fingerprint,omitempty"`
}

func handleGetStats(users *service.UserService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stats, err := users.ServerStats(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to get stats")
			return
		}
		if hub != nil {
			stats.OnlineCount = hub.UserCount()
		}
		resp := statsResponse{ServerStats: stats, TLSMode: tlsMode}
		resp.CertificateFingerprint = servedCert().Fingerprint
		writeJSON(w, http.StatusOK, resp)
	}
}

// maxUserSearchLen bounds the search q parameter; a longer query is a mistake or abuse.
const maxUserSearchLen = 64

// handleListUsers serves the Members page: q matches username or nickname, role_id keeps one role, banned=1
// keeps effective bans. Filtering is in the query, so it covers every page.
func handleListUsers(users *service.UserService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := queryInt(r, "limit", 50, 1, 500)
		offset := queryInt(r, "offset", 0, 0, math.MaxInt32)
		filter := db.UserListFilter{
			Query:      strings.TrimSpace(r.URL.Query().Get("q")),
			RoleID:     int64(queryInt(r, "role_id", 0, 0, math.MaxInt32)),
			BannedOnly: r.URL.Query().Get("banned") == "1",
		}
		if utf8.RuneCountInString(filter.Query) > maxUserSearchLen {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "search is too long")
			return
		}

		page, err := users.ListAll(r.Context(), filter, limit, offset)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to list users")
			return
		}

		safe := make([]adminUserResponse, len(page))
		for i := range page {
			safe[i] = toAdminUserResponse(&page[i].User, page[i].RoleName)
			// The panel compares it with its own role_position to offer only the actions the outrank rule allows.
			safe[i].RolePosition = &page[i].RolePosition
			safe[i].RoleIDs = page[i].RoleIDs
			safe[i].DisplayName = page[i].DisplayName
		}
		writeJSON(w, http.StatusOK, safe)
	}
}

type patchUserRequest struct {
	RoleID    *int64  `json:"role_id"`
	Banned    *bool   `json:"banned"`
	BanReason *string `json:"ban_reason"`
	// BanDurationHours makes the ban expire after this many hours (login re-checks IsEffectivelyBanned); omitted
	// or 0 is permanent. Only with banned=true.
	BanDurationHours *int `json:"ban_duration_hours"`
	// DeleteMessageSeconds also deletes the banned member's messages from the last N seconds (0..604800) in
	// channels the actor may moderate. Only with banned=true.
	DeleteMessageSeconds *int `json:"delete_message_seconds"`
}

// maxBanDurationHours caps temporary bans at one year; longer is effectively permanent.
const maxBanDurationHours = 24 * 365

// memberUnbanBroadcaster is an optional HubBroadcaster capability (type-asserted so test doubles need not
// gain it): tell clients a user is back in the roster after an unban.
type memberUnbanBroadcaster interface {
	BroadcastMemberUnban(userID int64)
}

func writeModerationErr(w http.ResponseWriter, err error) {
	writeSvcErr(w, err, "user not found", "", "moderation action failed")
}

// patchUserPrecheck resolves and validates the PATCH target before any mutation; false means the error
// response is written.
func patchUserPrecheck(w http.ResponseWriter, r *http.Request, users *service.UserService) (int64, patchUserRequest, int64, bool) {
	var req patchUserRequest

	id, err := pathInt64(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid user id")
		return 0, req, 0, false
	}

	if !decodeJSON(w, r, &req) {
		return 0, req, 0, false
	}

	if _, err := users.Get(r.Context(), id); err != nil {
		if errors.Is(err, service.ErrNotFound) {
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "user not found")
		} else {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to fetch user")
		}
		return 0, req, 0, false
	}

	actor := actorFromContext(r)

	// Self role/ban changes could lock the admin out of the panel with no recovery path.
	if id == actor {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "cannot modify your own account via admin panel")
		return 0, req, 0, false
	}

	return id, req, actor, true
}

// patchUserAuthorizeRole runs every ChangeUserRole precondition without committing; no role_id is a no-op.
// False means the error is written.
func patchUserAuthorizeRole(w http.ResponseWriter, r *http.Request, mod *service.ModerationService, actor, id int64, req patchUserRequest) bool {
	if req.RoleID == nil {
		return true
	}
	if mod == nil {
		// Fail closed rather than fall back to an unchecked UPDATE.
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "moderation service unavailable")
		return false
	}
	if _, _, _, err := mod.AuthorizeRoleChange(r.Context(), actor, id, *req.RoleID); err != nil {
		writeModerationErr(w, err)
		return false
	}
	return true
}

// patchUserApplyBan commits the ban/unban half and fans it out; no banned field is a no-op. False means the
// error is written.
func patchUserApplyBan(w http.ResponseWriter, r *http.Request, hub HubBroadcaster, mod *service.ModerationService, actor, id int64, req patchUserRequest, banExpires *time.Time) bool {
	if req.Banned == nil {
		return true
	}
	if mod == nil {
		// Fail closed rather than fall back to an unchecked UPDATE.
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "moderation service unavailable")
		return false
	}
	banReason := ""
	if req.BanReason != nil {
		banReason = *req.BanReason
	}
	var actionErr error
	if *req.Banned {
		actionErr = mod.BanUser(r.Context(), actor, id, banReason, banExpires)
	} else {
		actionErr = mod.UnbanUser(r.Context(), actor, id)
	}
	if actionErr != nil {
		writeModerationErr(w, actionErr)
		return false
	}
	switch {
	case *req.Banned && hub != nil:
		hub.BroadcastMemberBan(id)
	case !*req.Banned && hub != nil:
		// Unban needs a WS event on the way back in (ban has member_ban), or connected clients keep the user
		// missing.
		if mub, ok := hub.(memberUnbanBroadcaster); ok {
			mub.BroadcastMemberUnban(id)
		}
	}
	return true
}

// patchUserApplyRole commits the role half; ModerationService invalidates cached permissions and fans out. No
// role_id is a no-op. False means the error is written.
func patchUserApplyRole(w http.ResponseWriter, r *http.Request, mod *service.ModerationService, actor, id int64, req patchUserRequest) bool {
	if req.RoleID == nil {
		return true
	}
	// ModerationService re-runs the MANAGE_ROLES, outranks-target and assign-below-own-rank checks (a second
	// pass catches a concurrent role delete), then commits and audits.
	if mod == nil {
		// Fail closed rather than fall back to an unchecked UPDATE.
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "moderation service unavailable")
		return false
	}
	_, err := mod.ChangeUserRole(r.Context(), actor, id, *req.RoleID)
	if err != nil {
		writeModerationErr(w, err)
		return false
	}
	return true
}

func handlePatchUser(users *service.UserService, hub HubBroadcaster, mod *service.ModerationService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, req, actor, ok := patchUserPrecheck(w, r, users)
		if !ok {
			return
		}

		purgeSeconds, ok := patchUserValidatePurge(w, req)
		if !ok {
			return
		}

		// Authorize the role change first: otherwise banned + role_id would commit and broadcast the ban, then a
		// refused role change would report failure for a banned target. Running every precondition up front keeps
		// the PATCH all-or-nothing.
		if !patchUserAuthorizeRole(w, r, mod, actor, id, req) {
			return
		}

		// Validate the ban's fields before the purge check spends the actor's rate-limit token, so a corrected
		// retry is not throttled.
		banExpires, ok := patchUserValidateBan(w, req)
		if !ok {
			return
		}

		// The purge checks (including rate limit) also run before the ban is written, so a refusal leaves the
		// target unbanned.
		if purgeSeconds > 0 && !patchUserAuthorizePurge(w, r, mod, actor, id) {
			return
		}
		retry := purgeSeconds > 0 && patchUserIsPurgeRetry(r, users, id, req)

		// Ban/unban goes through ModerationService, which enforces BAN_MEMBERS + hierarchy (the perimeter alone
		// does not); the role change was authorized above, so a committed ban cannot be followed by a refused role
		// change.
		if !retry && !patchUserApplyBan(w, r, hub, mod, actor, id, req, banExpires) {
			return
		}

		var purge *banPurgeOutcome
		if purgeSeconds > 0 {
			purge = patchUserPurge(r, hub, mod, actor, id, purgeSeconds)
		}

		if !patchUserApplyRole(w, r, mod, actor, id, req) {
			return
		}

		updated, roleName, err := users.GetWithRoleName(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to fetch updated user")
			return
		}
		if purge != nil {
			writeJSON(w, http.StatusOK, patchUserPurgeResponse{
				adminUserResponse: toAdminUserResponse(updated, roleName),
				Purge:             purge,
			})
			return
		}
		writeJSON(w, http.StatusOK, toAdminUserResponse(updated, roleName))
	}
}

// handleForceLogout revokes every session of the target. Gated on KICK_MEMBERS; ModerationService enforces
// the hierarchy and audits.
func handleForceLogout(mod *service.ModerationService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid user id")
			return
		}
		if mod == nil {
			// Fail closed rather than cut sessions without a hierarchy check.
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "moderation service unavailable")
			return
		}

		if err := mod.ForceLogout(r.Context(), actorFromContext(r), id); err != nil {
			writeModerationErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// writeMemberRoleErr maps a member's last role to 409 LAST_ROLE; everything else follows writeModerationErr.
func writeMemberRoleErr(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrLastRole) {
		writeErr(w, http.StatusConflict, httperr.CodeLastRole, "a member must keep at least one role")
		return
	}
	writeModerationErr(w, err)
}

// handleMemberRole serves PUT/DELETE {base}/{id}/roles/{roleId}: add or remove one role. Perimeter-level like
// PATCH; ModerationService enforces MANAGE_ROLES, hierarchy, cache invalidation, fan-out and the audit row.
func handleMemberRole(mod *service.ModerationService, add bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid user id")
			return
		}
		roleID, err := pathInt64(r, "roleId")
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid role id")
			return
		}
		if mod == nil {
			// Fail closed rather than write user_roles without the checks.
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "moderation service unavailable")
			return
		}
		if add {
			_, err = mod.AddUserRole(r.Context(), actorFromContext(r), id, roleID)
		} else {
			_, err = mod.RemoveUserRole(r.Context(), actorFromContext(r), id, roleID)
		}
		if err != nil {
			writeMemberRoleErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleDeleteUser erases the target account. Gated on ADMINISTRATOR; ModerationService enforces hierarchy,
// refuses the last admin-class account and audits. Clients get member_ban, which also disconnects the
// subject.
func handleDeleteUser(mod *service.ModerationService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid user id")
			return
		}
		if mod == nil {
			// Fail closed rather than erase without a hierarchy check.
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "moderation service unavailable")
			return
		}

		if err := mod.EraseUser(r.Context(), actorFromContext(r), id); err != nil {
			writeModerationErr(w, err)
			return
		}
		if hub != nil && !mod.ErasureBroadcastsMemberBan() {
			hub.BroadcastMemberBan(id)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleGetMe describes the calling principal so the panel can hide surfaces its role cannot use; every
// authenticated principal may read its own permissions. It adds the server name and build version, which the
// unauthenticated health and info responses keep version-free.
func handleGetMe(settings *service.SettingsService, version string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, userOK := r.Context().Value(adminUserKey).(*db.User)
		role, roleOK := r.Context().Value(adminRoleKey).(*db.Role)
		if !userOK || user == nil || !roleOK || role == nil {
			writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "not authenticated")
			return
		}
		me := adminMeResponse{
			ID:           user.ID,
			Username:     user.Username,
			RoleID:       role.ID,
			RoleName:     role.Name,
			RolePosition: role.Position,
			Permissions:  role.Permissions,
			IsOwner:      permissions.IsOwner(role.ID, role.Position),
			Version:      version,
		}
		if settings != nil {
			// Best effort: the name is decoration, so a failed read must not fail the permission lookup.
			me.ServerName, _ = settings.Setting(r.Context(), "server_name")
		}
		writeJSON(w, http.StatusOK, me)
	}
}
