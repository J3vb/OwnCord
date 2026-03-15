package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/updater"
)

// ─── Context keys ─────────────────────────────────────────────────────────────

// adminContextKey is an unexported type for context keys in the admin package.
type adminContextKey int

const (
	// adminUserKey is the context key for the authenticated *db.User.
	adminUserKey adminContextKey = iota
	// adminSessionKey is the context key for the authenticated *db.Session.
	adminSessionKey
)

// ─── Allowed settings keys ────────────────────────────────────────────────────

// allowedSettingKeys is the whitelist of keys that may be written via
// PATCH /admin/api/settings. Derived from the settings table in SCHEMA.md.
var allowedSettingKeys = map[string]struct{}{
	"server_name":       {},
	"server_icon":       {},
	"motd":              {},
	"max_upload_bytes":  {},
	"voice_quality":     {},
	"require_2fa":       {},
	"registration_open": {},
	"backup_schedule":   {},
	"backup_retention":  {},
}

// HubBroadcaster is the subset of ws.Hub needed by the admin package.
type HubBroadcaster interface {
	BroadcastServerRestart(reason string, delaySeconds int)
	BroadcastChannelCreate(ch *db.Channel)
	BroadcastChannelUpdate(ch *db.Channel)
	BroadcastChannelDelete(channelID int64)
}

// ─── NewAdminAPI ──────────────────────────────────────────────────────────────

// NewAdminAPI returns a chi router with all /admin/api/* routes. All routes
// are protected by adminAuthMiddleware which requires the ADMINISTRATOR bit,
// except for the setup endpoints which are unauthenticated.
func NewAdminAPI(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater) http.Handler {
	r := chi.NewRouter()

	// Setup endpoints — unauthenticated, only functional when no users exist.
	r.Get("/setup/status", handleSetupStatus(database))
	r.Post("/setup", handleSetup(database))

	// All remaining routes require authentication and ADMINISTRATOR permission.
	r.Group(func(r chi.Router) {
		r.Use(adminAuthMiddleware(database))

		r.Get("/stats", handleGetStats(database))
		r.Get("/users", handleListUsers(database))
		r.Patch("/users/{id}", handlePatchUser(database))
		r.Delete("/users/{id}/sessions", handleForceLogout(database))
		r.Get("/channels", handleListChannels(database))
		r.Post("/channels", handleCreateChannel(database, hub))
		r.Patch("/channels/{id}", handlePatchChannel(database, hub))
		r.Delete("/channels/{id}", handleDeleteChannel(database, hub))
		r.Get("/audit-log", handleGetAuditLog(database))
		r.Get("/settings", handleGetSettings(database))
		r.Patch("/settings", handlePatchSettings(database))
		r.Post("/backup", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleBackup(database)).ServeHTTP(w, req)
		}))
		r.Get("/updates", handleCheckUpdate(u))
		r.Post("/updates/apply", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleApplyUpdate(u, hub, version)).ServeHTTP(w, req)
		}))
	})

	return r
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// adminAuthMiddleware validates the Bearer token and requires ADMINISTRATOR.
// On success it stores the *db.User and *db.Session in the request context so
// downstream handlers can retrieve them without re-querying the database.
func adminAuthMiddleware(database *db.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := auth.ExtractBearerToken(r)
			if !ok {
				writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "missing or invalid authorization header")
				return
			}

			hash := auth.HashToken(token)
			sess, err := database.GetSessionByTokenHash(hash)
			if err != nil || sess == nil {
				writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid or expired session")
				return
			}

			if auth.IsSessionExpired(sess.ExpiresAt) {
				writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "session has expired")
				return
			}

			user, err := database.GetUserByID(sess.UserID)
			if err != nil || user == nil {
				writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "user not found")
				return
			}

			role, err := database.GetRoleByID(user.RoleID)
			if err != nil || role == nil {
				writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "role not found")
				return
			}

			if !permissions.HasAdmin(role.Permissions) {
				writeErr(w, http.StatusForbidden, "FORBIDDEN", "administrator permission required")
				return
			}

			ctx := context.WithValue(r.Context(), adminUserKey, user)
			ctx = context.WithValue(ctx, adminSessionKey, sess)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ownerOnlyMiddleware wraps a handler to require Owner role (position == 100).
// It reads the user from context (set by adminAuthMiddleware) rather than
// re-authenticating, avoiding redundant DB queries and session-expiry gaps.
func ownerOnlyMiddleware(database *db.DB, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(adminUserKey).(*db.User)
		if !ok || user == nil {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
			return
		}

		role, err := database.GetRoleByID(user.RoleID)
		if err != nil || role == nil {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", "role not found")
			return
		}

		if role.Position < permissions.OwnerRolePosition {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", "owner role required")
			return
		}

		next.ServeHTTP(w, r)
	})
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

func handleGetStats(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stats, err := database.GetServerStats()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get stats")
			return
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

// adminUserResponse is the safe public shape returned by user-listing and
// user-patch endpoints. It deliberately excludes PasswordHash and TOTPSecret.
type adminUserResponse struct {
	ID        int64   `json:"id"`
	Username  string  `json:"username"`
	Avatar    *string `json:"avatar,omitempty"`
	RoleID    int64   `json:"role_id"`
	RoleName  string  `json:"role_name"`
	Status    string  `json:"status"`
	CreatedAt string  `json:"created_at"`
	LastSeen  *string `json:"last_seen,omitempty"`
	Banned    bool    `json:"banned"`
	BanReason *string `json:"ban_reason,omitempty"`
	BanExpires *string `json:"ban_expires,omitempty"`
}

// toAdminUserResponse converts a db.UserWithRole to the safe response shape.
func toAdminUserResponse(u db.UserWithRole) adminUserResponse {
	return adminUserResponse{
		ID:        u.ID,
		Username:  u.Username,
		Avatar:    u.Avatar,
		RoleID:    u.RoleID,
		RoleName:  u.RoleName,
		Status:    u.Status,
		CreatedAt: u.CreatedAt,
		LastSeen:  u.LastSeen,
		Banned:    u.Banned,
		BanReason: u.BanReason,
		BanExpires: u.BanExpires,
	}
}

// toAdminUserResponseFromUser converts a plain db.User to the safe response
// shape, leaving RoleName empty (it is unknown without a join).
func toAdminUserResponseFromUser(u *db.User) adminUserResponse {
	return adminUserResponse{
		ID:        u.ID,
		Username:  u.Username,
		Avatar:    u.Avatar,
		RoleID:    u.RoleID,
		Status:    u.Status,
		CreatedAt: u.CreatedAt,
		LastSeen:  u.LastSeen,
		Banned:    u.Banned,
		BanReason: u.BanReason,
		BanExpires: u.BanExpires,
	}
}

// patchUserRequest is the JSON body for PATCH /admin/api/users/{id}.
type patchUserRequest struct {
	RoleID    *int64  `json:"role_id"`
	Banned    *bool   `json:"banned"`
	BanReason *string `json:"ban_reason"`
}

func handlePatchUser(database *db.DB) http.HandlerFunc {
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
		writeJSON(w, http.StatusOK, toAdminUserResponseFromUser(updated))
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

func handleListChannels(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channels, err := database.ListChannels()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list channels")
			return
		}
		writeJSON(w, http.StatusOK, channels)
	}
}

// createChannelRequest is the JSON body for POST /admin/api/channels.
type createChannelRequest struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Category string `json:"category"`
	Topic    string `json:"topic"`
	Position int    `json:"position"`
}

func handleCreateChannel(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createChannelRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		if strings.TrimSpace(req.Name) == "" {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "name is required")
			return
		}
		if req.Type == "" {
			req.Type = "text"
		}

		id, err := database.AdminCreateChannel(req.Name, req.Type, req.Category, req.Topic, req.Position)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create channel")
			return
		}

		ch, err := database.GetChannel(id)
		if err != nil || ch == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch created channel")
			return
		}
		actor := actorFromContext(r)
		slog.Info("channel created", "actor_id", actor, "channel", req.Name, "type", req.Type)
		_ = database.LogAudit(actor, "channel_create", "channel", id,
			fmt.Sprintf("created #%s (%s)", req.Name, req.Type))
		if hub != nil {
			hub.BroadcastChannelCreate(ch)
		}
		writeJSON(w, http.StatusCreated, ch)
	}
}

// updateChannelRequest is the JSON body for PATCH /admin/api/channels/{id}.
type updateChannelRequest struct {
	Name     string `json:"name"`
	Topic    string `json:"topic"`
	SlowMode int    `json:"slow_mode"`
	Position int    `json:"position"`
	Archived bool   `json:"archived"`
}

func handlePatchChannel(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid channel id")
			return
		}

		existing, err := database.GetChannel(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch channel")
			return
		}
		if existing == nil {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "channel not found")
			return
		}

		// Start from existing values so a partial body is safe.
		req := updateChannelRequest{
			Name:     existing.Name,
			Topic:    existing.Topic,
			SlowMode: existing.SlowMode,
			Position: existing.Position,
			Archived: existing.Archived,
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		if err := database.AdminUpdateChannel(id, req.Name, req.Topic, req.SlowMode, req.Position, req.Archived); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to update channel")
			return
		}

		actor := actorFromContext(r)
		slog.Info("channel updated", "actor_id", actor, "channel_id", id, "name", req.Name)
		_ = database.LogAudit(actor, "channel_update", "channel", id,
			fmt.Sprintf("updated #%s", req.Name))

		updated, err := database.GetChannel(id)
		if err != nil || updated == nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch updated channel")
			return
		}
		if hub != nil {
			hub.BroadcastChannelUpdate(updated)
		}
		writeJSON(w, http.StatusOK, updated)
	}
}

func handleDeleteChannel(database *db.DB, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathInt64(r, "id")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid channel id")
			return
		}

		existing, err := database.GetChannel(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch channel")
			return
		}
		if existing == nil {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "channel not found")
			return
		}

		if err := database.AdminDeleteChannel(id); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to delete channel")
			return
		}
		actor := actorFromContext(r)
		slog.Warn("channel deleted", "actor_id", actor, "channel_id", id, "name", existing.Name)
		_ = database.LogAudit(actor, "channel_delete", "channel", id,
			fmt.Sprintf("deleted #%s", existing.Name))
		if hub != nil {
			hub.BroadcastChannelDelete(id)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleGetAuditLog(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := queryInt(r, "limit", 50)
		offset := queryInt(r, "offset", 0)

		entries, err := database.GetAuditLog(limit, offset)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get audit log")
			return
		}
		writeJSON(w, http.StatusOK, entries)
	}
}

func handleGetSettings(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		settings, err := database.GetAllSettings()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get settings")
			return
		}
		writeJSON(w, http.StatusOK, settings)
	}
}

func handlePatchSettings(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var updates map[string]string
		if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		// Validate all keys against the whitelist before writing anything so
		// the operation is atomic from the caller's perspective.
		for key := range updates {
			if _, ok := allowedSettingKeys[key]; !ok {
				writeErr(w, http.StatusBadRequest, "BAD_REQUEST",
					fmt.Sprintf("unknown setting key: %q", key))
				return
			}
		}

		actor := actorFromContext(r)
		for key, value := range updates {
			if err := database.SetSetting(key, value); err != nil {
				writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to update setting: "+key)
				return
			}
			slog.Info("setting changed", "actor_id", actor, "key", key)
			_ = database.LogAudit(actor, "setting_change", "setting", 0,
				fmt.Sprintf("%s updated", key))
		}

		settings, err := database.GetAllSettings()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch settings")
			return
		}
		writeJSON(w, http.StatusOK, settings)
	}
}

func handleBackup(database *db.DB) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backupDir := filepath.Join("data", "backups")
		if err := os.MkdirAll(backupDir, 0o750); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create backup directory")
			return
		}

		timestamp := time.Now().UTC().Format("20060102_150405")
		backupPath := filepath.Join(backupDir, "chatserver_"+timestamp+".db")

		if err := database.BackupTo(backupPath); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "backup failed")
			return
		}

		actor := actorFromContext(r)
		slog.Info("database backup created", "actor_id", actor, "path", backupPath)
		_ = database.LogAudit(actor, "backup_create", "server", 0,
			fmt.Sprintf("backup saved to %s", backupPath))

		writeJSON(w, http.StatusOK, map[string]string{
			"path":    backupPath,
			"created": timestamp,
		})
	})
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type errorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, errorResponse{Error: code, Message: msg})
}

func pathInt64(r *http.Request, param string) (int64, error) {
	raw := chi.URLParam(r, param)
	return strconv.ParseInt(raw, 10, 64)
}

func queryInt(r *http.Request, key string, defaultVal int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return defaultVal
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return defaultVal
	}
	// Cap to prevent unbounded result sets exhausting memory.
	const maxLimit = 500
	if n > maxLimit {
		return maxLimit
	}
	return n
}

// actorFromContext returns the authenticated user's ID stored in the request
// context by adminAuthMiddleware. Returns 0 if called outside that middleware
// (should not happen in production).
func actorFromContext(r *http.Request) int64 {
	user, ok := r.Context().Value(adminUserKey).(*db.User)
	if !ok || user == nil {
		return 0
	}
	return user.ID
}
