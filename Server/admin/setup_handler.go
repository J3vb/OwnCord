package admin

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/microcosm-cc/bluemonday"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// setupSanitizer strips all HTML from user input during setup.
var setupSanitizer = bluemonday.StrictPolicy()

// ownerRoleID is the role ID assigned to the first user (Owner).
const ownerRoleID = 1

// setupStatusResponse is the JSON shape returned by GET /api/setup/status.
type setupStatusResponse struct {
	NeedsSetup bool `json:"needs_setup"`
}

// setupRequest is the JSON body for POST /api/setup.
type setupRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// setupResponse is the JSON shape returned on successful setup.
type setupResponse struct {
	Token      string `json:"token"`
	UserID     int64  `json:"user_id"`
	Username   string `json:"username"`
	InviteCode string `json:"invite_code"`
}

// handleSetupStatus returns whether initial setup is needed (no users exist).
func handleSetupStatus(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		count, err := database.UserCount(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to check user count")
			return
		}
		writeJSON(w, http.StatusOK, setupStatusResponse{NeedsSetup: count == 0})
	}
}

// handleSetup creates the first owner account. It only works when no users
// exist in the database, preventing abuse after initial setup.
func handleSetup(database *db.DB, limiter *auth.RateLimiter, allowedOrigins []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// CSRF protection: reject cross-origin requests (BUG-097).
		// A request is accepted when it is same-origin, or when its Origin is
		// explicitly allowlisted. Absent Origin = non-browser client (allow).
		if origin := r.Header.Get("Origin"); origin != "" {
			if !isSameOrigin(origin, r.Host) && !isSetupOriginAllowed(origin, allowedOrigins) {
				writeErr(w, http.StatusForbidden, "FORBIDDEN", "cross-origin setup request blocked")
				return
			}
		}

		// Rate limit: 5 attempts per minute per IP.
		// Strip the port so that different source ports from the same IP
		// are correctly grouped under a single rate-limit bucket.
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		setupKey := "setup:" + host
		if !limiter.Allow(setupKey, 5, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many setup attempts, try again later")
			return
		}

		var req setupRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}

		req.Username = strings.TrimSpace(setupSanitizer.Sanitize(req.Username))
		if req.Username == "" || req.Password == "" {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "username and password are required")
			return
		}

		// Validate username format (length, no control/invisible chars).
		if err := auth.ValidateUsername(req.Username); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}

		if err := auth.ValidatePasswordStrength(req.Password); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}

		// Hash the password.
		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to hash password")
			return
		}

		// Atomically check no users exist and create the owner (BUG-119).
		// This closes the TOCTOU race between UserCount() and CreateUser().
		uid, err := database.CreateOwnerIfEmpty(r.Context(), req.Username, hash, ownerRoleID)
		if errors.Is(err, db.ErrConflict) {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", "setup has already been completed")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create user")
			return
		}

		// Issue a session token so the user is immediately logged in.
		token, err := auth.GenerateToken()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to generate session token")
			return
		}

		device := r.Header.Get("User-Agent")
		const maxDeviceLen = 512
		if len(device) > maxDeviceLen {
			device = device[:maxDeviceLen]
		}
		if _, err := database.CreateSession(r.Context(), uid, auth.HashToken(token), device, host); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create session")
			return
		}

		// Create default channels under canonical categories.
		_, _ = database.CreateChannel(r.Context(), "general", "text", "Text Channels", "Welcome to the server!", 0)
		_, _ = database.CreateChannel(r.Context(), "General", "voice", "Voice Channels", "", 0)

		// Generate a bootstrap invite code so the owner can invite others.
		// Bound it (5 uses / 24h) rather than minting an unlimited, non-expiring
		// invite — the owner can create fresh invites once logged in.
		bootstrapInviteExpiry := time.Now().Add(24 * time.Hour)
		inviteCode, err := database.CreateInvite(r.Context(), uid, 5, &bootstrapInviteExpiry)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to generate invite code")
			return
		}

		slog.Info("server setup completed", "owner", req.Username, "user_id", uid)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, uid, "server_setup", "server", 0,
			"initial setup: owner account created, default channel and invite generated")

		writeJSON(w, http.StatusCreated, setupResponse{
			Token:      token,
			UserID:     uid,
			Username:   req.Username,
			InviteCode: inviteCode,
		})
	}
}

// isSameOrigin reports whether a browser-supplied Origin names this same
// server, by comparing its host:port against the request's Host header.
//
// Browsers send Origin on same-origin POSTs too (Chrome and Edge always,
// Firefox since 70), so the admin panel's own first-run setup call arrives
// carrying one. Without this check it is measured against allowed_origins,
// which is empty in a freshly generated config — so setup failed with
// "cross-origin setup request blocked" on every new install.
//
// Scheme is deliberately not compared. Nothing in this server derives the
// external scheme (there is no r.TLS or X-Forwarded-Proto handling anywhere),
// so a TLS-terminating proxy in front would make a scheme check reject
// legitimate requests. Matching host:port is enough: forging it requires
// already serving content on this exact host and port, at which point the
// origin is not the attacker's to borrow. Cross-site attackers cannot set
// Origin at all — the browser does.
func isSameOrigin(origin, host string) bool {
	if host == "" {
		return false
	}
	u, err := url.Parse(origin)
	// Require a scheme so a schemeless "//host:port" cannot pass as same-origin.
	if err != nil || u.Scheme == "" || u.Host == "" {
		return false
	}
	return strings.EqualFold(u.Host, host)
}

// isSetupOriginAllowed checks if the given origin is permitted by the
// configured allowed_origins list. Wildcard "*" allows any origin.
// An empty list denies all cross-origin requests (safe default).
func isSetupOriginAllowed(origin string, allowed []string) bool {
	for _, a := range allowed {
		if a == "*" || strings.EqualFold(a, origin) {
			return true
		}
	}
	return false
}
