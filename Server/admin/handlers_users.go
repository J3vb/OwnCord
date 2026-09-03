package admin

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// ─── User Handlers ───────────────────────────────────────────────────────────

func handleGetStats(users *service.UserService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stats, err := users.ServerStats(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get stats")
			return
		}
		if hub != nil {
			stats.OnlineCount = hub.ClientCount()
		}
		writeJSON(w, http.StatusOK, stats)
	}
}

func handleListUsers(users *service.UserService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := queryInt(r, "limit", 50, 1, 500)
		offset := queryInt(r, "offset", 0, 0, math.MaxInt32)

		page, err := users.ListAll(r.Context(), limit, offset)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list users")
			return
		}

		safe := make([]adminUserResponse, len(page))
		for i := range page {
			safe[i] = toAdminUserResponse(page[i])
		}
		writeJSON(w, http.StatusOK, safe)
	}
}

// patchUserRequest is the JSON body for PATCH /admin/api/users/{id}.
type patchUserRequest struct {
	RoleID    *int64  `json:"role_id"`
	Banned    *bool   `json:"banned"`
	BanReason *string `json:"ban_reason"`
	// BanDurationHours makes the ban temporary: it expires this many hours
	// from now (login re-checks via IsEffectivelyBanned). Omitted or 0 =
	// permanent. Only meaningful with banned=true.
	BanDurationHours *int `json:"ban_duration_hours"`
}

// maxBanDurationHours caps temporary bans at one year; anything longer is
// effectively permanent and should be issued as such.
const maxBanDurationHours = 24 * 365

// memberUnbanBroadcaster is an optional capability of HubBroadcaster: tell
// every connected client a user is back in the roster after an unban, the
// mirror of BroadcastMemberBan. It is checked with a type assertion instead
// of being added to HubBroadcaster directly (admin/types.go, not owned by
// this change) so this fix does not force every HubBroadcaster
// implementation — production and test doubles alike — to gain the method
// before it compiles. See the batch report's cross_batch note: *ws.Hub needs
// BroadcastMemberUnban(userID int64) wired up for this to take effect at
// runtime; until then the assertion below simply misses and the handler's
// existing (pre-fix) behavior is unchanged.
type memberUnbanBroadcaster interface {
	BroadcastMemberUnban(userID int64)
}

// writeModerationErr maps ModerationService errors onto admin API responses.
func writeModerationErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrForbidden):
		writeErr(w, http.StatusForbidden, "FORBIDDEN", err.Error())
	case errors.Is(err, service.ErrNotFound):
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "user not found")
	case errors.Is(err, service.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "moderation action failed")
	}
}

// patchUserPrecheck resolves and validates the target of a
// PATCH /admin/api/users/{id} before any mutation is attempted. It reports
// whether the handler may continue; on false it has already written the error
// response.
func patchUserPrecheck(w http.ResponseWriter, r *http.Request, users *service.UserService) (int64, patchUserRequest, int64, bool) {
	var req patchUserRequest

	id, err := pathInt64(r, "id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid user id")
		return 0, req, 0, false
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return 0, req, 0, false
	}

	if _, err := users.Get(r.Context(), id); err != nil {
		if errors.Is(err, service.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "user not found")
		} else {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch user")
		}
		return 0, req, 0, false
	}

	actor := actorFromContext(r)

	// Prevent admins from modifying their own role or ban status, which
	// could lock them out of the admin panel with no recovery path.
	if id == actor {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "cannot modify your own account via admin panel")
		return 0, req, 0, false
	}

	return id, req, actor, true
}

// patchUserAuthorizeRole runs every ChangeUserRole precondition for a PATCH
// carrying role_id without committing anything; a request without role_id is
// a no-op. It reports whether the handler may continue; on false it has
// already written the error response.
func patchUserAuthorizeRole(w http.ResponseWriter, r *http.Request, mod *service.ModerationService, actor, id int64, req patchUserRequest) bool {
	if req.RoleID == nil {
		return true
	}
	if mod == nil {
		// Fail closed rather than fall back to an unchecked UPDATE.
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "moderation service unavailable")
		return false
	}
	if _, _, _, err := mod.AuthorizeRoleChange(r.Context(), actor, id, *req.RoleID); err != nil {
		writeModerationErr(w, err)
		return false
	}
	return true
}

// patchUserApplyBan commits the ban/unban half of the PATCH and fans the
// result out to connected clients; a request without banned is a no-op. It
// reports whether the handler may continue; on false it has already written
// the error response.
func patchUserApplyBan(w http.ResponseWriter, r *http.Request, hub HubBroadcaster, mod *service.ModerationService, actor, id int64, req patchUserRequest) bool {
	if req.Banned == nil {
		return true
	}
	if mod == nil {
		// Fail closed rather than fall back to an unchecked UPDATE.
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "moderation service unavailable")
		return false
	}
	banReason := ""
	if req.BanReason != nil {
		banReason = *req.BanReason
	}
	var banExpires *time.Time
	if req.BanDurationHours != nil && *req.BanDurationHours != 0 {
		hours := *req.BanDurationHours
		if hours < 0 || hours > maxBanDurationHours {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "ban_duration_hours must be between 1 and 8760")
			return false
		}
		t := time.Now().Add(time.Duration(hours) * time.Hour)
		banExpires = &t
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
		// Ban had no WS event on the way out (member_ban hard-deletes
		// the row client-side); unban needs one on the way back in, or
		// every already-connected client keeps the user missing from
		// its member store while a freshly connecting client sees them.
		if mub, ok := hub.(memberUnbanBroadcaster); ok {
			mub.BroadcastMemberUnban(id)
		}
	}
	return true
}

// patchUserApplyRole commits the role half of the PATCH and fans the result
// out to connected clients; a request without role_id is a no-op. It reports
// whether the handler may continue; on false it has already written the error
// response.
func patchUserApplyRole(w http.ResponseWriter, r *http.Request, hub HubBroadcaster, permInvalidator PermissionInvalidator, mod *service.ModerationService, actor, id int64, req patchUserRequest) bool {
	if req.RoleID == nil {
		return true
	}
	// Routed through ModerationService, which re-runs the same
	// MANAGE_ROLES, actor-outranks-target, and assign-below-own-rank
	// checks the AuthorizeRoleChange pre-flight above already passed
	// (a second pass, not a redundant one: it catches anything that
	// changed in the window between the pre-flight and here, e.g. a
	// concurrent role delete), then commits and writes the audit row.
	if mod == nil {
		// Fail closed rather than fall back to an unchecked UPDATE.
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "moderation service unavailable")
		return false
	}
	newRole, err := mod.ChangeUserRole(r.Context(), actor, id, *req.RoleID)
	if err != nil {
		writeModerationErr(w, err)
		return false
	}
	if permInvalidator != nil {
		permInvalidator.InvalidateUser(id)
	}
	// Use the role ChangeUserRole already loaded and validated rather
	// than re-reading it: a re-read can race a concurrent role delete
	// (or a transient read error) and silently skip this whole
	// fan-out, leaving the demoted user's socket subscribed to
	// channels it can no longer read (OC-0045). The role change
	// itself already committed, so the fan-out must not be
	// conditional on anything past that point.
	if hub != nil {
		hub.BroadcastMemberUpdate(id, newRole.Name)
		// BroadcastMemberUpdate only revokes subscriptions the new
		// role can no longer read (hub_broadcast.go's
		// revokeUnreadableChannels); it never grants the ones the
		// new role newly gained READ_MESSAGES on. Without this,
		// a promoted user's sidebar is missing channels until
		// their next reconnect, unlike a role permission edit or
		// a role delete, which both re-derive visibility fully.
		hub.RefreshAllChannelVisibility()
	}
	return true
}

func handlePatchUser(users *service.UserService, hub HubBroadcaster, permInvalidator PermissionInvalidator, mod *service.ModerationService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, req, actor, ok := patchUserPrecheck(w, r, users)
		if !ok {
			return
		}

		// Authorize the role change before applying anything else. Without
		// this pre-flight, a PATCH combining banned + role_id would commit
		// and broadcast the ban first and only then attempt the role change:
		// if that role change was then refused (missing MANAGE_ROLES, or the
		// new role outranks the actor), the handler reported the whole
		// request as failed while the target was in fact banned, audited,
		// and already dropped from every connected client's member list
		// (OC-0215). Running every ChangeUserRole precondition up front,
		// before either mutation lands, keeps the PATCH all-or-nothing from
		// the caller's perspective.
		if !patchUserAuthorizeRole(w, r, mod, actor, id, req) {
			return
		}

		// Ban/unban first: it routes through ModerationService, which enforces
		// BAN_MEMBERS + role hierarchy (the admin-auth perimeter alone does
		// not — any admin-panel actor could previously ban the owner). The
		// role change, if requested, was already authorized above, so a ban
		// committing here cannot be followed by a refused role change leaving
		// a half-applied PATCH behind.
		if !patchUserApplyBan(w, r, hub, mod, actor, id, req) {
			return
		}

		if !patchUserApplyRole(w, r, hub, permInvalidator, mod, actor, id, req) {
			return
		}

		updated, roleName, err := users.GetWithRoleName(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch updated user")
			return
		}
		writeJSON(w, http.StatusOK, toAdminUserResponseFromUser(updated, roleName))
	}
}

// handleForceLogout revokes every session of the target user. The route is
// gated on KICK_MEMBERS; ModerationService additionally enforces the
// actor-outranks-target hierarchy and writes the audit row.
func handleForceLogout(mod *service.ModerationService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid user id")
			return
		}
		if mod == nil {
			// Fail closed rather than cut sessions without a hierarchy check.
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "moderation service unavailable")
			return
		}

		if err := mod.ForceLogout(r.Context(), actorFromContext(r), id); err != nil {
			writeModerationErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleDeleteUser erases the target account (B4-9). The route is gated on
// ADMINISTRATOR; ModerationService additionally enforces the
// actor-outranks-target hierarchy, refuses the last admin-class account and
// writes the audit row. On success every connected client gets the same
// member_ban the ban path sends, which also disconnects the subject.
func handleDeleteUser(mod *service.ModerationService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid user id")
			return
		}
		if mod == nil {
			// Fail closed rather than erase without a hierarchy check.
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "moderation service unavailable")
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

// handleGetMe describes the calling principal so the admin panel can hide the
// surfaces its role cannot use. Perimeter-level: every authenticated principal
// may read its own permissions.
func handleGetMe() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, userOK := r.Context().Value(adminUserKey).(*db.User)
		role, roleOK := r.Context().Value(adminRoleKey).(*db.Role)
		if !userOK || user == nil || !roleOK || role == nil {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
			return
		}
		writeJSON(w, http.StatusOK, adminMeResponse{
			ID:           user.ID,
			Username:     user.Username,
			RoleID:       role.ID,
			RoleName:     role.Name,
			RolePosition: role.Position,
			Permissions:  role.Permissions,
			IsOwner:      role.Position >= permissions.OwnerRolePosition,
		})
	}
}
