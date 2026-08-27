package admin

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// ─── SetupOptions ────────────────────────────────────────────────────────────

// SetupOptions wires the first-run setup wizard to the running server. The
// zero value disables everything beyond legacy owner-account creation, which
// keeps every existing NewAdminAPI/NewHandler call site behaving as before.
type SetupOptions struct {
	// ConfigPath is the config.yaml path the wizard patches. Empty disables
	// config writing entirely.
	ConfigPath string
	// RunningCfg is the configuration the server booted with. It provides the
	// wizard's prefill defaults, the values compared against to decide whether
	// a restart is needed, and the generated LiveKit credentials to persist.
	// Nil disables prefill and restarting.
	RunningCfg *config.Config
	// Restart replaces the process-restart hook (tests). Nil = requestRestart.
	Restart func(reason string)
}

// ─── Wizard payload ──────────────────────────────────────────────────────────

// setupWizardRequest is the optional "wizard" object on POST /api/setup.
// Every field is a pointer: absent means "keep the current/default value".
type setupWizardRequest struct {
	// Stored in the settings table (read live, no restart needed).
	ServerName       *string `json:"server_name"`
	Motd             *string `json:"motd"`
	RegistrationOpen *bool   `json:"registration_open"`

	// Stored in config.yaml (consumed at startup — changes need a restart).
	Port            *int    `json:"port"`
	TLSMode         *string `json:"tls_mode"`
	TLSDomain       *string `json:"tls_domain"`
	UploadMaxSizeMB *int    `json:"upload_max_size_mb"`
	VoiceQuality    *string `json:"voice_quality"`
	// VoiceAutoDownload toggles voice.auto_download_livekit — download and
	// run livekit-server automatically so voice works with zero setup.
	VoiceAutoDownload *bool `json:"voice_auto_download"`
}

// setupDefaults is the prefill data the wizard shows. Exposed only while
// needs_setup is true, and deliberately free of secrets, filesystem paths and
// network ACLs.
type setupDefaults struct {
	ServerName        string `json:"server_name"`
	Motd              string `json:"motd"`
	RegistrationOpen  bool   `json:"registration_open"`
	Port              int    `json:"port"`
	TLSMode           string `json:"tls_mode"`
	TLSDomain         string `json:"tls_domain"`
	UploadMaxSizeMB   int    `json:"upload_max_size_mb"`
	VoiceQuality      string `json:"voice_quality"`
	VoiceAutoDownload bool   `json:"voice_auto_download"`
}

// ─── Validation ──────────────────────────────────────────────────────────────

const (
	maxServerNameLen = 100
	maxMotdLen       = 500
	maxUploadSizeMB  = 10240 // 10 GiB
)

var validTLSModes = map[string]struct{}{
	"self_signed": {}, "acme": {}, "manual": {}, "off": {},
}

var validVoiceQualities = map[string]struct{}{
	"low": {}, "medium": {}, "high": {},
}

// validateWizard checks and normalises the wizard payload in place. It must
// be called BEFORE the owner account is created so a bad payload rejects the
// whole request instead of leaving a half-configured server.
func validateWizard(wr *setupWizardRequest) error {
	if err := wizardValidateIdentity(wr); err != nil {
		return err
	}
	if err := wizardValidateNetwork(wr); err != nil {
		return err
	}
	if err := wizardValidateMedia(wr); err != nil {
		return err
	}
	return nil
}

// wizardValidateIdentity checks and normalises the settings-table fields the
// server reads live: the display name and the message of the day.
//
// It uses the fixpoint sanitizer (service.SanitizeText), not a bare
// bluemonday.StrictPolicy().Sanitize call: bluemonday's bare Sanitize HTML-escapes
// survivors (' -> &#39;, & -> &amp;, " -> &#34;), which would store these
// fields differently from how the admin Settings page's handlePatchSettings
// stores the exact same keys (no sanitizer at all). See setup_handler.go's
// identical treatment of the username field, and service.SanitizeText's doc
// comment.
func wizardValidateIdentity(wr *setupWizardRequest) error {
	if wr.ServerName != nil {
		name := strings.TrimSpace(service.SanitizeText(*wr.ServerName))
		if name == "" {
			return fmt.Errorf("server_name cannot be empty")
		}
		if len(name) > maxServerNameLen {
			return fmt.Errorf("server_name must be at most %d characters", maxServerNameLen)
		}
		*wr.ServerName = name
	}
	if wr.Motd != nil {
		motd := strings.TrimSpace(service.SanitizeText(*wr.Motd))
		if len(motd) > maxMotdLen {
			return fmt.Errorf("motd must be at most %d characters", maxMotdLen)
		}
		*wr.Motd = motd
	}
	return nil
}

// wizardValidateNetwork checks and normalises the listener and TLS fields,
// including the cross-field rule that ACME issuance needs a domain.
func wizardValidateNetwork(wr *setupWizardRequest) error {
	if wr.Port != nil && (*wr.Port < 1 || *wr.Port > 65535) {
		return fmt.Errorf("port must be between 1 and 65535")
	}
	if wr.TLSMode != nil {
		mode := strings.ToLower(strings.TrimSpace(*wr.TLSMode))
		if _, ok := validTLSModes[mode]; !ok {
			return fmt.Errorf("tls_mode must be one of: self_signed, acme, manual, off")
		}
		*wr.TLSMode = mode
	}
	if wr.TLSDomain != nil {
		domain := strings.ToLower(strings.TrimSpace(*wr.TLSDomain))
		if domain != "" {
			if err := validateHostname(domain); err != nil {
				return fmt.Errorf("tls_domain: %w", err)
			}
		}
		*wr.TLSDomain = domain
	}
	if wr.TLSMode != nil && *wr.TLSMode == "acme" &&
		(wr.TLSDomain == nil || *wr.TLSDomain == "") {
		return fmt.Errorf("tls_domain is required when tls_mode is acme")
	}
	return nil
}

// wizardValidateMedia checks and normalises the upload-size cap and the voice
// quality preset.
func wizardValidateMedia(wr *setupWizardRequest) error {
	if wr.UploadMaxSizeMB != nil && (*wr.UploadMaxSizeMB < 1 || *wr.UploadMaxSizeMB > maxUploadSizeMB) {
		return fmt.Errorf("upload_max_size_mb must be between 1 and %d", maxUploadSizeMB)
	}
	if wr.VoiceQuality != nil {
		q := strings.ToLower(strings.TrimSpace(*wr.VoiceQuality))
		if _, ok := validVoiceQualities[q]; !ok {
			return fmt.Errorf("voice_quality must be one of: low, medium, high")
		}
		*wr.VoiceQuality = q
	}
	return nil
}

// validateHostname checks an LDH (letters-digits-hyphen) DNS name suitable
// for ACME issuance: dotted, each label 1-63 chars, no leading/trailing
// hyphen, 253 chars max. Input is expected lowercase.
func validateHostname(h string) error {
	if len(h) > 253 {
		return fmt.Errorf("hostname too long")
	}
	labels := strings.Split(h, ".")
	if len(labels) < 2 {
		return fmt.Errorf("must be a fully qualified domain name (e.g. chat.example.com)")
	}
	for _, label := range labels {
		if label == "" || len(label) > 63 {
			return fmt.Errorf("invalid hostname label")
		}
		if label[0] == '-' || label[len(label)-1] == '-' {
			return fmt.Errorf("hostname labels cannot start or end with a hyphen")
		}
		for _, c := range label {
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
				return fmt.Errorf("hostname contains invalid characters")
			}
		}
	}
	return nil
}

// ─── Applying the wizard ─────────────────────────────────────────────────────

// applyWizardSettings persists the wizard's DB-backed settings atomically.
// server_name, motd and registration_open are read live by the server;
// max_upload_bytes and voice_quality are written so the Settings page shows
// values consistent with what the wizard put in config.yaml.
func applyWizardSettings(ctx context.Context, database *db.DB, wr *setupWizardRequest) error {
	updates := map[string]string{}
	if wr.ServerName != nil {
		updates["server_name"] = *wr.ServerName
	}
	if wr.Motd != nil {
		updates["motd"] = *wr.Motd
	}
	if wr.RegistrationOpen != nil {
		if *wr.RegistrationOpen {
			updates["registration_open"] = "1"
		} else {
			updates["registration_open"] = "0"
		}
	}
	if wr.UploadMaxSizeMB != nil {
		updates["max_upload_bytes"] = strconv.Itoa(*wr.UploadMaxSizeMB * 1024 * 1024)
	}
	if wr.VoiceQuality != nil {
		updates["voice_quality"] = *wr.VoiceQuality
	}
	if len(updates) == 0 {
		return nil
	}

	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("starting transaction: %w", err)
	}
	for key, value := range updates {
		if _, txErr := tx.ExecContext(ctx,
			`INSERT INTO settings (key, value) VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			key, value,
		); txErr != nil {
			_ = tx.Rollback()
			return fmt.Errorf("writing setting %s: %w", key, txErr)
		}
	}
	return tx.Commit()
}

// buildConfigPatch maps the wizard payload onto config.yaml keys. When the
// running config is known, the LiveKit credentials it booted with are included
// so config.Save can persist them if the file has none — stabilising voice
// tokens across restarts (they are otherwise regenerated randomly each boot).
func buildConfigPatch(wr *setupWizardRequest, running *config.Config) config.Patch {
	p := config.Patch{
		ServerPort:        wr.Port,
		ServerName:        wr.ServerName,
		TLSMode:           wr.TLSMode,
		TLSDomain:         wr.TLSDomain,
		UploadMaxSizeMB:   wr.UploadMaxSizeMB,
		VoiceQuality:      wr.VoiceQuality,
		VoiceAutoDownload: wr.VoiceAutoDownload,
	}
	if running != nil {
		if key := running.Voice.LiveKitAPIKey; key != "" {
			p.VoiceAPIKey = &key
		}
		if secret := running.Voice.LiveKitAPISecret; secret != "" {
			p.VoiceAPISecret = &secret
		}
	}
	return p
}

// patchedConfigKeys summarises which config.yaml keys a patch touches, for
// the audit log. Secrets are named, never valued.
func patchedConfigKeys(wr *setupWizardRequest) string {
	var keys []string
	if wr.Port != nil {
		keys = append(keys, "server.port")
	}
	if wr.ServerName != nil {
		keys = append(keys, "server.name")
	}
	if wr.TLSMode != nil {
		keys = append(keys, "tls.mode")
	}
	if wr.TLSDomain != nil {
		keys = append(keys, "tls.domain")
	}
	if wr.UploadMaxSizeMB != nil {
		keys = append(keys, "upload.max_size_mb")
	}
	if wr.VoiceQuality != nil {
		keys = append(keys, "voice.quality")
	}
	if wr.VoiceAutoDownload != nil {
		keys = append(keys, "voice.auto_download_livekit")
	}
	keys = append(keys, "voice credentials (persisted if unset)")
	return strings.Join(keys, ", ")
}

// ─── Restart decision ────────────────────────────────────────────────────────

// wizardChangesRunningConfig reports whether the wizard set any startup-only
// value to something different from what this process booted with. Only those
// changes justify a restart; server.name and the persisted voice credentials
// match the running state by construction.
func wizardChangesRunningConfig(wr *setupWizardRequest, running *config.Config) bool {
	if wr.Port != nil && *wr.Port != running.Server.Port {
		return true
	}
	if wr.TLSMode != nil && *wr.TLSMode != running.TLS.Mode {
		return true
	}
	if wr.UploadMaxSizeMB != nil && *wr.UploadMaxSizeMB != running.Upload.MaxSizeMB {
		return true
	}
	if wr.VoiceQuality != nil && *wr.VoiceQuality != running.Voice.Quality {
		return true
	}
	if wr.VoiceAutoDownload != nil && *wr.VoiceAutoDownload != running.Voice.AutoDownloadLiveKit {
		return true
	}
	// A domain change only matters when certificates come from ACME.
	effMode := running.TLS.Mode
	if wr.TLSMode != nil {
		effMode = *wr.TLSMode
	}
	if effMode == "acme" && wr.TLSDomain != nil && *wr.TLSDomain != running.TLS.Domain {
		return true
	}
	return false
}

// computeRestartURL builds the admin-panel URL the server will be reachable
// at after restarting with the wizard's values. host is the request's Host
// header (the address the user's browser is already using).
func computeRestartURL(host string, wr *setupWizardRequest, running *config.Config) string {
	h := host
	if hh, _, err := net.SplitHostPort(host); err == nil {
		h = hh
	}
	effPort := running.Server.Port
	if wr.Port != nil {
		effPort = *wr.Port
	}
	effMode := running.TLS.Mode
	if wr.TLSMode != nil {
		effMode = *wr.TLSMode
	}
	scheme := "https"
	if effMode == "off" {
		scheme = "http"
	}
	return scheme + "://" + net.JoinHostPort(h, strconv.Itoa(effPort)) + "/admin"
}
