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
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

// setupSanitizer strips all HTML from user input during setup.
var setupSanitizer = bluemonday.StrictPolicy()

// ownerRoleID is the role ID assigned to the first user (Owner).
const ownerRoleID = 1

// setupStatusResponse is the JSON shape returned by GET /api/setup/status.
type setupStatusResponse struct {
	NeedsSetup bool `json:"needs_setup"`
	// Defaults prefills the setup wizard. Present only while setup is needed
	// and the server was wired with its running config (see SetupOptions).
	Defaults *setupDefaults `json:"defaults,omitempty"`
}

// setupRequest is the JSON body for POST /api/setup.
type setupRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	// Wizard carries the optional first-run configuration. Absent = legacy
	// behaviour: create the owner account only.
	Wizard *setupWizardRequest `json:"wizard,omitempty"`
}

// setupResponse is the JSON shape returned on successful setup.
type setupResponse struct {
	Token      string `json:"token"`
	UserID     int64  `json:"user_id"`
	Username   string `json:"username"`
	InviteCode string `json:"invite_code"`
	// RestartRequired is true when wizard values that are only read at
	// startup differ from the running config; the server restarts itself
	// right after this response is sent.
	RestartRequired bool `json:"restart_required"`
	// RestartURL is where the admin panel will be reachable after the
	// restart (scheme/port may have changed). Empty when no restart happens.
	RestartURL string `json:"restart_url,omitempty"`
	// Warnings lists non-fatal problems (e.g. config.yaml not writable).
	// The account exists whenever this response is returned.
	Warnings []string `json:"warnings,omitempty"`
}

// handleSetupStatus returns whether initial setup is needed (no users exist).
func handleSetupStatus(database *db.DB, opts SetupOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		count, err := database.UserCount(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to check user count")
			return
		}
		resp := setupStatusResponse{NeedsSetup: count == 0}
		// Prefill defaults are only exposed pre-setup: after the first user
		// exists this endpoint reveals nothing about the configuration.
		if resp.NeedsSetup && opts.RunningCfg != nil {
			cfg := opts.RunningCfg
			d := &setupDefaults{
				ServerName:        cfg.Server.Name,
				Motd:              "Welcome!",
				Port:              cfg.Server.Port,
				TLSMode:           cfg.TLS.Mode,
				TLSDomain:         cfg.TLS.Domain,
				UploadMaxSizeMB:   cfg.Upload.MaxSizeMB,
				VoiceQuality:      cfg.Voice.Quality,
				VoiceAutoDownload: cfg.Voice.AutoDownloadLiveKit,
			}
			// The settings table is authoritative for the values the app
			// reads live; fall back to the config/seed values on error.
			if v, err := database.GetSetting(r.Context(), "server_name"); err == nil && v != "" {
				d.ServerName = v
			}
			if v, err := database.GetSetting(r.Context(), "motd"); err == nil {
				d.Motd = v
			}
			if v, err := database.GetSetting(r.Context(), "registration_open"); err == nil {
				d.RegistrationOpen = v == "1" || strings.EqualFold(v, "true")
			}
			resp.Defaults = d
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// handleSetup creates the first owner account and, when the request carries
// a wizard payload, applies the chosen settings (DB + config.yaml) and
// restarts the server if startup-only values changed. It only works when no
// users exist in the database, preventing abuse after initial setup.
func handleSetup(database *db.DB, limiter *auth.RateLimiter, allowedOrigins []string, hub HubBroadcaster, opts SetupOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		req, host, ok := setupPrecheck(w, r, limiter, allowedOrigins)
		if !ok {
			return
		}

		uid, token, inviteCode, ok := setupCreateOwner(w, r, database, req, host)
		if !ok {
			return
		}

		warnings, restartRequired, restartURL := setupApplyWizard(r.Context(), database, req.Wizard, uid, r.Host, opts)

		slog.Info("server setup completed", "owner", req.Username, "user_id", uid, "wizard", req.Wizard != nil, "restart", restartRequired)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, uid, "server_setup", "server", 0,
			"initial setup: owner account created, default channel and invite generated")

		writeJSON(w, http.StatusCreated, setupResponse{
			Token:           token,
			UserID:          uid,
			Username:        req.Username,
			InviteCode:      inviteCode,
			RestartRequired: restartRequired,
			RestartURL:      restartURL,
			Warnings:        warnings,
		})

		if restartRequired {
			setupRestartAfterResponse(hub, opts)
		}
	}
}

// setupPrecheck runs every gate in front of the first-run setup endpoint —
// origin check, rate limit, body decode, credential and wizard validation —
// before any state is created. It writes the error response itself; ok=false
// means the caller must return immediately. The returned host is the
// rate-limit bucket key, reused as the session IP.
func setupPrecheck(w http.ResponseWriter, r *http.Request, limiter *auth.RateLimiter, allowedOrigins []string) (setupRequest, string, bool) {
	var req setupRequest

	// CSRF protection: reject cross-origin requests (BUG-097).
	// A request is accepted when it is same-origin, or when its Origin is
	// explicitly allowlisted. Absent Origin = non-browser client (allow).
	if origin := r.Header.Get("Origin"); origin != "" {
		if !isSameOrigin(origin, r.Host) && !isSetupOriginAllowed(origin, allowedOrigins) {
			writeErr(w, http.StatusForbidden, "FORBIDDEN", "cross-origin setup request blocked")
			return req, "", false
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
		return req, "", false
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return req, "", false
	}

	req.Username = strings.TrimSpace(setupSanitizer.Sanitize(req.Username))
	if req.Username == "" || req.Password == "" {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "username and password are required")
		return req, "", false
	}

	// Validate username format (length, no control/invisible chars).
	if err := auth.ValidateUsername(req.Username); err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return req, "", false
	}

	if err := auth.ValidatePasswordStrength(req.Password); err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return req, "", false
	}

	// Validate the whole wizard payload BEFORE creating the account so a
	// bad value rejects the request instead of leaving a half-configured
	// server behind an already-created owner.
	if req.Wizard != nil {
		if err := validateWizard(req.Wizard); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return req, "", false
		}
	}

	return req, host, true
}

// setupCreateOwner creates the owner account and everything that ships with
// it: the session token, the default channels and the bootstrap invite. It
// writes the error response itself; ok=false means the caller must return
// immediately.
func setupCreateOwner(w http.ResponseWriter, r *http.Request, database *db.DB, req setupRequest, host string) (int64, string, string, bool) {
	// Hash the password.
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to hash password")
		return 0, "", "", false
	}

	// Atomically check no users exist and create the owner (BUG-119).
	// This closes the TOCTOU race between UserCount() and CreateUser().
	uid, err := database.CreateOwnerIfEmpty(r.Context(), req.Username, hash, ownerRoleID)
	if errors.Is(err, db.ErrConflict) {
		writeErr(w, http.StatusForbidden, "FORBIDDEN", "setup has already been completed")
		return 0, "", "", false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create user")
		return 0, "", "", false
	}

	// Issue a session token so the user is immediately logged in.
	token, err := auth.GenerateToken()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to generate session token")
		return 0, "", "", false
	}

	device := r.Header.Get("User-Agent")
	const maxDeviceLen = 512
	if len(device) > maxDeviceLen {
		device = device[:maxDeviceLen]
	}
	if _, err := database.CreateSession(r.Context(), uid, auth.HashToken(token), device, host); err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create session")
		return 0, "", "", false
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
		return 0, "", "", false
	}

	return uid, token, inviteCode, true
}

// setupApplyWizard applies the wizard payload. wr == nil is the legacy
// request shape (create the owner account only) and applies nothing. reqHost
// is the request's Host header, from which the post-restart admin-panel URL
// is derived.
//
// The account exists from here on, so any
// failure downgrades to a warning — never a 5xx that would orphan the
// owner behind an opaque error.
func setupApplyWizard(ctx context.Context, database *db.DB, wr *setupWizardRequest, uid int64, reqHost string, opts SetupOptions) ([]string, bool, string) {
	var warnings []string
	restartRequired := false
	restartURL := ""
	if wr == nil {
		return warnings, restartRequired, restartURL
	}

	if err := applyWizardSettings(ctx, database, wr); err != nil {
		slog.Error("setup wizard: saving settings failed", "error", err)
		warnings = append(warnings,
			"could not save server settings: "+err.Error()+" — adjust them later in the admin panel's Settings page")
	}
	if opts.ConfigPath != "" {
		if err := config.Save(opts.ConfigPath, buildConfigPatch(wr, opts.RunningCfg)); err != nil {
			slog.Error("setup wizard: writing config failed", "path", opts.ConfigPath, "error", err)
			warnings = append(warnings,
				"could not write "+opts.ConfigPath+": "+err.Error()+" — your account was created; edit the file manually to apply these settings")
		} else {
			db.WriteAudit(context.WithoutCancel(ctx), database, uid, "config_write", "server", 0,
				"setup wizard wrote "+opts.ConfigPath+" ("+patchedConfigKeys(wr)+")")
			if opts.RunningCfg != nil && wizardChangesRunningConfig(wr, opts.RunningCfg) {
				restartRequired = true
				restartURL = computeRestartURL(reqHost, wr, opts.RunningCfg)
			}
		}
	}

	return warnings, restartRequired, restartURL
}

// setupRestartAfterResponse hands the setup-wizard restart off to main.go.
//
// Called by handleSetup only after it has written its response, so the
// browser receives the token and the reconnect URL before the process
// goes away. Mirrors handleRestoreBackup / handleApplyUpdate: broadcast,
// then request the restart in a goroutine — main.go drains the server and
// performs the handoff. tryDirectRestartPending loses only to an already
// in-flight update or restore, which will itself restart the process;
// skipping is correct then, since the caller's response is written either
// way.
func setupRestartAfterResponse(hub HubBroadcaster, opts SetupOptions) {
	if !tryDirectRestartPending() {
		slog.Warn("setup restart skipped: another restart-sensitive operation is already in progress")
		return
	}
	if hub != nil {
		hub.BroadcastServerRestart("setup", restartBroadcastDelaySeconds)
	}
	restartFn := opts.Restart
	if restartFn == nil {
		restartFn = requestRestart
	}
	go restartFn("setup_wizard")
}

// restartBroadcastDelaySeconds is the countdown clients are told before the
// setup-wizard restart. There are normally no chat clients connected during
// first-run setup, so this is informational.
const restartBroadcastDelaySeconds = 3

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
