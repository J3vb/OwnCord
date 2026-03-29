package admin

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/microcosm-cc/bluemonday"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// setupLimiter restricts setup attempts to prevent brute-force attacks
// against the initial owner account creation endpoint.
var setupLimiter = auth.NewRateLimiter()

// ResetSetupLimiter resets the setup rate limiter. Exported for tests only.
func ResetSetupLimiter() {
	setupLimiter = auth.NewRateLimiter()
}

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
		count, err := database.UserCount()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to check user count")
			return
		}
		writeJSON(w, http.StatusOK, setupStatusResponse{NeedsSetup: count == 0})
	}
}

// handleSetup creates the first owner account. It only works when no users
// exist in the database, preventing abuse after initial setup.
func handleSetup(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Rate limit: 5 attempts per minute per IP.
		ip := r.RemoteAddr
		setupKey := "setup:" + ip
		if !setupLimiter.Allow(setupKey, 5, time.Minute) {
			writeErr(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many setup attempts, try again later")
			return
		}

		// Gate: only allow when no users exist.
		count, err := database.UserCount()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to check user count")
			return
		}
		if count > 0 {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", "setup has already been completed")
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

		// Create the owner account (role_id=1 is Owner).
		uid, err := database.CreateUser(req.Username, hash, ownerRoleID)
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
		if _, err := database.CreateSession(uid, auth.HashToken(token), device, ip); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create session")
			return
		}

		// Create default channels under canonical categories.
		_, _ = database.CreateChannel("general", "text", "Text Channels", "Welcome to the server!", 0)
		_, _ = database.CreateChannel("General", "voice", "Voice Channels", "", 0)

		// Generate a bootstrap invite code so the owner can invite others.
		inviteCode, err := database.CreateInvite(uid, 0, nil) // unlimited uses, no expiry
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to generate invite code")
			return
		}

		slog.Info("server setup completed", "owner", req.Username, "user_id", uid)
		_ = database.LogAudit(uid, "server_setup", "server", 0,
			"initial setup: owner account created, default channel and invite generated")

		writeJSON(w, http.StatusCreated, setupResponse{
			Token:      token,
			UserID:     uid,
			Username:   req.Username,
			InviteCode: inviteCode,
		})
	}
}
