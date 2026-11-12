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
	// Always present (null = unset) so the settings form can tell "cleared" from "unknown field".
	DisplayName           *string `json:"display_name"`
	About                 *string `json:"about"`
	CustomStatus          *string `json:"custom_status"`
	CustomStatusExpiresAt *string `json:"custom_status_expires_at"`
	// Always present, null when unset, so a client can tell "cleared" from "not sent".
	Banner      *string `json:"banner"`
	BannerColor *string `json:"banner_color"`
	// The caller's own true status, invisible included; nothing to hide from them.
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

// updateProfileRequest is the PATCH /api/v1/users/me body; identity_public_key publishes the client's
// long-term E2EE identity key, omitted leaves it unchanged.
type updateProfileRequest struct {
	Username          string  `json:"username"`
	Avatar            *string `json:"avatar"`
	IdentityPublicKey *string `json:"identity_public_key"`
	// Omitted = unchanged, "" = cleared. UserService length-checks both for non-REST callers; DisplayName is
	// sanitized here before validateDisplayName, making UserService's own sanitize a no-op.
	DisplayName *string `json:"display_name"`
	About       *string `json:"about"`
	// Omitted = unchanged, "" = cleared, otherwise #rgb or #rrggbb. There is deliberately no banner id or URL
	// field: an image can only be set by uploading it to this server.
	BannerColor *string `json:"banner_color"`
}

type ProfileBroadcaster interface {
	BroadcastUserUpdate(u ws.UserUpdate)
}

// MountProfileRoutes registers the authenticated user profile endpoints; trustedProxies is for rate
// limiting. store may be nil, in which case the avatar-upload route is not registered (a route that 500s on
// every call is worse than one that 404s). cfg may be nil in tests, so the same-host avatar guard falls
// back to the request's Host header alone; production passes the config so the guard uses the configured
// hosts.
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

// parseUpdateProfileRequest decodes the PATCH body and applies bound, sanitize, then validate to every
// field, in the order the register path uses. On failure it writes the response and returns ok=false.
func parseUpdateProfileRequest(w http.ResponseWriter, r *http.Request, selfHosts []string, currentUsername string) (updateProfileRequest, bool) {
	var req updateProfileRequest
	if !decodeJSON(w, r, &req) {
		return req, false
	}

	// Bound the raw field before the fixpoint sanitizer, which is quadratic in input length; *4 still admits
	// any legitimate 32-rune UTF-8 username.
	if len(req.Username) > maxLoginUsernameLen*4 {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "username is too long")
		return req, false
	}

	// Use service.SanitizeText, not a bare bluemonday call: its output is HTML-escaped, so an apostrophe
	// would persist as &#39; and login (which never re-escapes) would no longer match. Register canonicalizes
	// the same way.
	req.Username = strings.TrimSpace(service.SanitizeText(req.Username))
	if req.Username == "" {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "username is required")
		return req, false
	}
	// A rename is held to the strict rules; resending the current name gets only the loose check, so an
	// account that predates the strict rules can still edit the rest of its profile.
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

	// Use service.SanitizeText: bare bluemonday escaping would rewrite "&" in a URL to "&amp;" and persist it
	// broken.
	if req.Avatar != nil {
		trimmed := strings.TrimSpace(service.SanitizeText(*req.Avatar))
		if err := validateAvatarURL(trimmed, selfHosts, r.Host); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, err.Error())
			return req, false
		}
		req.Avatar = &trimmed
	}

	// display_name is rendered wherever a username is, so it gets the same scrutiny. Sanitize BEFORE
	// validateDisplayName: validating the raw JSON let an entity-encoded control or bidi character
	// ("&#x202e;") pass as ASCII and become real later in UserService's cleanText.
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

	// Bound the raw colour first; the longest valid value is 7 bytes and the service validates the rest.
	if req.BannerColor != nil && len(*req.BannerColor) > maxBannerColorLen*4 {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "banner_color is too long")
		return req, false
	}

	// Validate before any write so the request is all-or-nothing. A device key belongs to a login session, so
	// an API token may edit the profile but not publish one.
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

// broadcastUserUpdate pushes a profile snapshot to every client. Every profile mutation goes through it:
// user_update replaces the client's copy wholesale, so a half-filled one would drop fields.
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
