package admin

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/owncord/server/db"
)

// ─── User Handlers ───────────────────────────────────────────────────────────

func handleGetStats(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stats, err := database.GetServerStats()
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
		limit := queryInt(r, "limit", 50)
		offset := queryInt(r, "offset", 0)

		users, err := database.ListAllUsers(limit, offset)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list users")
			return
		}

		safe := make([]adminUserResponse, len(users))
		for i, u := range users {
			safe[i] = toAdminUserResponse(u)
		}
		writeJSON(w, http.StatusOK, safe)
	}
}

// patchUserRequest is the JSON body for PATCH /admin/api/users/{id}.
type patchUserRequest struct {
	RoleID    *int64  `json:"role_id"`
	Banned    *bool   `json:"banned"`
	BanReason *string `json:"ban_reason"`
}

func handlePatchUser(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
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

		user, err := database.GetUserByID(id)
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

		if req.RoleID != nil {
			if err := database.UpdateUserRole(id, *req.RoleID); err != nil {
				writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to update role")
				return
			}
			slog.Info("role changed", "actor_id", actor, "target_user", user.Username, "new_role_id", *req.RoleID)
			_ = database.LogAudit(actor, "role_change", "user", id,
				fmt.Sprintf("changed %s role to %d", user.Username, *req.RoleID))
			// Broadcast member_update with the new role name.
			if role, err := database.GetRoleByID(*req.RoleID); err == nil && role != nil {
				if hub != nil {
					hub.BroadcastMemberUpdate(id, role.Name)
				}
			}
		}

		if req.Banned != nil {
			reason := ""
			if req.BanReason != nil {
				reason = *req.BanReason
			}
			if *req.Banned {
				if err := database.BanUser(id, reason, nil); err != nil {
					writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to ban user")
					return
				}
				slog.Warn("user banned", "actor_id", actor, "target_user", user.Username, "reason", reason)
				_ = database.LogAudit(actor, "user_ban", "user", id,
					fmt.Sprintf("banned %s: %s", user.Username, reason))
				if hub != nil {
					hub.BroadcastMemberBan(id)
				}
			} else {
				if err := database.UnbanUser(id); err != nil {
					writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to unban user")
					return
				}
				slog.Info("user unbanned", "actor_id", actor, "target_user", user.Username)
				_ = database.LogAudit(actor, "user_unban", "user", id,
					fmt.Sprintf("unbanned %s", user.Username))
			}
		}

		updated, err := database.GetUserByID(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch updated user")
			return
		}
		writeJSON(w, http.StatusOK, toAdminUserResponseFromUser(database, updated))
	}
}

func handleForceLogout(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid user id")
			return
		}

		if err := database.ForceLogoutUser(id); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to logout user")
			return
		}
		actor := actorFromContext(r)
		slog.Info("force logout", "actor_id", actor, "target_user_id", id)
		_ = database.LogAudit(actor, "force_logout", "user", id, "all sessions terminated")
		w.WriteHeader(http.StatusNoContent)
	}
}
