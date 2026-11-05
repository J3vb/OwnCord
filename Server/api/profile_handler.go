package api

import (
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

type ProfileBroadcaster interface {
	BroadcastUserUpdate(u ws.UserUpdate)
}

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

		r.With(requireLoginSession, RateLimitMiddleware(limiter, "pw:", profilePasswordRateLimitPerMinute, time.Minute, trustedProxies)).
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

		r.With(requireLoginSession).Get("/sessions", handleListSessions(svc))

		r.With(RateLimitMiddleware(limiter, "own_moderation:", ownModerationRateLimitPerMinute, time.Minute, trustedProxies)).
			Get("/moderation", handleOwnModeration(svc))
		r.With(requireLoginSession).Delete("/sessions", handleRevokeAllSessions(svc, limiter, broadcaster))
		r.With(requireLoginSession).Delete("/sessions/{id}", handleRevokeSession(svc, broadcaster))

		if svc.Tokens != nil {
			r.With(requireLoginSession).Get("/api-tokens", handleListOwnAPITokens(svc.Tokens))
			r.With(requireLoginSession).Delete("/api-tokens/{id}", handleRevokeOwnAPIToken(svc.Tokens))
		}
	})
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
	// all-or-nothing. A device key belongs to a login session, so an API token
	// may edit the profile but not publish one.
	if req.IdentityPublicKey != nil {
		if p, _ := principal(r); p.Session == nil {
			writeLoginSessionRequired(w)
			return req, false
		}
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
			IdentityKey: req.IdentityPublicKey,
		})
		if err != nil {
			writeServiceError(r.Context(), w, err)
			return
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
