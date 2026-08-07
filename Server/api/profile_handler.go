package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
	"github.com/owncord/server/storage"
	"github.com/owncord/server/ws"
)

// ─── Request / Response types ────────────────────────────────────────────────

// updateProfileRequest is the JSON body for PATCH /api/v1/users/me.
// identity_public_key, when present, publishes the client's long-term E2EE
// identity public key (F3 voice E2EE TOFU); omitted = leave unchanged.
type updateProfileRequest struct {
	Username          string  `json:"username"`
	Avatar            *string `json:"avatar"`
	IdentityPublicKey *string `json:"identity_public_key"`
	// DisplayName and About are omitted = unchanged, "" = cleared. Both are
	// sanitized and length-checked in UserService, which is also the path a
	// non-REST caller would take.
	DisplayName *string `json:"display_name"`
	About       *string `json:"about"`
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
	BroadcastUserUpdate(u ws.UserUpdate)
}

// MountProfileRoutes registers user profile management endpoints.
// All routes require authentication. trustedProxies is used for rate limiting.
//
// store may be nil, in which case the avatar-upload route is not registered —
// a server with no storage backend has nowhere to put the bytes, and a route
// that 500s on every call is worse than one that 404s.
func MountProfileRoutes(r chi.Router, database *db.DB, svc *service.Services, store *storage.Storage, limiter *auth.RateLimiter, trustedProxies []string, broadcaster ProfileBroadcaster) {
	r.Route("/api/v1/users/me", func(r chi.Router) {
		r.Use(AuthMiddleware(database))

		r.With(RateLimitMiddleware(limiter, "profile:", profileUpdateRateLimitPerMinute, time.Minute, trustedProxies)).
			Patch("/", handleUpdateProfile(svc, broadcaster))

		r.With(RateLimitMiddleware(limiter, "pw:", profilePasswordRateLimitPerMinute, time.Minute, trustedProxies)).
			Put("/password", handleChangePassword(svc, limiter))

		if store != nil {
			r.With(MaxBodySize(avatarMaxBodySize)).
				Post("/avatar", handleUploadAvatar(database, svc, store, limiter, broadcaster))
		}

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

// validateDisplayName rejects a nickname that would render as something other
// than what it says. Length and emptiness are the service's job (empty clears
// the field); this is the character-class check auth.ValidateUsername applies
// for the same reason — a display name stands in for a username on every
// message row, so a bidi override or a control character in one is a spoof.
func validateDisplayName(name string) error {
	for _, r := range name {
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) {
			return fmt.Errorf("display_name must not contain control or invisible characters")
		}
	}
	return nil
}

// allowedAvatarMIME is the set of image types an avatar may be, matched against
// the type sniffed from the file's own bytes. GIF is absent (an animated
// avatar in every message row is a distraction the renderer cannot opt out of)
// and so is SVG, for the same reason emoji refuse it: it is markup with script
// and external-fetch capability, and an avatar is rendered inline by
// definition.
var allowedAvatarMIME = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,
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

		// display_name gets the same username-shaped scrutiny beyond length:
		// it is rendered wherever a username is, so control characters and
		// bidi overrides are exactly as unwelcome here. Length, sanitization
		// and the empty-clears-it rule live in UserService.
		if req.DisplayName != nil {
			if err := validateDisplayName(*req.DisplayName); err != nil {
				writeJSON(w, http.StatusBadRequest, errorResponse{
					Error: "INVALID_INPUT", Message: err.Error(),
				})
				return
			}
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

		updated, err := svc.Users.UpdateProfile(r.Context(), user.ID, service.ProfilePatch{
			Username:    req.Username,
			Avatar:      req.Avatar,
			DisplayName: req.DisplayName,
			About:       req.About,
		})
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		if req.IdentityPublicKey != nil {
			// Captured into a separate variable rather than reassigned into
			// updated: on failure below, updated still holds the profile
			// snapshot that DID commit, so it can still be broadcast instead
			// of discarded.
			withKey, keyErr := svc.Users.UpdateIdentityKey(r.Context(), user.ID, *req.IdentityPublicKey)
			if keyErr != nil {
				// The username/avatar/display_name/about write above already
				// committed — only the identity key failed. Broadcasting the
				// committed half keeps every other connected client in sync
				// even though this request reports failure; leaving it
				// unbroadcast would strand them on the old profile until
				// their next ready.
				broadcastUserUpdate(broadcaster, updated)
				writeServiceError(r.Context(), w, keyErr)
				return
			}
			updated = withKey
		}

		broadcastUserUpdate(broadcaster, updated)

		writeJSON(w, http.StatusOK, toUserResponse(updated))
	}
}

// broadcastUserUpdate pushes a profile snapshot to every connected client.
// Every profile mutation goes through it so a new one cannot ship half the
// fields — user_update replaces the client's copy wholesale.
func broadcastUserUpdate(broadcaster ProfileBroadcaster, u *db.User) {
	if broadcaster == nil || u == nil {
		return
	}
	broadcaster.BroadcastUserUpdate(ws.UserUpdate{
		UserID:            u.ID,
		Username:          u.Username,
		Avatar:            u.Avatar,
		DisplayName:       u.DisplayName,
		About:             u.About,
		IdentityPublicKey: u.IdentityPublicKey,
	})
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

		// An API-token principal has a nil session (middleware.go); the list
		// still works — no row is marked current. Only IsCurrent needs it.
		sess, _ := r.Context().Value(SessionKey).(*db.Session)

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
				IsCurrent: sess != nil && s.ID == sess.ID,
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

// handleUploadAvatar processes POST /api/v1/users/me/avatar (multipart: `file`).
//
// The bytes land in the ordinary attachments table with no channel, and the
// user's avatar column is pointed at /api/v1/files/{id}. That is what makes
// the picture readable: an unlinked attachment is private to its uploader, and
// handleServeFile additionally admits one that some user's avatar currently
// points at — so an avatar is public exactly while it is in use and stops
// being readable the moment it is replaced.
//
// PATCH /users/me still takes an https:// URL; this route is the other way to
// set the same field, and both end at the same column.
func handleUploadAvatar(
	database *db.DB,
	svc *service.Services,
	store *storage.Storage,
	limiter *auth.RateLimiter,
	broadcaster ProfileBroadcaster,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "not authenticated",
			})
			return
		}

		if limiter != nil && !limiter.Allow(auth.Key("avatar_upload", user.ID), avatarUploadRateLimitPerMinute, time.Minute) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error: "RATE_LIMITED", Message: "avatar upload rate limit exceeded, try again later",
			})
			return
		}

		// Bound the body before the multipart parser touches it: the route
		// carries MaxBodySize too, but the parser is what turns an unbounded
		// body into heap, so the handler states its own limit.
		r.Body = http.MaxBytesReader(w, r.Body, avatarMaxBodySize)
		if err := r.ParseMultipartForm(avatarMultipartMemoryLimit); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "BAD_REQUEST", Message: "invalid multipart form",
			})
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "BAD_REQUEST", Message: "missing file field",
			})
			return
		}
		defer file.Close() //nolint:errcheck

		// Read one byte past the cap so "exactly at the limit" passes and "one
		// byte over" is caught, without buffering an unbounded body.
		raw, err := io.ReadAll(io.LimitReader(file, maxAvatarFileBytes+1))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "BAD_REQUEST", Message: "failed to read uploaded file",
			})
			return
		}
		if int64(len(raw)) > maxAvatarFileBytes {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: fmt.Sprintf("avatar must be at most %d KB", maxAvatarFileBytes>>10),
			})
			return
		}

		// Never trust the client's Content-Type — sniff the bytes.
		mimeType := http.DetectContentType(raw)
		if !allowedAvatarMIME[mimeType] {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "BAD_REQUEST", Message: "avatar must be a PNG, JPEG or WebP image",
			})
			return
		}

		width, height, err := imageDimensions(raw, mimeType)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "BAD_REQUEST", Message: "could not read image dimensions",
			})
			return
		}
		// Measured from the sniffed image, not from anything the client said.
		// The client crops to a square before uploading; the server does not
		// re-encode (that would mean decoding and re-compressing every upload
		// to change nothing a CSS circle mask does not already do), it just
		// refuses a picture too big to be an avatar.
		if width <= 0 || height <= 0 || width > maxAvatarDimension || height > maxAvatarDimension {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error:   "BAD_REQUEST",
				Message: fmt.Sprintf("avatar must be at most %dx%d pixels (got %dx%d)", maxAvatarDimension, maxAvatarDimension, width, height),
			})
			return
		}

		fileID := uuid.New().String()
		written, saveErr := store.Save(fileID, bytes.NewReader(raw))
		if saveErr != nil {
			slog.Warn("avatar upload rejected by storage", "error", saveErr)
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "BAD_REQUEST", Message: fmt.Sprintf("upload rejected: %s", saveErr),
			})
			return
		}

		filename := sanitizeUploadFilename(header.Filename)
		if err := database.CreateAttachment(r.Context(), fileID, user.ID, filename, fileID, mimeType, written, &width, &height); err != nil {
			if delErr := store.Delete(fileID); delErr != nil {
				slog.Error("failed to clean up orphaned avatar file", "stored_as", fileID, "error", delErr)
			}
			slog.Error("failed to create avatar attachment record", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{
				Error: "INTERNAL_ERROR", Message: "failed to save avatar",
			})
			return
		}

		avatarURL := service.AvatarFileURL(fileID)
		updated, err := svc.Users.UpdateProfile(r.Context(), user.ID, service.ProfilePatch{
			Username: user.Username,
			Avatar:   &avatarURL,
		})
		if err != nil {
			// The column never moved, so the file and its row are orphans.
			if delErr := store.Delete(fileID); delErr != nil {
				slog.Error("failed to clean up orphaned avatar file", "stored_as", fileID, "error", delErr)
			}
			writeServiceError(r.Context(), w, err)
			return
		}

		// The previous avatar's bytes are deliberately left on disk: a message
		// that was rendered with it may still be cached client-side, and a
		// blind delete here would race any request already in flight for it.
		// Reclaiming them is an operator-side sweep, not a request-path action.
		broadcastUserUpdate(broadcaster, updated)

		slog.Info("avatar uploaded", "user_id", user.ID, "id", fileID, "size", written, "mime", mimeType)
		writeJSON(w, http.StatusCreated, uploadResponse{
			ID:       fileID,
			Filename: filename,
			Size:     written,
			Mime:     mimeType,
			URL:      avatarURL,
			Width:    &width,
			Height:   &height,
		})
	}
}
