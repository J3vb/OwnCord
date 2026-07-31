package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/service"
)

// ─── User Handlers ───────────────────────────────────────────────────────────

func handleGetStats(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stats, err := database.GetServerStats(r.Context())
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

func handleListUsers(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := queryInt(r, "limit", 50, 1)
		offset := queryInt(r, "offset", 0, 0)

		users, err := database.ListAllUsers(r.Context(), limit, offset)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list users")
			return
		}

		safe := make([]adminUserResponse, len(users))
		for i := range users {
			safe[i] = toAdminUserResponse(users[i])
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

func handlePatchUser(database *db.DB, hub HubBroadcaster, permInvalidator PermissionInvalidator, mod *service.ModerationService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid user id")
			return
		}

		var req patchUserRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		user, err := database.GetUserByID(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch user")
			return
		}
		if user == nil {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "user not found")
			return
		}

		actor := actorFromContext(r)

		// Prevent admins from modifying their own role or ban status, which
		// could lock them out of the admin panel with no recovery path.
		if id == actor {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "cannot modify your own account via admin panel")
			return
		}

		// Ban/unban first: it routes through ModerationService, which enforces
		// BAN_MEMBERS + role hierarchy (the admin-auth perimeter alone does
		// not — any admin-panel actor could previously ban the owner). The
		// service also audits and refuses before the role change runs, so a
		// rejected ban never leaves a half-applied PATCH behind.
		if req.Banned != nil {
			if mod == nil {
				// Fail closed rather than fall back to an unchecked UPDATE.
				writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "moderation service unavailable")
				return
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
					return
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
				return
			}
			if *req.Banned && hub != nil {
				hub.BroadcastMemberBan(id)
			}
		}

		if req.RoleID != nil {
			// Routed through ModerationService, which enforces MANAGE_ROLES,
			// the actor-outranks-target rule, and the assign-below-own-rank
			// rule (without it any admin could promote anyone to Owner), and
			// writes the audit row.
			if mod == nil {
				// Fail closed rather than fall back to an unchecked UPDATE.
				writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "moderation service unavailable")
				return
			}
			if err := mod.ChangeUserRole(r.Context(), actor, id, *req.RoleID); err != nil {
				writeModerationErr(w, err)
				return
			}
			if permInvalidator != nil {
				permInvalidator.InvalidateUser(id)
			}
			if role, err := database.GetRoleByID(r.Context(), *req.RoleID); err == nil && role != nil {
				if hub != nil {
					hub.BroadcastMemberUpdate(id, role.Name)
				}
			}
		}

		updated, err := database.GetUserByID(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch updated user")
			return
		}
		writeJSON(w, http.StatusOK, toAdminUserResponseFromUser(r.Context(), database, updated))
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
