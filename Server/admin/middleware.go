package admin

import (
	"context"
	"net/http"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

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
