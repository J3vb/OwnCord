package admin

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Settings Handlers ──────────────────────────────────────────────────────
//
// Thin adapters over service.SettingsService:
// the whitelist, boolean normalization, require_2fa preconditions, atomic
// apply and audit rows all live in the service.

func handleGetSettings(settings *service.SettingsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if settings == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "settings service unavailable")
			return
		}
		all, err := settings.List(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to get settings")
			return
		}
		writeJSON(w, http.StatusOK, all)
	}
}

// configFactsResponse is GET /config: the running configuration the Settings
// page's read-only "running configuration" card shows. They come from the
// configuration the server booted with, not from the settings rows of the
// same name, which only the setup wizard writes and which go stale when
// config.yaml is edited.
//
// Secrets are NEVER emitted as values: the GIF API key and the GitHub token
// cross this boundary only as `*_configured` booleans, so the card can say
// "configured" without handing the value to the admin panel (or, since the
// panel is a browser page, to the browser).
//
// The host path and endpoints (backup_dir, voice_url, tls_domain) are sent
// only to an ADMINISTRATOR or the owner; a MANAGE_SERVER-only caller gets the
// response without them, like the support bundle leaves them out.
type configFactsResponse struct {
	UploadMaxSizeMB int    `json:"upload_max_size_mb"`
	VoiceQuality    string `json:"voice_quality"`
	// config.yaml's upload file-type lists: the Settings page's values until
	// the owner saves the upload_*_extensions rows that replace them.
	UploadBlockedExtensions []string `json:"upload_blocked_extensions"`
	UploadAllowedExtensions []string `json:"upload_allowed_extensions"`

	ServerPort       int     `json:"server_port"`
	MinFreeDiskMB    int     `json:"min_free_disk_mb"`
	MaxWSConnections int     `json:"max_ws_connections"`
	TLSMode          string  `json:"tls_mode"`
	TLSDomain        *string `json:"tls_domain,omitempty"`
	UserQuotaMB      int     `json:"user_quota_mb"`
	BackupDir        *string `json:"backup_dir,omitempty"`
	LoggingLevel     string  `json:"logging_level"`
	VoiceURL         *string `json:"voice_url,omitempty"`
	ReportRetention  int     `json:"moderation_report_retention_days"`
	ActionRetention  int     `json:"moderation_action_retention_days"`
	GIFConfigured    bool    `json:"gif_configured"`
	GitHubConfigured bool    `json:"github_configured"`
}

func handleGetConfigFacts(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cfg == nil {
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeConfigUnavailable, "running configuration unavailable")
			return
		}
		resp := configFactsResponse{
			UploadMaxSizeMB: cfg.Upload.MaxSizeMB,
			VoiceQuality:    cfg.Voice.Quality,

			UploadBlockedExtensions: cfg.Upload.BlockedExtensions,
			UploadAllowedExtensions: cfg.Upload.AllowedExtensions,

			ServerPort:       cfg.Server.Port,
			MinFreeDiskMB:    cfg.Server.MinFreeDiskMB,
			MaxWSConnections: cfg.Server.MaxWSConnections,
			TLSMode:          cfg.TLS.Mode,
			UserQuotaMB:      cfg.Upload.UserQuotaMB,
			LoggingLevel:     runningLogLevel(cfg.Logging.Level),
			ReportRetention:  cfg.Moderation.ReportRetentionDays,
			ActionRetention:  cfg.Moderation.ActionRetentionDays,
			// Booleans only: never the secret itself.
			GIFConfigured:    cfg.GIF.APIKey != "",
			GitHubConfigured: cfg.GitHub.Token != "",
		}
		if role := actorRoleFromContext(r); role != nil &&
			(permissions.HasServerPerm(role.Permissions, permissions.Administrator) || isOwnerFromContext(r)) {
			resp.TLSDomain = &cfg.TLS.Domain
			resp.BackupDir = &cfg.Backup.Dir
			resp.VoiceURL = &cfg.Voice.LiveKitURL
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// runningLogLevel names the level the server runs for a logging.level value:
// the normalized name, or info for a value boot did not recognise. An empty
// value stays empty so the card reads "Not set".
func runningLogLevel(value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	level, _ := config.ParseLevel(value)
	return levelName(level)
}

// uploadPolicyBroadcaster is the hub capability that sends the saved upload
// file-type lists to connected clients; *ws.Hub implements it
// (hub_wiring_test.go pins that).
type uploadPolicyBroadcaster interface {
	BroadcastUploadPolicy()
}

// gameActivityPolicyApplier is the hub capability that makes the hub follow
// the saved game activity switch: it clears every shown game when
// the switch is off and sends game_activity_policy to connected clients.
// *ws.Hub implements it (hub_wiring_test.go pins that).
type gameActivityPolicyApplier interface {
	ApplyGameActivityPolicy(saved bool)
}

func handlePatchSettings(settings *service.SettingsService, retention *service.RetentionService, hub HubBroadcaster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if settings == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "settings service unavailable")
			return
		}
		var updates map[string]string
		if !decodeJSON(w, r, &updates) {
			return
		}

		// The backup policy is owner-only: these keys decide which
		// scheduled copies survive and whether new ones are taken, so a
		// MANAGE_SERVER (or ADMINISTRATOR) non-owner must not reach them even
		// though the rest of the settings page is theirs. Refuse the whole
		// request rather than silently dropping the keys — a partial write
		// would report success for a policy the caller cannot set.
		for key := range updates {
			if service.IsOwnerOnlySettingKey(key) && !isOwnerFromContext(r) {
				writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "owner role required")
				return
			}
		}

		if value, changing := updates["retention_days"]; changing {
			if retention == nil {
				writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "retention service unavailable")
				return
			}
			days, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil || len(updates) != 1 {
				writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "preview and apply retention_days separately from other settings")
				return
			}
			if err := retention.ApplyChange(r.Context(), actorFromContext(r), service.RetentionChange{Scope: "server", Days: &days}, r.Header.Get("X-Retention-Preview")); err != nil {
				writeRetentionErr(w, err)
				return
			}
			handleGetSettings(settings)(w, r)
			return
		}

		all, err := settings.Patch(r.Context(), actorFromContext(r), updates)
		if errors.Is(err, service.ErrBadRequest) {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, err.Error())
			return
		}
		// Turning game activity off must clear the games already shown and
		// tell open clients, not wait for their next connect. It runs before
		// the error check: Patch can fail after its commit (the response read
		// on a cancelled request), and the hub re-reads the stored value
		// itself, so a save that did land still reaches it.
		if value, changing := updates[service.GameActivityEnabledKey]; changing {
			if a, ok := hub.(gameActivityPolicyApplier); ok {
				if stored, read := all[service.GameActivityEnabledKey]; read {
					value = stored
				}
				a.ApplyGameActivityPolicy(service.GameActivityEnabled(value))
			}
		}
		if err != nil {
			slog.ErrorContext(r.Context(), "settings patch failed", "error", err)
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to update settings")
			return
		}
		// Composers check the file-type lists before uploading, from what
		// auth_ok gave them; without this a saved list only reached a client
		// on its next connect.
		_, blocked := updates[service.UploadBlockedExtensionsKey]
		_, allowed := updates[service.UploadAllowedExtensionsKey]
		if blocked || allowed {
			if b, ok := hub.(uploadPolicyBroadcaster); ok {
				b.BroadcastUploadPolicy()
			}
		}
		writeJSON(w, http.StatusOK, all)
	}
}
