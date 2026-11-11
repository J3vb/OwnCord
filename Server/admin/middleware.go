package admin

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// RequireAdminAuth is the admin gate for surfaces outside this package (api/router.go's plugin admin
// handler). Those stay ADMINISTRATOR-only, so it chains the perimeter check with an explicit ADMINISTRATOR
// requirement rather than expose the widened perimeter.
func RequireAdminAuth(sessions *service.SessionService) func(http.Handler) http.Handler {
	perimeter := adminAuthMiddleware(sessions)
	administrator := requirePerm(permissions.Administrator)
	return func(next http.Handler) http.Handler {
		return perimeter(administrator(next))
	}
}

// adminAuthMiddleware validates the Bearer token and requires one moderation-capable bit
// (permissions.AdminPerimeter), not ADMINISTRATOR, so a Moderator can reach the routes its bits allow; route
// groups re-check their bit via requirePerm. It stores *db.User, *db.Role and *db.Session in the context so
// handlers need no re-query.
func adminAuthMiddleware(sessions *service.SessionService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := auth.ExtractBearerToken(r)
			if !ok {
				writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "missing or invalid authorization header")
				return
			}

			hash := auth.HashToken(token)
			// Resolve the bearer: login session first, then API token. A token inherits its owning user's role, so a
			// token whose user clears the perimeter works for headless clients.
			user, role, sess, err := sessions.ResolveBearer(r.Context(), hash)
			if err != nil {
				switch {
				case errors.Is(err, auth.ErrTokenExpired):
					writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "session has expired")
				case errors.Is(err, auth.ErrUserNotFound):
					writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "user not found")
				case errors.Is(err, auth.ErrRoleNotFound):
					writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "role not found")
				case errors.Is(err, auth.ErrTokenNotFound):
					writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "invalid or expired session")
				default:
					// A wrapped DB error, not a sentinel (mirrors api.AuthMiddleware). A DB outage is not a bad token: a 401
					// would make the desktop client's doFetch sink clear auth and delete the stored credential for a session
					// never revoked. Log it and report a server-side fault.
					slog.ErrorContext(r.Context(), "admin: token resolution failed", "error", err)
					writeErr(w, http.StatusServiceUnavailable, httperr.CodeServiceUnavailable, "authentication service temporarily unavailable")
				}
				return
			}

			// Reject effectively-banned users, as api.AuthMiddleware does: a ban must revoke panel access at once, not
			// at session expiry. Placed AFTER ResolveTokenHash so it covers the API-token path too; gating only the
			// session branch would let a banned administrator keep working through a bot token.
			if auth.IsEffectivelyBanned(user) {
				writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "your account has been suspended")
				return
			}

			if !permissions.HasAnyPerm(role.Permissions, permissions.AdminPerimeter) {
				writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "moderation permission required")
				return
			}

			ctx := context.WithValue(r.Context(), adminUserKey, user)
			ctx = context.WithValue(ctx, adminRoleKey, role)
			ctx = context.WithValue(ctx, adminSessionKey, sess) // nil for API-token principals; consumers guard nil
			ctx = context.WithValue(ctx, adminTokenHashKey, hash)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// requirePerm gates a route group on one server-wide permission bit (ADMINISTRATOR bypasses via
// permissions.HasServerPerm). The role comes from the request context, so no extra query runs.
func requirePerm(perm int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			role, ok := r.Context().Value(adminRoleKey).(*db.Role)
			if !ok || role == nil {
				writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "not authenticated")
				return
			}
			if !permissions.HasServerPerm(role.Permissions, perm) {
				writeErr(w, http.StatusForbidden, httperr.CodeForbidden,
					permissions.Name(perm)+" permission required")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ownerOnlyMiddleware requires the Owner role (permissions.IsOwner), consuming the *db.Role
// adminAuthMiddleware stored: no second role read and no read-fault mapping here, so a role read fault
// surfaces once, at the perimeter, as its 503 (a test pins this). A request without the context role fails
// closed as unauthenticated.
func ownerOnlyMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		role, ok := r.Context().Value(adminRoleKey).(*db.Role)
		if !ok || role == nil {
			writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "not authenticated")
			return
		}

		if !permissions.IsOwner(role.ID, role.Position) {
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "owner role required")
			return
		}

		next.ServeHTTP(w, r)
	})
}

// gateMiddleware gates next on g using the context role, so no extra query runs; a request without one fails
// closed as unauthenticated, like requirePerm and ownerOnlyMiddleware.
func gateMiddleware(g routeGate, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		role, ok := r.Context().Value(adminRoleKey).(*db.Role)
		if !ok || role == nil {
			writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "not authenticated")
			return
		}
		if !g.allow(role.Permissions, role.ID, role.Position) {
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, g.msg)
			return
		}
		next.ServeHTTP(w, r)
	})
}
