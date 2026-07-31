package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
)

// ─── Request / Response types ────────────────────────────────────────────────

// updateProfileRequest is the JSON body for PATCH /api/v1/users/me.
// identity_public_key, when present, publishes the client's long-term E2EE
// identity public key (F3 voice E2EE TOFU); omitted = leave unchanged.
type updateProfileRequest struct {
	Username          string  `json:"username"`
	Avatar            *string `json:"avatar"`
	IdentityPublicKey *string `json:"identity_public_key"`
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
	BroadcastUserUpdate(userID int64, username string, avatar *string, identityPublicKey *string)
}

// MountProfileRoutes registers user profile management endpoints.
// All routes require authentication. trustedProxies is used for rate limiting.
func MountProfileRoutes(r chi.Router, database *db.DB, svc *service.Services, limiter *auth.RateLimiter, trustedProxies []string, broadcaster ProfileBroadcaster) {
	r.Route("/api/v1/users/me", func(r chi.Router) {
		r.Use(AuthMiddleware(database))

		r.With(RateLimitMiddleware(limiter, profileUpdateRateLimitPerMinute, time.Minute, trustedProxies)).
			Patch("/", handleUpdateProfile(svc, broadcaster))

		r.With(RateLimitMiddleware(limiter, profilePasswordRateLimitPerMinute, time.Minute, trustedProxies)).
			Put("/password", handleChangePassword(svc, limiter))

		r.Get("/sessions", handleListSessions(svc))
		r.Delete("/sessions/{id}", handleRevokeSession(svc))
	})
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// validateIdentityKey checks that key is non-empty, at most 128 characters and
// valid standard-alphabet base64 (padded or unpadded) — the same posture as
// the WS voice_e2ee_announce public_key validation.
func validateIdentityKey(key string) error {
	if key == "" {
		return fmt.Errorf("identity_public_key must not be empty")
	}
	if len(key) > 128 {
		return fmt.Errorf("identity_public_key too large (max 128 characters)")
	}
	if _, err := base64.StdEncoding.DecodeString(key); err == nil {
		return nil
	}
	if _, err := base64.RawStdEncoding.DecodeString(key); err != nil {
		return fmt.Errorf("identity_public_key is not valid base64")
	}
	return nil
}

// validateAvatarURL checks that avatar is either empty or a valid https:// URL
// no longer than maxAvatarURLLen characters.
func validateAvatarURL(avatar string) error {
	if avatar == "" {
		return nil
	}
	if len(avatar) > maxAvatarURLLen {
		return fmt.Errorf("avatar URL too long (max %d characters)", maxAvatarURLLen)
	}
	parsed, err := url.Parse(avatar)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return fmt.Errorf("avatar URL must use https://")
	}
	return nil
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// handleUpdateProfile processes PATCH /api/v1/users/me.
func handleUpdateProfile(svc *service.Services, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "not authenticated",
			})
			return
		}

		var req updateProfileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "INVALID_INPUT", Message: "malformed request body",
			})
			return
		}

		req.Username = strings.TrimSpace(sanitizer.Sanitize(req.Username))
		if req.Username == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "INVALID_INPUT", Message: "username is required",
			})
			return
		}
		if err := auth.ValidateUsername(req.Username); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "INVALID_INPUT", Message: err.Error(),
			})
			return
		}

		// Sanitize and validate avatar if provided.
		if req.Avatar != nil {
			trimmed := strings.TrimSpace(sanitizer.Sanitize(*req.Avatar))
			if err := validateAvatarURL(trimmed); err != nil {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error: "INVALID_INPUT", Message: err.Error(),
				})
				return
			}
			req.Avatar = &trimmed
		}

		// Validate the identity key before any write so the request is
		// all-or-nothing.
		if req.IdentityPublicKey != nil {
			trimmed := strings.TrimSpace(*req.IdentityPublicKey)
			if err := validateIdentityKey(trimmed); err != nil {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error: "INVALID_INPUT", Message: err.Error(),
				})
				return
			}
			req.IdentityPublicKey = &trimmed
		}

		updated, err := svc.Users.UpdateProfile(r.Context(), user.ID, req.Username, req.Avatar)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		if req.IdentityPublicKey != nil {
			updated, err = svc.Users.UpdateIdentityKey(r.Context(), user.ID, *req.IdentityPublicKey)
			if err != nil {
				writeServiceError(r.Context(), w, err)
				return
			}
		}

		// Broadcast profile change to all connected WebSocket clients.
		if broadcaster != nil {
			broadcaster.BroadcastUserUpdate(updated.ID, updated.Username, updated.Avatar, updated.IdentityPublicKey)
		}

		writeJSON(w, http.StatusOK, toUserResponse(updated))
	}
}

// handleChangePassword processes PUT /api/v1/users/me/password.
func handleChangePassword(svc *service.Services, limiter *auth.RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "not authenticated",
			})
			return
		}

		// BUG-111: Per-user lockout to prevent password brute-force via stolen session.
		lockKey := auth.Key("pw_confirm_lock", user.ID)
		if limiter.IsLockedOut(lockKey) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error: "RATE_LIMITED", Message: "too many failed attempts, try again later",
			})
			return
		}

		var req changePasswordRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "INVALID_INPUT", Message: "malformed request body",
			})
			return
		}

		if req.OldPassword == "" || req.NewPassword == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "INVALID_INPUT", Message: "old_password and new_password are required",
			})
			return
		}

		// Verify old password using constant-time bcrypt comparison.
		failKey := auth.Key("pw_confirm_fail", user.ID)
		if !auth.CheckPassword(user.PasswordHash, req.OldPassword) {
			if !limiter.Allow(failKey, pwConfirmFailureThreshold, pwConfirmFailureWindow) {
				limiter.Lockout(r.Context(), lockKey, pwConfirmLockoutDuration)
			}
			writeJSON(w, http.StatusForbidden, errorResponse{
				Error: "FORBIDDEN", Message: "incorrect password",
			})
			return
		}
		limiter.Reset(r.Context(), failKey)

		// Reject same old/new password.
		if req.OldPassword == req.NewPassword {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "INVALID_INPUT", Message: "new password must be different from old password",
			})
			return
		}

		// Validate new password strength.
		if err := auth.ValidatePasswordStrength(req.NewPassword); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "INVALID_INPUT", Message: err.Error(),
			})
			return
		}

		// Hash new password.
		hash, err := auth.HashPassword(req.NewPassword)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error: "INTERNAL_ERROR", Message: "failed to process password change",
			})
			return
		}

		// Delegate to service for password update + session revocation.
		sess, _ := r.Context().Value(SessionKey).(*db.Session)
		keepSessionID := int64(0)
		if sess != nil {
			keepSessionID = sess.ID
		}

		res, err := svc.Users.ChangePassword(r.Context(), user.ID, hash, keepSessionID)
		if err != nil {
			// Only reachable when the password itself failed to commit.
			writeServiceError(r.Context(), w, err)
			return
		}
		if res.RevokeFailed {
			// Partial success: the password IS changed; only revoking the
			// other sessions failed. A 5xx here would tell the user to retry
			// with a password that no longer works.
			writeJSON(w, http.StatusOK, map[string]any{
				"warning":          "password changed, but other sessions could not be revoked; revoke them from the sessions list",
				"sessions_revoked": res.SessionsRevoked,
			})
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// handleListSessions processes GET /api/v1/users/me/sessions.
func handleListSessions(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "not authenticated",
			})
			return
		}

		sess, ok := r.Context().Value(SessionKey).(*db.Session)
		if !ok || sess == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "not authenticated",
			})
			return
		}

		sessions, err := svc.Users.ListSessions(r.Context(), user.ID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
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
func handleRevokeSession(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "not authenticated",
			})
			return
		}

		sessionID, ok := parseIDParam(w, r, "id")
		if !ok {
			return
		}

		if err := svc.Users.RevokeSession(r.Context(), user.ID, sessionID); err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
