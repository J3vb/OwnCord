package admin

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/clientip"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/J3vb/OwnCord/Server/ws"
)

type setupStatusResponse struct {
	NeedsSetup bool `json:"needs_setup"`
	// Defaults prefills the wizard; present only while setup is needed and the server has its running config.
	Defaults *setupDefaults `json:"defaults,omitempty"`
}

type setupRequest struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	SetupToken string `json:"setup_token"`
	// Wizard is optional; absent means create the owner account only.
	Wizard *setupWizardRequest `json:"wizard,omitempty"`
}

type setupResponse struct {
	Token      string `json:"token"`
	UserID     int64  `json:"user_id"`
	Username   string `json:"username"`
	InviteCode string `json:"invite_code"`
	// RestartRequired: startup-only wizard values differ from the running config; the server restarts itself
	// right after this response.
	RestartRequired bool `json:"restart_required"`
	// RestartURL is where the panel will be reachable after the restart; empty when none happens.
	RestartURL string `json:"restart_url,omitempty"`
	// Warnings lists non-fatal problems; the account exists whenever this response is returned.
	Warnings []string `json:"warnings,omitempty"`
	// CertificateFingerprint is the served leaf certificate's SHA-256 in the client's pin format, for
	// out-of-band comparison. Omitted when none is known (TLS off, ACME before its first handshake) or the
	// wizard changed tls.mode, since the restart serves a different certificate.
	CertificateFingerprint string `json:"certificate_fingerprint,omitempty"`
	// RecoveryKitSecret is the owner's recovery kit, shown once on the finish step; the server stores only its
	// verifier. Absent if the wizard turned it off or it could not be issued.
	RecoveryKitSecret string `json:"recovery_kit_secret,omitempty"`
}

func handleSetupStatus(setup *service.SetupService, settings *service.SettingsService, opts SetupOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		needsSetup, err := setup.NeedsSetup(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to check user count")
			return
		}
		resp := setupStatusResponse{NeedsSetup: needsSetup}
		// Defaults are exposed only pre-setup: afterwards this endpoint reveals nothing about the configuration.
		if resp.NeedsSetup && opts.RunningCfg != nil {
			cfg := opts.RunningCfg
			d := &setupDefaults{
				ServerName:        cfg.Server.Name,
				Motd:              "Welcome!",
				RegistrationMode:  string(service.DefaultRegistrationMode),
				Port:              cfg.Server.Port,
				TLSMode:           cfg.TLS.Mode,
				TLSDomain:         cfg.TLS.Domain,
				UploadMaxSizeMB:   cfg.Upload.MaxSizeMB,
				VoiceQuality:      cfg.Voice.Quality,
				VoiceAutoDownload: cfg.Voice.AutoDownloadLiveKit,
				PortLocked:        updater.RunningInContainer(),
			}
			// The settings table is authoritative for live values; fall back to config/seed values on error. A nil
			// SettingsService is such a fallback, not a panic: adminRequiredServices deliberately does not build it.
			if settings != nil {
				setupStatusSettingDefaults(r, settings, d)
			}
			resp.Defaults = d
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// setupStatusSettingDefaults overlays live settings rows onto the config defaults. Each read is best-effort:
// the config value stays on failure, since the status call must not fail.
func setupStatusSettingDefaults(r *http.Request, settings *service.SettingsService, d *setupDefaults) {
	if v, err := settings.Setting(r.Context(), "server_name"); err == nil && v != "" {
		d.ServerName = v
	}
	if v, err := settings.Setting(r.Context(), "motd"); err == nil {
		d.Motd = v
	}
	if v, err := settings.Setting(r.Context(), "registration_mode"); err == nil {
		if mode, ok := service.ParseRegistrationMode(v); ok {
			d.RegistrationMode = string(mode)
		}
	}
}

// handleSetup creates the first owner account and, with a wizard payload, applies the settings and restarts
// if startup-only values changed. It only works when no users exist.
func handleSetup(setup *service.SetupService, limiter *auth.RateLimiter, allowedOrigins []string, hub HubBroadcaster, opts SetupOptions) http.HandlerFunc {
	// Resolve trusted-proxy CIDRs once; a nil RunningCfg (legacy/test) yields none, so clientip.Resolve uses the
	// raw RemoteAddr.
	var trustedProxies []string
	if opts.RunningCfg != nil {
		trustedProxies = opts.RunningCfg.Server.TrustedProxies
	}
	proxyNets := setupParseCIDRList(trustedProxies)

	return func(w http.ResponseWriter, r *http.Request) {
		req, host, ok := setupPrecheck(w, r, limiter, allowedOrigins, proxyNets, opts.SetupToken, opts.RunningCfg)
		if !ok {
			return
		}

		boot, err := setup.Bootstrap(r.Context(), service.BootstrapInput{
			Username:    req.Username,
			Password:    req.Password,
			Device:      r.Header.Get("User-Agent"),
			Host:        host,
			RecoveryKit: req.Wizard == nil || req.Wizard.RecoveryKit == nil || *req.Wizard.RecoveryKit,
		})
		switch {
		case errors.Is(err, service.ErrSetupAlreadyDone):
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "setup has already been completed")
			return
		case errors.Is(err, service.ErrAuthBusy):
			var hinted interface{ RetryAfter() time.Duration }
			if errors.As(err, &hinted) {
				secs := int((hinted.RetryAfter() + time.Second - 1) / time.Second)
				w.Header().Set("Retry-After", strconv.Itoa(max(secs, 1)))
			}
			writeErr(w, http.StatusTooManyRequests, httperr.CodeAuthBusy, service.ErrAuthBusy.Error())
			return
		case err != nil:
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to create user")
			return
		}
		uid, token, inviteCode := boot.OwnerID, boot.Token, boot.InviteCode

		warnings, restartRequired, restartURL := setupApplyWizard(r.Context(), setup, req.Wizard, uid, r.Host, opts)
		if req.Wizard != nil {
			// After the wizard's settings write, so the owner's first sign-in shows the chosen server name and
			// motd rather than the hub's cached defaults.
			expireHubSettingsCache(hub)
		}
		warnings = append(boot.Warnings, warnings...)

		slog.Info("server setup completed", "owner", req.Username, "user_id", uid, "wizard", req.Wizard != nil, "restart", restartRequired)
		detail := "initial setup: owner account created, default channel and invite generated"
		if keys := wizardSettingKeys(req.Wizard); len(keys) > 0 {
			detail += "; settings applied: " + strings.Join(keys, ", ")
		}
		setup.RecordSetup(r.Context(), uid, detail)

		fingerprint := servedCert().Fingerprint
		if req.Wizard != nil && req.Wizard.TLSMode != nil &&
			(opts.RunningCfg == nil || *req.Wizard.TLSMode != opts.RunningCfg.TLS.Mode) {
			fingerprint = ""
		}

		writeJSON(w, http.StatusCreated, setupResponse{
			Token:                  token,
			UserID:                 uid,
			Username:               req.Username,
			InviteCode:             inviteCode,
			RestartRequired:        restartRequired,
			RestartURL:             restartURL,
			Warnings:               warnings,
			CertificateFingerprint: fingerprint,
			RecoveryKitSecret:      boot.RecoveryKitSecret,
		})

		if restartRequired {
			setupRestartAfterResponse(hub, opts)
		}
	}
}

// setupPrecheck runs every gate (origin, rate limit, body decode, credential and wizard validation) before
// any state is created. It writes the error response itself; ok=false means return immediately. host is the
// resolved client address, used as session IP and rate-limit bucket; proxyNets makes both honour
// trusted_proxies like every other session-creating path instead of trusting the raw, possibly-proxy
// RemoteAddr.
func setupPrecheck(w http.ResponseWriter, r *http.Request, limiter *auth.RateLimiter, allowedOrigins []string, proxyNets []*net.IPNet, setupToken string, running *config.Config) (setupRequest, string, bool) {
	var req setupRequest

	// CSRF: reject cross-origin requests unless same-origin or Origin is allowlisted; absent Origin is a
	// non-browser client.
	if origin := r.Header.Get("Origin"); origin != "" {
		if !isSameOrigin(origin, r.Host) && !isSetupOriginAllowed(origin, allowedOrigins) {
			writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "cross-origin setup request blocked")
			return req, "", false
		}
	}

	// Rate limit: 5 attempts per minute per IP, resolved through proxyNets so one client's ports and hops share
	// a bucket and distinct clients behind a trusted proxy are not collapsed.
	host := clientip.Resolve(r, proxyNets)
	setupKey := "setup:" + clientip.RateKey(host)
	if !limiter.Allow(setupKey, 5, time.Minute) {
		writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, "too many setup attempts, try again later")
		return req, "", false
	}

	if !decodeJSON(w, r, &req) {
		return req, "", false
	}

	// After the rate limit so guesses are bounded like any other setup attempt, and before any other field is
	// looked at.
	if setupToken != "" && subtle.ConstantTimeCompare([]byte(req.SetupToken), []byte(setupToken)) != 1 {
		writeErr(w, http.StatusForbidden, httperr.CodeForbidden,
			"setup token missing or incorrect — copy it from the server's start-up output")
		return req, "", false
	}

	// Use service.SanitizeText, not a bare bluemonday StrictPolicy: that HTML-escapes survivors (' -> &#39;), so
	// "O'Brien" would differ from what handleLogin looks up (which only trims) and permanently lock the Owner
	// out. Registration and profile rename canonicalize the same way.
	req.Username = strings.TrimSpace(service.SanitizeText(req.Username))
	if req.Username == "" || req.Password == "" {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "username and password are required")
		return req, "", false
	}

	if err := auth.ValidateNewUsername(req.Username); err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, err.Error())
		return req, "", false
	}

	if err := auth.ValidatePasswordStrength(req.Password); err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, err.Error())
		return req, "", false
	}

	// Validate the whole wizard payload BEFORE creating the account so a bad value cannot leave a
	// half-configured server.
	if req.Wizard != nil {
		if err := validateWizard(req.Wizard); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, err.Error())
			return req, "", false
		}
		// A container's published port mapping fixes the port, so a different one would leave the server
		// unreachable; refused here so no account is created.
		if err := wizardPortRefusal(req.Wizard, running); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, err.Error())
			return req, "", false
		}
		// A TLS choice the next boot cannot serve is refused the same way.
		if err := wizardTLSRefusal(req.Wizard, running); err != nil {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, err.Error())
			return req, "", false
		}
	}

	return req, host, true
}

// setupApplyWizard applies the wizard payload; wr == nil (legacy) applies nothing. The account exists from
// here on, so any failure downgrades to a warning, never a 5xx that would orphan the owner.
func setupApplyWizard(ctx context.Context, setup *service.SetupService, wr *setupWizardRequest, uid int64, reqHost string, opts SetupOptions) ([]string, bool, string) {
	var warnings []string
	restartRequired := false
	restartURL := ""
	if wr == nil {
		return warnings, restartRequired, restartURL
	}

	if err := setup.ApplyWizardSettings(ctx, wizardSettingUpdates(wr)); err != nil {
		slog.Error("setup wizard: saving settings failed", "error", err)
		warnings = append(warnings,
			"could not save server settings: "+err.Error()+" — adjust them later in the admin panel's Settings page")
	}
	if opts.ConfigPath != "" && opts.RunningCfg != nil && updater.RunningInContainer() {
		// config.yaml is read-only (or in the container layer), so settings go to the overrides file in the data
		// volume.
		restartRequired, restartURL = setupSaveContainerOverrides(ctx, setup, wr, uid, reqHost, opts, &warnings)
		return warnings, restartRequired, restartURL
	}
	if opts.ConfigPath != "" {
		if err := config.Save(opts.ConfigPath, buildConfigPatch(wr, opts.RunningCfg)); err != nil {
			slog.Error("setup wizard: writing config failed", "path", opts.ConfigPath, "error", err)
			warnings = append(warnings,
				"could not write "+opts.ConfigPath+": "+err.Error()+" — your account was created; edit the file manually to apply these settings")
		} else {
			setup.RecordConfigWrite(ctx, uid,
				"setup wizard wrote "+opts.ConfigPath+" ("+patchedConfigKeys(wr)+")")
			if opts.RunningCfg != nil && wizardChangesRunningConfig(wr, opts.RunningCfg) {
				restartRequired = true
				restartURL = computeRestartURL(reqHost, wr, opts.RunningCfg)
			}
		}
	}

	return warnings, restartRequired, restartURL
}

// setupSaveContainerOverrides persists startup settings via config-overrides.json in the data volume. The
// merge is checked with config.Preview first so a change that would stop the next boot is refused. Failure
// appends a warning and requests no restart. Neither values nor secrets are logged.
func setupSaveContainerOverrides(ctx context.Context, setup *service.SetupService, wr *setupWizardRequest, uid int64, reqHost string, opts SetupOptions, warnings *[]string) (bool, string) {
	path := config.OverridesPath(opts.RunningCfg.Server.DataDir)
	fail := func(err error) (bool, string) {
		slog.Error("setup wizard: writing config failed", "path", path, "error", err)
		*warnings = append(*warnings,
			"could not save "+config.OverridesFileName+": "+err.Error()+" — your account was created; adjust these settings later in the admin panel's Settings page")
		return false, ""
	}
	base, err := config.Preview(opts.ConfigPath, path, nil)
	if err != nil {
		return fail(err)
	}
	changes, pinned := wizardOverrides(wr, opts.RunningCfg, base)
	if len(pinned) > 0 {
		*warnings = append(*warnings,
			"not saved because an environment variable sets them: "+strings.Join(pinned, ", ")+" — change the environment to change these")
	}
	if len(changes) == 0 {
		return false, ""
	}
	if _, err := config.Preview(opts.ConfigPath, path, changes); err != nil {
		return fail(err)
	}
	if err := config.SaveOverrides(path, changes); err != nil {
		return fail(err)
	}
	setup.RecordConfigWrite(ctx, uid,
		"setup wizard wrote "+config.OverridesFileName+" ("+strings.Join(overrideKeyNames(changes), ", ")+")")
	if wizardOverridesNeedRestart(changes) {
		return true, computeContainerRestartURL(reqHost, wr, opts.RunningCfg)
	}
	return false, ""
}

// setupRestartAfterResponse hands the restart off to main.go. Called only after the response is written so
// the browser gets the token and reconnect URL first. tryDirectRestartPending loses only to an in-flight
// update or restore, which restarts the process itself, so skipping is correct then.
func setupRestartAfterResponse(hub HubBroadcaster, opts SetupOptions) {
	if !tryDirectRestartPending() {
		slog.Warn("setup restart skipped: another restart-sensitive operation is already in progress")
		return
	}
	if hub != nil {
		hub.BroadcastServerRestart(ws.RestartReasonSetup, restartBroadcastDelaySeconds)
	}
	restartFn := opts.Restart
	if restartFn == nil {
		restartFn = requestRestart
	}
	go restartFn("setup_wizard")
}

// restartBroadcastDelaySeconds is the countdown clients are told; informational, as no chat clients are
// normally connected at first run.
const restartBroadcastDelaySeconds = 3

// isSameOrigin reports whether Origin names this server by comparing host:port with the request's Host.
// Browsers send Origin on same-origin POSTs too (Chrome and Edge always, Firefox since 70), so measuring
// against the empty allowed_origins would fail every new install.
//
// Scheme is deliberately not compared: nothing here derives the external scheme, so a TLS-terminating proxy
// would make a scheme check reject legitimate requests. Host:port suffices: forging it needs a page already
// served from that host and port, and cross-site attackers cannot set Origin.
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

// isSetupOriginAllowed checks origin against allowed_origins; "*" allows any, an empty list denies all
// cross-origin (safe default).
func isSetupOriginAllowed(origin string, allowed []string) bool {
	for _, a := range allowed {
		if a == "*" || strings.EqualFold(a, origin) {
			return true
		}
	}
	return false
}
