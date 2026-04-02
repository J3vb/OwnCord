package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// ─── Request / Response types ────────────────────────────────────────────────

// updateProfileRequest is the JSON body for PATCH /api/v1/users/me.
type updateProfileRequest struct {
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
}

// changePasswordRequest is the JSON body for PUT /api/v1/users/me/password.
type changePasswordRequest struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
}

// sessionResponse is the JSON shape for a single session in list responses.
type sessionResponse struct {
	ID        int64  `json:"id"`
	Device    string `json:"device"`
	IP        string `json:"ip"`
	CreatedAt string `json:"created_at"`
	LastUsed  string `json:"last_used"`
	IsCurrent bool   `json:"is_current"`
}

// sessionsListResponse is the JSON envelope for GET /api/v1/users/me/sessions.
type sessionsListResponse struct {
	Sessions []sessionResponse `json:"sessions"`
}

// ─── Route mounting ──────────────────────────────────────────────────────────

// ProfileBroadcaster is the interface the profile handler uses to notify
// connected WebSocket clients about profile changes.
type ProfileBroadcaster interface {
	BroadcastUserUpdate(userID int64, username string, avatar *string)
}

// MountProfileRoutes registers user profile management endpoints.
// All routes require authentication. trustedProxies is used for rate limiting.
func MountProfileRoutes(r chi.Router, database *db.DB, limiter *auth.RateLimiter, trustedProxies []string, broadcaster ProfileBroadcaster) {
	r.Route("/api/v1/users/me", func(r chi.Router) {
		r.Use(AuthMiddleware(database))

		r.Patch("/", handleUpdateProfile(database, broadcaster))

		r.With(RateLimitMiddleware(limiter, profilePasswordRateLimitPerMinute, time.Minute, trustedProxies)).
			Put("/password", handleChangePassword(database, limiter))

		r.Get("/sessions", handleListSessions(database))
		r.Delete("/sessions/{id}", handleRevokeSession(database))
	})
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// handleUpdateProfile processes PATCH /api/v1/users/me.
func handleUpdateProfile(database *db.DB, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		var req updateProfileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		req.Username = strings.TrimSpace(sanitizer.Sanitize(req.Username))

		if req.Username == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "username is required",
			})
			return
		}

		if err := auth.ValidateUsername(req.Username); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}

		// Sanitize avatar if provided.
		if req.Avatar != nil {
			trimmed := strings.TrimSpace(sanitizer.Sanitize(*req.Avatar))
			req.Avatar = &trimmed
		}

		if err := database.UpdateUserProfile(user.ID, req.Username, req.Avatar); err != nil {
			if db.IsUniqueConstraintError(err) {
				writeJSON(w, http.StatusConflict, errorResponse{
					Error:   "CONFLICT",
					Message: "username is already taken",
				})
				return
			}
			slog.Error("UpdateUserProfile failed", "err", err, "user_id", user.ID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to update profile",
			})
			return
		}

		// Re-fetch user for the response.
		updated, err := database.GetUserByID(user.ID)
		if err != nil || updated == nil {
			slog.Error("failed to fetch user after profile update", "user_id", user.ID, "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "profile updated but fetch failed",
			})
			return
		}

		slog.Info("profile updated", "user_id", user.ID, "new_username", req.Username)
		_ = database.LogAudit(user.ID, "profile_update", "user", user.ID, "profile updated")

		// Broadcast profile change to all connected WebSocket clients.
		if broadcaster != nil {
			broadcaster.BroadcastUserUpdate(updated.ID, updated.Username, updated.Avatar)
		}

		writeJSON(w, http.StatusOK, toUserResponse(updated))
	}
}

// handleChangePassword processes PUT /api/v1/users/me/password.
func handleChangePassword(database *db.DB, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		// BUG-111: Per-user lockout to prevent password brute-force via stolen session.
		lockKey := fmt.Sprintf("pw_confirm_lock:%d", user.ID)
		if limiter.IsLockedOut(lockKey) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error:   "RATE_LIMITED",
				Message: "too many failed attempts, try again later",
			})
			return
		}

		var req changePasswordRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "malformed request body",
			})
			return
		}

		if req.OldPassword == "" || req.NewPassword == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "old_password and new_password are required",
			})
			return
		}

		// Verify old password using constant-time bcrypt comparison.
		failKey := fmt.Sprintf("pw_confirm_fail:%d", user.ID)
		if !auth.CheckPassword(user.PasswordHash, req.OldPassword) {
			if !limiter.Allow(failKey, pwConfirmFailureThreshold, pwConfirmFailureWindow) {
				limiter.Lockout(lockKey, pwConfirmLockoutDuration)
			}
			writeJSON(w, http.StatusForbidden, errorResponse{
				Error:   "FORBIDDEN",
				Message: "incorrect password",
			})
			return
		}
		limiter.Reset(failKey)

		// Reject same old/new password.
		if req.OldPassword == req.NewPassword {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: "new password must be different from old password",
			})
			return
		}

		// Validate new password strength.
		if err := auth.ValidatePasswordStrength(req.NewPassword); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "INVALID_INPUT",
				Message: err.Error(),
			})
			return
		}

		// Hash new password.
		hash, err := auth.HashPassword(req.NewPassword)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to process password change",
			})
			return
		}

		if err := database.UpdateUserPassword(user.ID, hash); err != nil {
			slog.Error("UpdateUserPassword failed", "err", err, "user_id", user.ID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to update password",
			})
			return
		}

		// BUG-108: Revoke all other sessions after password change.
		if sess, ok := r.Context().Value(SessionKey).(*db.Session); ok && sess != nil {
			n, err := database.DeleteOtherSessions(user.ID, sess.ID)
			if err != nil {
				slog.Error("DeleteOtherSessions after password change", "err", err, "user_id", user.ID)
			} else if n > 0 {
				slog.Info("revoked other sessions after password change", "user_id", user.ID, "revoked", n)
			}
		}

		slog.Info("password changed", "user_id", user.ID)
		_ = database.LogAudit(user.ID, "password_change", "user", user.ID, "password changed")

		w.WriteHeader(http.StatusNoContent)
	}
}

// handleListSessions processes GET /api/v1/users/me/sessions.
func handleListSessions(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		sess, ok := r.Context().Value(SessionKey).(*db.Session)
		if !ok || sess == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		sessions, err := database.ListUserSessions(user.ID)
		if err != nil {
			slog.Error("ListUserSessions failed", "err", err, "user_id", user.ID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to list sessions",
			})
			return
		}

		resp := sessionsListResponse{
			Sessions: make([]sessionResponse, 0, len(sessions)),
		}
		for _, s := range sessions {
			resp.Sessions = append(resp.Sessions, sessionResponse{
				ID:        s.ID,
				Device:    s.Device,
				IP:        s.IP,
				CreatedAt: s.CreatedAt,
				LastUsed:  s.LastUsed,
				IsCurrent: s.ID == sess.ID,
			})
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

// handleRevokeSession processes DELETE /api/v1/users/me/sessions/{id}.
func handleRevokeSession(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error:   "UNAUTHORIZED",
				Message: "not authenticated",
			})
			return
		}

		sessionID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}

		if err := database.DeleteSessionByID(sessionID, user.ID); err != nil {
			if errors.Is(err, db.ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errorResponse{
					Error:   "NOT_FOUND",
					Message: "session not found",
				})
				return
			}
			slog.Error("DeleteSessionByID failed", "err", err, "session_id", sessionID, "user_id", user.ID)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error:   "INTERNAL_ERROR",
				Message: "failed to revoke session",
			})
			return
		}

		slog.Info("session revoked", "user_id", user.ID, "session_id", sessionID)
		_ = database.LogAudit(user.ID, "session_revoke", "session", sessionID, "session revoked")

		w.WriteHeader(http.StatusNoContent)
	}
}
