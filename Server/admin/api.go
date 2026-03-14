package admin

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/updater"
)

// HubBroadcaster is the subset of ws.Hub needed by the admin package.
type HubBroadcaster interface {
	BroadcastServerRestart(reason string, delaySeconds int)
}

// ─── Permission constants ─────────────────────────────────────────────────────

const (
	permAdministrator = int64(0x40000000)
	ownerRolePosition = 100
)

// ─── NewAdminAPI ──────────────────────────────────────────────────────────────

// NewAdminAPI returns a chi router with all /admin/api/* routes. All routes
// are protected by adminAuthMiddleware which requires the ADMINISTRATOR bit.
func NewAdminAPI(database *db.DB, version string, hub HubBroadcaster, u *updater.Updater) http.Handler {
	r := chi.NewRouter()

	// All routes require authentication and ADMINISTRATOR permission.
	r.Use(adminAuthMiddleware(database))

	r.Get("/stats", handleGetStats(database))
	r.Get("/users", handleListUsers(database))
	r.Patch("/users/{id}", handlePatchUser(database))
	r.Delete("/users/{id}/sessions", handleForceLogout(database))
	r.Get("/channels", handleListChannels(database))
	r.Post("/channels", handleCreateChannel(database))
	r.Patch("/channels/{id}", handlePatchChannel(database))
	r.Delete("/channels/{id}", handleDeleteChannel(database))
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

	return r
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// adminAuthMiddleware validates the Bearer token and requires ADMINISTRATOR.
func adminAuthMiddleware(database *db.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := extractBearer(r)
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

			if isExpired(sess.ExpiresAt) {
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

			if role.Permissions&permAdministrator == 0 {
				writeErr(w, http.StatusForbidden, "FORBIDDEN", "administrator permission required")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// ownerOnlyMiddleware wraps a handler to require Owner role (position == 100).
func ownerOnlyMiddleware(database *db.DB, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := extractBearer(r)
		if !ok {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "missing authorization header")
			return
		}

		hash := auth.HashToken(token)
		sess, err := database.GetSessionByTokenHash(hash)
		if err != nil || sess == nil {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid session")
			return
		}

		user, err := database.GetUserByID(sess.UserID)
		if err != nil || user == nil {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "user not found")
			return
		}

		role, err := database.GetRoleByID(user.RoleID)
		if err != nil || role == nil {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", "role not found")
			return
		}

		if role.Position < ownerRolePosition {
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
		writeJSON(w, http.StatusOK, users)
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

		if req.RoleID != nil {
			if err := database.UpdateUserRole(id, *req.RoleID); err != nil {
				writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to update role")
				return
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
			} else {
				if err := database.UnbanUser(id); err != nil {
					writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to unban user")
					return
				}
			}
		}

		updated, err := database.GetUserByID(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to fetch updated user")
			return
		}
		writeJSON(w, http.StatusOK, updated)
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

func handleCreateChannel(database *db.DB) http.HandlerFunc {
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

func handlePatchChannel(database *db.DB) http.HandlerFunc {
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

		updated, _ := database.GetChannel(id)
		writeJSON(w, http.StatusOK, updated)
	}
}

func handleDeleteChannel(database *db.DB) http.HandlerFunc {
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

		for key, value := range updates {
			if err := database.SetSetting(key, value); err != nil {
				writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to update setting: "+key)
				return
			}
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

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, errorResponse{Error: code, Message: msg})
}

func extractBearer(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return "", false
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") || parts[1] == "" {
		return "", false
	}
	return parts[1], true
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
	if err != nil || n < 0 {
		return defaultVal
	}
	return n
}

func isExpired(expiresAt string) bool {
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02T15:04:05Z"} {
		t, err := time.Parse(layout, expiresAt)
		if err == nil {
			return time.Now().UTC().After(t.UTC())
		}
	}
	return true
}
