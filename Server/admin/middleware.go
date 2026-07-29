package admin

import (
	"context"
	"errors"
	"net/http"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// ─── Middleware ───────────────────────────────────────────────────────────────

// RequireAdminAuth is the exported form of adminAuthMiddleware. External
// packages (e.g. api/router.go for the plugin admin handler) reuse it so the
// session/permission gate stays in one place.
func RequireAdminAuth(database *db.DB) func(http.Handler) http.Handler {
	return adminAuthMiddleware(database)
}

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
			// Resolve the bearer token: login session first, then API token. An
			// API token whose user carries the ADMINISTRATOR bit authenticates
			// here too, so /admin/api/* works for headless clients.
			user, role, sess, err := auth.ResolveTokenHash(r.Context(), database, hash)
			if err != nil {
				switch {
				case errors.Is(err, auth.ErrTokenExpired):
					writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "session has expired")
				case errors.Is(err, auth.ErrUserNotFound):
					writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "user not found")
				case errors.Is(err, auth.ErrRoleNotFound):
					writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "role not found")
				default:
					// ErrTokenNotFound or a wrapped DB error.
					writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid or expired session")
				}
				return
			}

			// F1: reject effectively-banned users before any further processing,
			// as api.AuthMiddleware does — a ban must revoke admin-panel access
			// immediately, not only once the session expires. Deliberately placed
			// AFTER ResolveTokenHash so it also covers the API-token path this
			// commit introduces; gating only the session branch would let a
			// banned administrator keep working through a bot token.
			if auth.IsEffectivelyBanned(user) {
				writeErr(w, http.StatusForbidden, "FORBIDDEN", "your account has been suspended")
				return
			}

			if !permissions.HasAdmin(role.Permissions) {
				writeErr(w, http.StatusForbidden, "FORBIDDEN", "administrator permission required")
				return
			}

			ctx := context.WithValue(r.Context(), adminUserKey, user)
			ctx = context.WithValue(ctx, adminSessionKey, sess) // nil for API-token principals; consumers guard nil
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

		role, err := database.GetRoleByID(r.Context(), user.RoleID)
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
