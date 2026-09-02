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

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// ─── Request / Response types ────────────────────────────────────────────────

// userResponse is the caller's own user record, the shape auth responses and
// PATCH /users/me return. It lives beside the profile handler because this is
// the file that still sees db.User; the auth handlers get it through
// toUserResponse without naming db (B3-2).
type userResponse struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar,omitempty"`
	// DisplayName and About are always present (null = unset) so the settings
	// form can tell "cleared" from "the server does not know this field".
	DisplayName *string `json:"display_name"`
	About       *string `json:"about"`
	// CustomStatus is the user's own free-text status line.
	CustomStatus *string `json:"custom_status"`
	// Status is the user's own true status, invisible included. This response
	// only ever describes the caller, so there is nothing to hide from them.
	Status      string `json:"status"`
	RoleID      int64  `json:"role_id"`
	TOTPEnabled bool   `json:"totp_enabled"`
	CreatedAt   string `json:"created_at"`
}

// toUserResponse converts a db.User to the API response shape.
func toUserResponse(u *db.User) *userResponse {
	avatar := ""
	if u.Avatar != nil {
		avatar = *u.Avatar
	}
	return &userResponse{
		ID:           u.ID,
		Username:     u.Username,
		Avatar:       avatar,
		DisplayName:  u.DisplayName,
		About:        u.About,
		CustomStatus: u.CustomStatus,
		Status:       u.Status,
		RoleID:       u.RoleID,
		TOTPEnabled:  u.TOTPSecret != nil,
		CreatedAt:    u.CreatedAt,
	}
}

// updateProfileRequest is the JSON body for PATCH /api/v1/users/me.
// identity_public_key, when present, publishes the client's long-term E2EE
// identity public key (F3 voice E2EE TOFU); omitted = leave unchanged.
type updateProfileRequest struct {
	Username          string  `json:"username"`
	Avatar            *string `json:"avatar"`
	IdentityPublicKey *string `json:"identity_public_key"`
	// DisplayName and About are omitted = unchanged, "" = cleared. Both are
	// length-checked in UserService, which is also the path a non-REST
	// caller would take; DisplayName is additionally sanitized in this
	// handler (before validateDisplayName runs — see the OC-0197 comment at
	// the call site) and UserService's own sanitize of it is then a no-op.
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

// SessionDisconnector is the hub's half of sign-out-everywhere: once the
// sessions are gone, the live sockets they authenticated must go too, or a
// device keeps its connection until the revoked-session sweep notices
// (Codex P1 on PR #1500). *ws.Hub implements it; a ProfileBroadcaster that
// does not (tests, a nil hub) simply skips the disconnect.
type SessionDisconnector interface {
	DisconnectRevokedUser(userID int64)
}

// revokeAllSessionsRateLimitPerMinute bounds DELETE /api/v1/users/me/sessions
// per account. A session principal revokes itself with the first call; an
// API-token principal keeps its credential, so the cap is what keeps repeated
// no-op calls from costing anything (Codex P2 on PR #1500).
const revokeAllSessionsRateLimitPerMinute = 5

// MountProfileRoutes registers user profile management endpoints.
// All routes require authentication. trustedProxies is used for rate limiting.
//
// store may be nil, in which case the avatar-upload route is not registered —
// a server with no storage backend has nowhere to put the bytes, and a route
// that 500s on every call is worse than one that 404s.
func MountProfileRoutes(r chi.Router, database *db.DB, svc *service.Services, store FileStore, limiter *auth.RateLimiter, trustedProxies []string, broadcaster ProfileBroadcaster) {
	r.Route("/api/v1/users/me", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))

		r.With(RateLimitMiddleware(limiter, "profile:", profileUpdateRateLimitPerMinute, time.Minute, trustedProxies)).
			Patch("/", handleUpdateProfile(svc, broadcaster))

		r.With(RateLimitMiddleware(limiter, "pw:", profilePasswordRateLimitPerMinute, time.Minute, trustedProxies)).
			Put("/password", handleChangePassword(svc, limiter))

		if store != nil {
			r.With(MaxBodySize(avatarMaxBodySize)).
				Post("/avatar", handleUploadAvatar(svc, store, limiter, broadcaster))
		}

		r.Get("/sessions", handleListSessions(svc))
		r.Delete("/sessions", handleRevokeAllSessions(svc, limiter, broadcaster))
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
// parseUpdateProfileRequest decodes the PATCH /users/me body and applies the
// bound-then-sanitize-then-validate pass to every field, in the same order the
// register path canonicalizes them. On any failure it writes the error response
// and returns ok=false, and the caller must return without writing anything
// further. Split out of handleUpdateProfile only to keep that handler under the
// funlen limit; the field logic is unchanged.
func parseUpdateProfileRequest(w http.ResponseWriter, r *http.Request) (updateProfileRequest, bool) {
	var req updateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error: "INVALID_INPUT", Message: "malformed request body",
		})
		return req, false
	}

	// OC-0151: bound the raw field before it ever reaches the fixpoint
	// sanitizer below, for the same reason as the register path
	// (auth_handler.go's registerReadRequest) — sanitizeToFixpoint's
	// cost is quadratic in input length, and nothing bounds this field
	// before it runs. This is a cheap byte-length pre-check — *4 still
	// admits any legitimate 32-rune UTF-8 username.
	if len(req.Username) > maxLoginUsernameLen*4 {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error: "INVALID_INPUT", Message: "username is too long",
		})
		return req, false
	}

	// Use the fixpoint sanitizer (service.SanitizeText), not a bare
	// bluemonday.StrictPolicy().Sanitize call — Sanitize's output is always
	// HTML-escaped, so a plain apostrophe would be persisted as &#39;
	// and login (which never re-escapes) would look the account up
	// under a name that no longer matches. See service.SanitizeText's
	// doc comment and the register path (auth_handler.go), which
	// already canonicalizes the same way.
	req.Username = strings.TrimSpace(service.SanitizeText(req.Username))
	if req.Username == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error: "INVALID_INPUT", Message: "username is required",
		})
		return req, false
	}
	if err := auth.ValidateUsername(req.Username); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error: "INVALID_INPUT", Message: err.Error(),
		})
		return req, false
	}

	// OC-0192: bound the raw field before it reaches the fixpoint
	// sanitizer below, same reasoning as the username bound above —
	// sanitizeToFixpoint's cost is quadratic in input length. Unlike
	// username, an oversized avatar was previously only caught *after*
	// sanitizing, by validateAvatarURL's maxAvatarURLLen check.
	if req.Avatar != nil && len(*req.Avatar) > maxAvatarURLLen*4 {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error: "INVALID_INPUT", Message: "avatar URL is too long",
		})
		return req, false
	}

	// Sanitize and validate avatar if provided. Use the fixpoint
	// sanitizer (service.SanitizeText), not a bare
	// bluemonday.StrictPolicy().Sanitize call — Sanitize's output is always HTML-escaped, so a URL with more
	// than one query parameter would have its "&" separators rewritten
	// to "&amp;" and be persisted (and served) broken. Same reasoning as
	// the username path above.
	if req.Avatar != nil {
		trimmed := strings.TrimSpace(service.SanitizeText(*req.Avatar))
		if err := validateAvatarURL(trimmed); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "INVALID_INPUT", Message: err.Error(),
			})
			return req, false
		}
		req.Avatar = &trimmed
	}

	// display_name gets the same username-shaped scrutiny beyond length:
	// it is rendered wherever a username is, so control characters and
	// bidi overrides are exactly as unwelcome here. Length and the
	// empty-clears-it rule still live in UserService, but sanitizing has
	// to happen *before* validateDisplayName, not after: OC-0197 found
	// that validating the raw JSON string let an HTML-entity-encoded
	// control or bidi character (e.g. "&#x202e;") pass this check as
	// harmless ASCII, only to be turned into the real character
	// afterwards by UserService.UpdateProfile's cleanText call — the
	// same sanitize-then-validate order the username path above already
	// uses. OC-0192's raw-byte bound applies here too, now that
	// sanitizing happens in this handler (UserService.UpdateProfile
	// still bounds DisplayName/About the same way before its own
	// cleanText calls, for any non-REST caller; cleanText's fixpoint
	// output is stable, so that re-sanitize is a no-op here).
	if req.DisplayName != nil {
		if len(*req.DisplayName) > service.MaxDisplayNameLen*4 {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "INVALID_INPUT", Message: "display_name is too long",
			})
			return req, false
		}
		trimmed := strings.TrimSpace(service.SanitizeText(*req.DisplayName))
		if err := validateDisplayName(trimmed); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "INVALID_INPUT", Message: err.Error(),
			})
			return req, false
		}
		req.DisplayName = &trimmed
	}

	// Validate the identity key before any write so the request is
	// all-or-nothing.
	if req.IdentityPublicKey != nil {
		trimmed := strings.TrimSpace(*req.IdentityPublicKey)
		if err := validateIdentityKey(trimmed); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "INVALID_INPUT", Message: err.Error(),
			})
			return req, false
		}
		req.IdentityPublicKey = &trimmed
	}
	return req, true
}

func handleUpdateProfile(svc *service.Services, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "not authenticated",
			})
			return
		}

		req, ok := parseUpdateProfileRequest(w, r)
		if !ok {
			return
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
			if !limiter.Allow(failKey, service.PwConfirmFailureThreshold, service.PwConfirmFailureWindow) {
				limiter.Lockout(r.Context(), lockKey, service.PwConfirmLockoutDuration)
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

// revokeAllSessionsResponse is the JSON shape returned by
// DELETE /api/v1/users/me/sessions: the count, and an explicit note that the
// caller's own session was among them, so the client knows to re-authenticate
// rather than treat the next 401 as an error.
type revokeAllSessionsResponse struct {
	SessionsRevoked int64 `json:"sessions_revoked"`
	CurrentRevoked  bool  `json:"current_session_revoked"`
}

// handleRevokeAllSessions processes DELETE /api/v1/users/me/sessions —
// sign-out-everywhere. The current session is revoked with the rest, and so
// is every live WebSocket the account holds.
func handleRevokeAllSessions(svc *service.Services, limiter *auth.RateLimiter, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(UserKey).(*db.User)
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{
				Error: "UNAUTHORIZED", Message: "not authenticated",
			})
			return
		}
		sess, _ := r.Context().Value(SessionKey).(*db.Session)

		// Per account, not per IP: the principal is authenticated, and the
		// no-op case (an API token with nothing to revoke) is the one to cap.
		if !limiter.Allow(auth.Key("revoke_all", user.ID), revokeAllSessionsRateLimitPerMinute, time.Minute) {
			writeJSON(w, http.StatusTooManyRequests, errorResponse{
				Error: "RATE_LIMITED", Message: "too many sign-out-everywhere requests, try again later",
			})
			return
		}

		n, err := svc.Users.RevokeAllSessions(r.Context(), user.ID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		// The sessions are gone; drop the sockets they authenticated now
		// rather than at the sweep's next tick, so "stops working
		// immediately" holds for a connected device too.
		if n > 0 {
			if d, ok := broadcaster.(SessionDisconnector); ok {
				d.DisconnectRevokedUser(user.ID)
			}
		}
		writeJSON(w, http.StatusOK, revokeAllSessionsResponse{
			SessionsRevoked: n,
			CurrentRevoked:  sess != nil,
		})
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
	svc *service.Services,
	store FileStore,
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

		raw, mimeType, width, height, ok := avatarUploadReadImage(w, file)
		if !ok {
			return
		}

		fileID := uuid.New().String()
		written, saveErr := store.Save(fileID, bytes.NewReader(raw))
		if saveErr != nil {
			writeStorageSaveError(w, saveErr, "avatar upload")
			return
		}

		filename := sanitizeUploadFilename(header.Filename)
		if err := svc.Uploads.Record(r.Context(), service.AttachmentRecord{
			ID:         fileID,
			UploaderID: user.ID,
			Filename:   filename,
			MimeType:   mimeType,
			Size:       written,
			Width:      &width,
			Height:     &height,
		}); err != nil {
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
		// Username is deliberately omitted (left at its zero value): user
		// here is a snapshot AuthMiddleware read at the start of the
		// request, before the multipart parse / image decode / disk write
		// above — all of which take long enough for a concurrent
		// PATCH /users/me rename to land first. Sending that stale value
		// would revert the rename; UpdateProfile treats an empty Username
		// as "leave it alone", the same contract DisplayName/About already
		// have via nil.
		updated, err := svc.Users.UpdateProfile(r.Context(), user.ID, service.ProfilePatch{
			Avatar: &avatarURL,
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

// avatarUploadReadImage is the bytes stage of handleUploadAvatar: read the
// uploaded file under its cap, sniff its type and measure it. It writes its own
// 400 and reports ok=false when the upload is not an acceptable avatar, so the
// caller only has to return. Deliberately not shared with the emoji route: the
// two carry different caps and a different allowed MIME set.
func avatarUploadReadImage(w http.ResponseWriter, file io.Reader) (raw []byte, mimeType string, width, height int, ok bool) {
	// Read one byte past the cap so "exactly at the limit" passes and "one
	// byte over" is caught, without buffering an unbounded body.
	raw, err := io.ReadAll(io.LimitReader(file, maxAvatarFileBytes+1))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error: "BAD_REQUEST", Message: "failed to read uploaded file",
		})
		return nil, "", 0, 0, false
	}
	if int64(len(raw)) > maxAvatarFileBytes {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error:   "BAD_REQUEST",
			Message: fmt.Sprintf("avatar must be at most %d KB", maxAvatarFileBytes>>10),
		})
		return nil, "", 0, 0, false
	}

	// Never trust the client's Content-Type — sniff the bytes.
	mimeType = http.DetectContentType(raw)
	if !allowedAvatarMIME[mimeType] {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error: "BAD_REQUEST", Message: "avatar must be a PNG, JPEG or WebP image",
		})
		return nil, "", 0, 0, false
	}

	width, height, err = imageDimensions(raw, mimeType)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error: "BAD_REQUEST", Message: "could not read image dimensions",
		})
		return nil, "", 0, 0, false
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
		return nil, "", 0, 0, false
	}

	return raw, mimeType, width, height, true
}
