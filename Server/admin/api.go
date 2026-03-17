package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

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
	BroadcastMemberBan(userID int64)
	BroadcastMemberUpdate(userID int64, roleName string)
	ClientCount() int
}

// ─── adminUserResponse ──────────────────────────────────────────────────────

// adminUserResponse is the safe public shape returned by user-listing and
// user-patch endpoints. It deliberately excludes PasswordHash and TOTPSecret.
type adminUserResponse struct {
	ID         int64   `json:"id"`
	Username   string  `json:"username"`
	Avatar     *string `json:"avatar,omitempty"`
	RoleID     int64   `json:"role_id"`
	RoleName   string  `json:"role_name"`
	Status     string  `json:"status"`
	CreatedAt  string  `json:"created_at"`
	LastSeen   *string `json:"last_seen,omitempty"`
	Banned     bool    `json:"banned"`
	BanReason  *string `json:"ban_reason,omitempty"`
	BanExpires *string `json:"ban_expires,omitempty"`
}

// toAdminUserResponse converts a db.UserWithRole to the safe response shape.
func toAdminUserResponse(u db.UserWithRole) adminUserResponse {
	return adminUserResponse{
		ID:         u.ID,
		Username:   u.Username,
		Avatar:     u.Avatar,
		RoleID:     u.RoleID,
		RoleName:   u.RoleName,
		Status:     u.Status,
		CreatedAt:  u.CreatedAt,
		LastSeen:   u.LastSeen,
		Banned:     u.Banned,
		BanReason:  u.BanReason,
		BanExpires: u.BanExpires,
	}
}

// toAdminUserResponseFromUser converts a plain db.User to the safe response
// shape, resolving the role name via the database.
func toAdminUserResponseFromUser(database *db.DB, u *db.User) adminUserResponse {
	roleName := ""
	if role, err := database.GetRoleByID(u.RoleID); err == nil && role != nil {
		roleName = role.Name
	}
	return adminUserResponse{
		ID:         u.ID,
		Username:   u.Username,
		Avatar:     u.Avatar,
		RoleID:     u.RoleID,
		RoleName:   roleName,
		Status:     u.Status,
		CreatedAt:  u.CreatedAt,
		LastSeen:   u.LastSeen,
		Banned:     u.Banned,
		BanReason:  u.BanReason,
		BanExpires: u.BanExpires,
	}
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

		r.Get("/stats", handleGetStats(database, hub))
		r.Get("/users", handleListUsers(database))
		r.Patch("/users/{id}", handlePatchUser(database, hub))
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
		r.Get("/backups", handleListBackups())
		r.Delete("/backups/{name}", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleDeleteBackup(database)).ServeHTTP(w, req)
		}))
		r.Post("/backups/{name}/restore", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ownerOnlyMiddleware(database, handleRestoreBackup(database)).ServeHTTP(w, req)
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
