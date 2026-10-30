package api

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type userResponse struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar,omitempty"`
	// DisplayName and About are always present (null = unset) so the settings
	// form can tell "cleared" from "the server does not know this field".
	DisplayName  *string `json:"display_name"`
	About        *string `json:"about"`
	CustomStatus *string `json:"custom_status"`
	// CustomStatusExpiresAt: RFC 3339 instant the status clears; null if none.
	CustomStatusExpiresAt *string `json:"custom_status_expires_at"`
	// Banner (the /api/v1/files/<id> path) and BannerColor are always present,
	// null when unset, so a client can tell "cleared" from "not sent".
	Banner      *string `json:"banner"`
	BannerColor *string `json:"banner_color"`
	// Status is the user's own true status, invisible included. This response
	// only ever describes the caller, so there is nothing to hide from them.
	Status      string `json:"status"`
	RoleID      int64  `json:"role_id"`
	TOTPEnabled bool   `json:"totp_enabled"`
	CreatedAt   string `json:"created_at"`
}

func toUserResponse(u *db.User) *userResponse {
	avatar := ""
	if u.Avatar != nil {
		avatar = *u.Avatar
	}
	customStatus, expiresAt := u.CustomStatus, u.CustomStatusExpiresAt
	if expiresAt != nil {
		if at, err := time.Parse(dbtime.ISOLayout, *expiresAt); err == nil && !time.Now().Before(at) {
			customStatus = nil // expired, not yet cleared by the expirer
		}
	}
	if customStatus == nil {
		expiresAt = nil
	}
	return &userResponse{
		ID:                    u.ID,
		Username:              u.Username,
		Avatar:                avatar,
		DisplayName:           u.DisplayName,
		About:                 u.About,
		CustomStatus:          customStatus,
		CustomStatusExpiresAt: expiresAt,
		Banner:                u.BannerPath(),
		BannerColor:           u.BannerColor,
		Status:                u.Status,
		RoleID:                u.RoleID,
		TOTPEnabled:           u.TOTPSecret != nil,
		CreatedAt:             u.CreatedAt,
	}
}

// updateProfileRequest is the JSON body for PATCH /api/v1/users/me.
// identity_public_key, when present, publishes the client's long-term E2EE
// identity public key; omitted leaves it unchanged.
type updateProfileRequest struct {
	Username          string  `json:"username"`
	Avatar            *string `json:"avatar"`
	IdentityPublicKey *string `json:"identity_public_key"`
	// DisplayName and About: omitted = unchanged, "" = cleared. Both are
	// length-checked in UserService (the path a non-REST caller takes);
	// DisplayName is also sanitized in this handler before validateDisplayName
	// runs, so UserService's own sanitize is then a no-op.
	DisplayName *string `json:"display_name"`
	About       *string `json:"about"`
	// BannerColor is omitted = unchanged, "" = cleared, otherwise #rgb or
	// #rrggbb (validated in UserService). There is deliberately no banner id or
	// URL field: an image can only be set by uploading it to this server.
	BannerColor *string `json:"banner_color"`
}

type changePasswordRequest struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
}

type sessionResponse struct {
	ID        int64  `json:"id"`
	Device    string `json:"device"`
	IP        string `json:"ip"`
	CreatedAt string `json:"created_at"`
	LastUsed  string `json:"last_used"`
	IsCurrent bool   `json:"is_current"`
	// Unseen is the new-login signal: true from the login that created
	// the session until the account lists its sessions from another device.
	// This listing acknowledges every row but the caller's own.
	Unseen bool `json:"unseen"`
}

type sessionsListResponse struct {
	Sessions []sessionResponse `json:"sessions"`
}

type ProfileBroadcaster interface {
	BroadcastUserUpdate(u ws.UserUpdate)
}

// revokeAllSessionsRateLimitPerMinute bounds DELETE /api/v1/users/me/sessions
// per account. Every call revokes the caller's own session or API token, so the
// cap bounds how fast a fresh sign-in can repeat it.
const revokeAllSessionsRateLimitPerMinute = 5

// MountProfileRoutes registers the authenticated user profile endpoints;
// trustedProxies is used for rate limiting.
// store may be nil, in which case the avatar-upload route is not registered:
// with no storage backend a route that 500s on every call is worse than one that
// 404s.
// cfg may be nil (tests mounting only the profile surface), in which case the
// same-host avatar guard falls back to the request's Host header alone.
// Production always passes the running config, so the guard compares against the
// server's configured hosts, not anything the client supplied.
func MountProfileRoutes(r chi.Router, svc *service.Services, store FileStore, limiter *auth.RateLimiter, trustedProxies []string, broadcaster ProfileBroadcaster, cfg *config.Config) {
	selfHosts := configuredSelfHosts(cfg)
	r.Route("/api/v1/users/me", func(r chi.Router) {
		r.Use(AuthMiddleware(svc.Sessions))

		r.With(RateLimitMiddleware(limiter, "profile:", profileUpdateRateLimitPerMinute, time.Minute, trustedProxies)).
			Patch("/", handleUpdateProfile(svc, broadcaster, selfHosts))

		r.With(RateLimitMiddleware(limiter, "pw:", profilePasswordRateLimitPerMinute, time.Minute, trustedProxies)).
			Put("/password", handleChangePassword(svc, limiter, broadcaster))

		r.With(RateLimitMiddleware(limiter, "profile:", profileUpdateRateLimitPerMinute, time.Minute, trustedProxies)).
			Delete("/avatar", handleDeleteAvatar(svc, broadcaster))

		r.With(RateLimitMiddleware(limiter, "profile:", profileUpdateRateLimitPerMinute, time.Minute, trustedProxies)).
			Delete("/banner", handleDeleteBanner(svc, broadcaster))

		if store != nil {
			r.With(MaxBodySize(avatarMaxBodySize)).
				Post("/avatar", handleUploadAvatar(svc, store, limiter, broadcaster))
			r.With(MaxBodySize(bannerMaxBodySize)).
				Post("/banner", handleUploadBanner(svc, store, limiter, broadcaster))
		}

		if svc.UserNotes != nil {
			r.Get("/notes/{userId}", handleGetUserNote(svc.UserNotes))
			r.With(RateLimitMiddleware(limiter, "user_note:", userNoteRateLimitPerMinute, time.Minute, trustedProxies)).
				Put("/notes/{userId}", handlePutUserNote(svc.UserNotes))
		}

		if svc.Privacy != nil {
			r.Get("/privacy", handleGetPrivacy(svc.Privacy))
			r.With(RateLimitMiddleware(limiter, "profile:", profileUpdateRateLimitPerMinute, time.Minute, trustedProxies)).
				Put("/privacy", handlePutPrivacy(svc.Privacy, broadcaster))
		}

		r.Get("/sessions", handleListSessions(svc))

		r.With(RateLimitMiddleware(limiter, "own_moderation:", ownModerationRateLimitPerMinute, time.Minute, trustedProxies)).
			Get("/moderation", handleOwnModeration(svc))
		r.Delete("/sessions", handleRevokeAllSessions(svc, limiter, broadcaster))
		r.Delete("/sessions/{id}", handleRevokeSession(svc, broadcaster))
	})
}

// allowedAvatarMIME is the set of still image types an avatar, banner or group
// icon may be, matched against the type sniffed from the file's own bytes. GIF
// is added per surface (imageLimits.AllowGIF), where the client freezes it to
// its first frame until hovered. SVG is absent, as for emoji: it is markup with
// script and external-fetch capability, and an avatar is rendered inline.
var allowedAvatarMIME = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,
}

// parseUpdateProfileRequest decodes the PATCH /users/me body and applies
// bound-then-sanitize-then-validate to every field, in the order the register
// path canonicalizes them. On failure it writes the error response and returns
// ok=false, and the caller must write nothing further.
func parseUpdateProfileRequest(w http.ResponseWriter, r *http.Request, selfHosts []string, currentUsername string) (updateProfileRequest, bool) {
	var req updateProfileRequest
	if !decodeJSON(w, r, &req) {
		return req, false
	}

	// Bound the raw field before the fixpoint sanitizer, as on the register path
	// (auth_handler.go's registerReadRequest): sanitizeToFixpoint is quadratic
	// in input length. This is a cheap byte-length pre-check; *4 still admits
	// any legitimate 32-rune UTF-8 username.
	if len(req.Username) > maxLoginUsernameLen*4 {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "username is too long")
		return req, false
	}

	// Use the fixpoint sanitizer (service.SanitizeText), not a bare
	// bluemonday.StrictPolicy().Sanitize: its output is always HTML-escaped, so
	// an apostrophe would be persisted as &#39; and login (which never
	// re-escapes) would look the account up under a name that no longer matches.
	// The register path canonicalizes the same way.
	req.Username = strings.TrimSpace(service.SanitizeText(req.Username))
	if req.Username == "" {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "username is required")
		return req, false
	}
	// A rename is held to the strict rules; resending the account's current name
	// (e.g. a display-name edit that carries it along) gets only the loose
	// check, so an account that predates the strict rules can still edit the
	// rest of its profile.
	validateName := auth.ValidateNewUsername
	if req.Username == currentUsername {
		validateName = auth.ValidateUsername
	}
	if err := validateName(req.Username); err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
		return req, false
	}

	if req.Avatar != nil && len(*req.Avatar) > maxAvatarURLLen*4 {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "avatar URL is too long")
		return req, false
	}

	// Use the fixpoint sanitizer (service.SanitizeText), not a bare bluemonday
	// call: its output is HTML-escaped, so a URL with several query parameters
	// would have its "&" rewritten to "&amp;" and be persisted broken.
	if req.Avatar != nil {
		trimmed := strings.TrimSpace(service.SanitizeText(*req.Avatar))
		if err := validateAvatarURL(trimmed, selfHosts, r.Host); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
			return req, false
		}
		req.Avatar = &trimmed
	}

	// display_name gets the same scrutiny as a username beyond length, since it
	// is rendered wherever a username is (control characters, bidi overrides).
	// Sanitize BEFORE validateDisplayName: validating the raw JSON let an
	// HTML-entity-encoded control or bidi character (e.g. "&#x202e;") pass as
	// ASCII and become the real character later in UserService.UpdateProfile's
	// cleanText. The raw-byte bound applies too; UserService still bounds
	// DisplayName/About for non-REST callers, and cleanText's fixpoint output is
	// stable, so its re-sanitize is a no-op.
	if req.DisplayName != nil {
		if len(*req.DisplayName) > service.MaxDisplayNameLen*4 {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "display_name is too long")
			return req, false
		}
		trimmed := auth.CollapseSpaces(strings.TrimSpace(service.SanitizeText(*req.DisplayName)))
		if err := validateDisplayName(trimmed); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
			return req, false
		}
		req.DisplayName = &trimmed
	}

	// Bound the raw colour first; the longest valid value is 7 bytes and the
	// service does the real validation.
	if req.BannerColor != nil && len(*req.BannerColor) > maxBannerColorLen*4 {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "banner_color is too long")
		return req, false
	}

	// Validate the identity key before any write so the request is
	// all-or-nothing.
	if req.IdentityPublicKey != nil {
		trimmed := strings.TrimSpace(*req.IdentityPublicKey)
		if err := service.ValidateIdentityKey(trimmed); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
			return req, false
		}
		req.IdentityPublicKey = &trimmed
	}
	return req, true
}

func handleUpdateProfile(svc *service.Services, broadcaster ProfileBroadcaster, selfHosts []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		req, ok := parseUpdateProfileRequest(w, r, selfHosts, user.Username)
		if !ok {
			return
		}

		updated, err := svc.Users.UpdateProfile(r.Context(), user.ID, service.ProfilePatch{
			Username:    req.Username,
			Avatar:      req.Avatar,
			DisplayName: req.DisplayName,
			About:       req.About,
			BannerColor: req.BannerColor,
		})
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}

		if req.IdentityPublicKey != nil {
			// Captured separately rather than reassigned into updated: on
			// failure updated still holds the committed profile snapshot, which
			// can still be broadcast.
			withKey, keyErr := svc.Users.UpdateIdentityKey(r.Context(), user.ID, *req.IdentityPublicKey)
			if keyErr != nil {
				// The username/avatar/display_name/about write already
				// committed; only the identity key failed. Broadcasting the
				// committed half keeps other clients in sync even though this
				// request reports failure.
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

// broadcastUserUpdate pushes a profile snapshot to every connected client. Every
// profile mutation goes through it so a new one cannot ship half the fields:
// user_update replaces the client's copy wholesale.
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
		Banner:            u.BannerPath(),
		BannerColor:       u.BannerColor,
	})
}

func handleChangePassword(svc *service.Services, limiter *auth.RateLimiter, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		// Per-user lockout against password brute-force via a stolen session.
		lockKey := auth.Key("pw_confirm_lock", user.ID)
		if limiter.IsLockedOut(lockKey) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many failed attempts, try again later")
			return
		}

		var req changePasswordRequest
		if !decodeJSON(w, r, &req) {
			return
		}

		if req.OldPassword == "" || req.NewPassword == "" {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "old_password and new_password are required")
			return
		}

		// Verify the old password (constant-time bcrypt) inside the one
		// admission slot every password route takes: a refused attempt ran no
		// compare and counts as no failure.
		failKey := auth.Key("pw_confirm_fail", user.ID)
		matched, admitted := limiter.Admission().CheckPassword(user.PasswordHash, req.OldPassword)
		if !admitted {
			writeAuthBusy(w, service.ErrAuthBusy)
			return
		}
		if !matched {
			if !limiter.Allow(failKey, service.PwConfirmFailureThreshold, service.PwConfirmFailureWindow) {
				limiter.Lockout(r.Context(), lockKey, service.PwConfirmLockoutDuration)
			}
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "incorrect password")
			return
		}
		limiter.Reset(r.Context(), failKey)

		if req.OldPassword == req.NewPassword {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "new password must be different from old password")
			return
		}

		if err := auth.ValidatePasswordStrength(req.NewPassword); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
			return
		}

		hash, admitted, err := limiter.Admission().HashPassword(req.NewPassword)
		if !admitted {
			writeAuthBusy(w, service.ErrAuthBusy)
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to process password change")
			return
		}

		sess, _ := r.Context().Value(SessionKey).(*db.Session)
		keepSessionID := int64(0)
		if sess != nil {
			keepSessionID = sess.ID
		}

		res, err := svc.Users.ChangePassword(r.Context(), user.ID, hash, keepSessionID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		// Drop the account's socket now if it rode one of the revoked sessions,
		// rather than at the next sweep.
		if res.SessionsRevoked > 0 {
			disconnectIfSessionRevoked(broadcaster, user.ID)
		}
		if res.RevokeFailed {
			// Partial success: the password IS changed; only revoking the other
			// sessions failed, and a 5xx would tell the user to retry with a
			// password that no longer works.
			writeJSON(w, http.StatusOK, map[string]any{
				"warning":          "password changed, but other sessions could not be revoked; revoke them from the sessions list",
				"sessions_revoked": res.SessionsRevoked,
			})
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func handleListSessions(svc *service.Services) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		// An API-token principal has a nil session (middleware.go); the list
		// still works, with no row marked current.
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
				Unseen:    s.Unseen,
			})
		}

		// This listing is the acknowledgement of the response's flags, except
		// for the caller's own session. An API-token principal has no session
		// and acknowledges every row.
		var callerSessionID int64
		if sess != nil {
			callerSessionID = sess.ID
		}
		if err := svc.Users.MarkSessionsSeen(r.Context(), user.ID, callerSessionID); err != nil {
			// A failed "seen" write must not discard a successfully built list:
			// return it and log the write failure rather than 500.
			slog.WarnContext(r.Context(), "list sessions: failed to mark seen", "err", err)
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

func handleRevokeSession(svc *service.Services, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
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
		disconnectIfSessionRevoked(broadcaster, user.ID)

		w.WriteHeader(http.StatusNoContent)
	}
}

// revokeAllSessionsResponse carries the count and an explicit note that the
// caller's own session was among them, so the client re-authenticates rather
// than treating the next 401 as an error.
type revokeAllSessionsResponse struct {
	SessionsRevoked int64 `json:"sessions_revoked"`
	CurrentRevoked  bool  `json:"current_session_revoked"`
}

// handleRevokeAllSessions is sign-out-everywhere: the current session, every API
// token and every live WebSocket of the account are revoked.
func handleRevokeAllSessions(svc *service.Services, limiter *auth.RateLimiter, broadcaster ProfileBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}
		sess, _ := r.Context().Value(SessionKey).(*db.Session)

		if !limiter.Allow(auth.Key("revoke_all", user.ID), revokeAllSessionsRateLimitPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many sign-out-everywhere requests, try again later")
			return
		}

		n, err := svc.Users.RevokeAllSessions(r.Context(), user.ID)
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
		}
		// Drop the sockets now rather than at the next sweep, so "stops working
		// immediately" holds for a connected device.
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
// The bytes land in the attachments table with no channel and the avatar column
// points at /api/v1/files/{id}. An unlinked attachment is private to its
// uploader and handleServeFile also admits one some user's avatar points at, so
// an avatar is readable exactly while in use. PATCH /users/me still takes an
// https:// URL; both end at the same column.
func handleUploadAvatar(
	svc *service.Services,
	store FileStore,
	limiter *auth.RateLimiter,
	broadcaster ProfileBroadcaster,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := requireUser(w, r)
		if !ok {
			return
		}

		if limiter != nil && !limiter.Allow(auth.Key("avatar_upload", user.ID), avatarUploadRateLimitPerMinute, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "avatar upload rate limit exceeded, try again later")
			return
		}

		// Bound the body before the multipart parser: the route has MaxBodySize
		// too, but the parser is what turns an unbounded body into heap.
		r.Body = http.MaxBytesReader(w, r.Body, avatarMaxBodySize)
		if err := r.ParseMultipartForm(avatarMultipartMemoryLimit); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid multipart form")
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "missing file field")
			return
		}
		defer file.Close() //nolint:errcheck

		raw, mimeType, width, height, ok := readProfileImage(w, file, avatarImageLimits)
		if !ok {
			return
		}

		filename := sanitizeUploadFilename(header.Filename)
		fileID, written, ok := avatarStoreAndRecord(r.Context(), w, svc, store, user.ID, filename, raw, mimeType, "avatar", width, height)
		if !ok {
			return
		}

		avatarURL := service.AvatarFileURL(fileID)
		// Username is deliberately omitted: user is a snapshot AuthMiddleware
		// read before the multipart parse, image decode and disk write, long
		// enough for a concurrent PATCH /users/me rename to land first, and
		// sending the stale value would revert it. UpdateProfile treats an empty
		// Username as "leave it alone", like nil DisplayName/About.
		updated, err := svc.Users.UpdateProfile(r.Context(), user.ID, service.ProfilePatch{
			Avatar: &avatarURL,
		})
		if err != nil {
			// The column never moved, so the file and its row are orphans; drop
			// the row now so its charge does not wait for the sweep.
			if unErr := svc.Uploads.Unrecord(context.WithoutCancel(r.Context()), fileID, user.ID); unErr != nil {
				slog.Error("failed to remove orphaned avatar row", "stored_as", fileID, "error", unErr)
			}
			if delErr := store.Delete(fileID); delErr != nil {
				slog.Error("failed to clean up orphaned avatar file", "stored_as", fileID, "error", delErr)
			}
			writeServiceError(r.Context(), w, err)
			return
		}

		// The previous avatar's bytes stay on disk on purpose: a message
		// rendered with it may still be cached client-side, and a delete here
		// would race in-flight requests. Reclaiming them is an operator-side
		// sweep.
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

// avatarStoreAndRecord is the store-and-row stage of handleUploadAvatar: admit
// the bytes (an avatar counts against its uploader's quota), write them, and
// record the row that commits the charge. It writes its own error response and
// reports ok=false.
func avatarStoreAndRecord(ctx context.Context, w http.ResponseWriter, svc *service.Services, store FileStore, userID int64, filename string, raw []byte, mimeType, label string, width, height int) (string, int64, bool) {
	res, err := svc.Uploads.Reserve(ctx, userID, int64(len(raw)))
	if err != nil {
		writeStorageSaveError(w, err, label+" upload")
		return "", 0, false
	}
	defer res.Settle(ctx)

	fileID := uuid.New().String()
	written, saveErr := saveReserved(ctx, res, store, fileID, bytes.NewReader(raw))
	if saveErr != nil {
		writeStorageSaveError(w, saveErr, label+" upload")
		return "", 0, false
	}

	if err := svc.Uploads.Record(ctx, service.AttachmentRecord{
		ID:         fileID,
		UploaderID: userID,
		Filename:   filename,
		MimeType:   mimeType,
		Size:       written,
		Width:      &width,
		Height:     &height,
	}, res); err != nil {
		if delErr := store.Delete(fileID); delErr != nil {
			slog.Error("failed to clean up orphaned avatar file", "stored_as", fileID, "error", delErr)
		}
		slog.Error("failed to create avatar attachment record", "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to save "+label)
		return "", 0, false
	}
	return fileID, written, true
}
