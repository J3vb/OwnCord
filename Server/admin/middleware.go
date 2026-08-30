package admin

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ─── Middleware ───────────────────────────────────────────────────────────────

// RequireAdminAuth is the exported admin gate for surfaces outside this
// package (api/router.go's plugin admin handler). Those routes stay
// ADMINISTRATOR-only, so it chains the perimeter check with an explicit
// ADMINISTRATOR requirement rather than exposing the widened perimeter.
func RequireAdminAuth(database *db.DB) func(http.Handler) http.Handler {
	perimeter := adminAuthMiddleware(database)
	administrator := requirePerm(permissions.Administrator)
	return func(next http.Handler) http.Handler {
		return perimeter(administrator(next))
	}
}

// adminAuthMiddleware validates the Bearer token and requires at least one
// moderation-capable bit (permissions.AdminPerimeter) — not ADMINISTRATOR, so
// a Moderator role can reach the routes its bits allow. Individual route
// groups re-check the specific bit they need via requirePerm.
// On success it stores the *db.User, *db.Role and *db.Session in the request
// context so downstream handlers can retrieve them without re-querying.
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
			// API token inherits its owning user's role, so a token whose user
			// clears the perimeter authenticates here too and /admin/api/*
			// works for headless clients.
			user, role, sess, err := auth.ResolveTokenHash(r.Context(), database, hash)
			if err != nil {
				switch {
				case errors.Is(err, auth.ErrTokenExpired):
					writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "session has expired")
				case errors.Is(err, auth.ErrUserNotFound):
					writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "user not found")
				case errors.Is(err, auth.ErrRoleNotFound):
					writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "role not found")
				case errors.Is(err, auth.ErrTokenNotFound):
					writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid or expired session")
				default:
					// A wrapped DB error, not one of the sentinels above (mirrors
					// api.AuthMiddleware). A DB outage is not a bad token:
					// answering 401 here would make the client treat a live,
					// valid session as expired — the desktop client's doFetch
					// 401 sink clears auth and deletes the stored credential for
					// a session that was never revoked. Log it and report the
					// failure as a server-side fault instead.
					slog.ErrorContext(r.Context(), "admin: token resolution failed", "error", err)
					writeErr(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "authentication service temporarily unavailable")
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

			if !permissions.HasAnyPerm(role.Permissions, permissions.AdminPerimeter) {
				writeErr(w, http.StatusForbidden, "FORBIDDEN", "moderation permission required")
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

// requirePerm gates a route group on a single server-wide permission bit.
// ADMINISTRATOR bypasses via permissions.HasServerPerm. The role comes from
// the request context (set by adminAuthMiddleware), so no extra query runs.
func requirePerm(perm int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			role, ok := r.Context().Value(adminRoleKey).(*db.Role)
			if !ok || role == nil {
				writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "not authenticated")
				return
			}
			if !permissions.HasServerPerm(role.Permissions, perm) {
				writeErr(w, http.StatusForbidden, "FORBIDDEN",
					permissions.Name(perm)+" permission required")
				return
			}
			next.ServeHTTP(w, r)
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
		if err != nil {
			// A read fault is an outage, not a missing role: answering 403
			// would tell the Owner they lack the Owner role. Mirror the
			// perimeter's contract above — log it, report 503 (OC-0345).
			slog.ErrorContext(r.Context(), "admin: owner role lookup failed", "error", err)
			writeErr(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "authorization service temporarily unavailable")
			return
		}
		if role == nil {
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
