package admin

import (
	"errors"
	"fmt"
	"net"
	"slices"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/updater"
)

// setupWizardRequest is the optional "wizard" object on POST /api/setup.
// Every field is a pointer: absent means "keep the current/default value".
type setupWizardRequest struct {
	// Stored in the settings table (read live, no restart needed).
	ServerName *string `json:"server_name"`
	Motd       *string `json:"motd"`
	// RegistrationMode is closed / invite / approval / open; the
	// wizard defaults to invite.
	RegistrationMode *string `json:"registration_mode"`

	// Stored in config.yaml (consumed at startup — changes need a restart).
	Port            *int    `json:"port"`
	TLSMode         *string `json:"tls_mode"`
	TLSDomain       *string `json:"tls_domain"`
	UploadMaxSizeMB *int    `json:"upload_max_size_mb"`
	VoiceQuality    *string `json:"voice_quality"`
	// VoiceAutoDownload toggles voice.auto_download_livekit — download and
	// run livekit-server automatically so voice works with zero setup.
	VoiceAutoDownload *bool `json:"voice_auto_download"`
	// RecoveryKit asks the server to generate the owner's recovery kit as
	// part of the first run. On unless explicitly false — an absent
	// field or wizard object still gets one. The kit secret is returned once
	// on the finish step; only its verifier is stored.
	RecoveryKit *bool `json:"recovery_kit"`
}

// setupDefaults is the prefill data the wizard shows. Exposed only while
// needs_setup is true, and deliberately free of secrets, filesystem paths and
// network ACLs.
type setupDefaults struct {
	ServerName        string `json:"server_name"`
	Motd              string `json:"motd"`
	RegistrationMode  string `json:"registration_mode"`
	Port              int    `json:"port"`
	TLSMode           string `json:"tls_mode"`
	TLSDomain         string `json:"tls_domain"`
	UploadMaxSizeMB   int    `json:"upload_max_size_mb"`
	VoiceQuality      string `json:"voice_quality"`
	VoiceAutoDownload bool   `json:"voice_auto_download"`
	// PortLocked is true when the wizard cannot change the port: in a
	// container the published port mapping fixes it, so the wizard renders
	// the port read-only and the server refuses a different one.
	PortLocked bool `json:"port_locked,omitempty"`
}

// errWizardPortLocked is the refusal for a wizard port change in a container.
// It mirrors guardPort's wording for the same change from the panel.
var errWizardPortLocked = errors.New("port cannot be changed from the setup wizard in a container; the published port mapping fixes it")

// wizardPortRefusal reports a wizard port that differs from the running one
// while the server runs in a container. A nil running config (the
// direct-construction test path) has nothing to compare against.
func wizardPortRefusal(wr *setupWizardRequest, running *config.Config) error {
	if wr == nil || wr.Port == nil || running == nil || !updater.RunningInContainer() {
		return nil
	}
	if *wr.Port != running.Server.Port {
		return errWizardPortLocked
	}
	return nil
}

var validTLSModes = map[string]struct{}{
	"self_signed": {}, "acme": {}, "manual": {}, "off": {},
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
// bluemonday.StrictPolicy().Sanitize, which HTML-escapes survivors (' ->
// &#39;) and would store these fields differently from the admin Settings
// page's handlePatchSettings (no sanitizer at all). See setup_handler.go's
// treatment of the username field.
func wizardValidateIdentity(wr *setupWizardRequest) error {
	if wr.RegistrationMode != nil {
		mode, ok := service.ParseRegistrationMode(*wr.RegistrationMode)
		if !ok {
			return fmt.Errorf("registration_mode must be one of closed, invite, approval, open")
		}
		*wr.RegistrationMode = string(mode)
	}
	// The limits are the settings PATCH's too (service.NormalizeServerName,
	// service.NormalizeMotd); only the sanitizer is the wizard's own.
	if wr.ServerName != nil {
		name, err := service.NormalizeServerName(service.SanitizeText(*wr.ServerName))
		if err != nil {
			return err
		}
		*wr.ServerName = name
	}
	if wr.Motd != nil {
		motd, err := service.NormalizeMotd(service.SanitizeText(*wr.Motd))
		if err != nil {
			return err
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
	if wr.UploadMaxSizeMB != nil && (*wr.UploadMaxSizeMB < 1 || *wr.UploadMaxSizeMB > service.MaxUploadSizeMB) {
		return fmt.Errorf("upload_max_size_mb must be between 1 and %d", service.MaxUploadSizeMB)
	}
	if wr.VoiceQuality != nil {
		q, err := service.NormalizeVoiceQuality(*wr.VoiceQuality)
		if err != nil {
			return err
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

// wizardSettingUpdates maps the wizard payload onto the settings rows it
// writes. server_name, motd and registration_mode are read live by the server;
// max_upload_bytes and voice_quality are written so the Settings page matches
// what the wizard put in config.yaml. This is the mapping only;
// SetupService.ApplyWizardSettings commits it in one transaction, so a partial
// write cannot leave the Settings page showing values the wizard never applied.
func wizardSettingUpdates(wr *setupWizardRequest) map[string]string {
	updates := map[string]string{}
	if wr.ServerName != nil {
		updates["server_name"] = *wr.ServerName
	}
	if wr.Motd != nil {
		updates["motd"] = *wr.Motd
	}
	if wr.RegistrationMode != nil {
		updates["registration_mode"] = *wr.RegistrationMode
	}
	if wr.UploadMaxSizeMB != nil {
		updates["max_upload_bytes"] = strconv.Itoa(*wr.UploadMaxSizeMB * 1024 * 1024)
	}
	if wr.VoiceQuality != nil {
		updates["voice_quality"] = *wr.VoiceQuality
	}
	return updates
}

// wizardSettingKeys returns the sorted keys wizardSettingUpdates would write,
// for the server_setup audit row — naming which settings the wizard applied,
// never their values.
func wizardSettingKeys(wr *setupWizardRequest) []string {
	if wr == nil {
		return nil
	}
	updates := wizardSettingUpdates(wr)
	keys := make([]string, 0, len(updates))
	for k := range updates {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
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

// wizardOverrides maps the wizard payload onto config-overrides.json keys, for
// a container where config.yaml is a read-only mount. Only a value that differs
// from running is included, so config.yaml stays authoritative for everything
// the owner did not change, and a key an OWNCORD_* variable pins is never
// written (it would lose at the next boot). server.name is not included: the
// settings table owns it. The generated LiveKit credentials are included only
// when base (the configuration with no credential generation) has neither
// half, which is Patch's rule at config/save.go re-expressed. Values are never
// logged.
//
// The second result names the keys the wizard chose a new value for but an
// environment variable pins, so the caller can say they were not saved.
func wizardOverrides(wr *setupWizardRequest, running, base *config.Config) (map[string]any, []string) {
	changes := map[string]any{}
	var pinned []string
	set := func(key string, value any, differs bool) {
		if !differs {
			return
		}
		if config.EnvOverridden(key) {
			if key != keyLiveKitAPIKey && key != keyLiveKitAPISecret {
				pinned = append(pinned, key)
			}
			return
		}
		changes[key] = value
	}
	if wr.Port != nil {
		set("server.port", *wr.Port, *wr.Port != running.Server.Port)
	}
	if wr.TLSMode != nil {
		set("tls.mode", *wr.TLSMode, *wr.TLSMode != running.TLS.Mode)
	}
	effMode := running.TLS.Mode
	if wr.TLSMode != nil {
		effMode = *wr.TLSMode
	}
	if effMode == "acme" && wr.TLSDomain != nil {
		set("tls.domain", *wr.TLSDomain, *wr.TLSDomain != running.TLS.Domain)
	}
	if wr.UploadMaxSizeMB != nil {
		set("upload.max_size_mb", *wr.UploadMaxSizeMB, *wr.UploadMaxSizeMB != running.Upload.MaxSizeMB)
	}
	if wr.VoiceQuality != nil {
		set("voice.quality", *wr.VoiceQuality, *wr.VoiceQuality != running.Voice.Quality)
	}
	if wr.VoiceAutoDownload != nil {
		set("voice.auto_download_livekit", *wr.VoiceAutoDownload, *wr.VoiceAutoDownload != running.Voice.AutoDownloadLiveKit)
	}
	// The credentials are a pair: generated ones are persisted only when no
	// layer below supplies either half, so a key from the environment is never
	// joined to a generated secret.
	if base != nil && base.Voice.LiveKitAPIKey == "" && base.Voice.LiveKitAPISecret == "" {
		set(keyLiveKitAPIKey, running.Voice.LiveKitAPIKey, running.Voice.LiveKitAPIKey != "")
		set(keyLiveKitAPISecret, running.Voice.LiveKitAPISecret, running.Voice.LiveKitAPISecret != "")
	}
	slices.Sort(pinned)
	return changes, pinned
}

const (
	keyLiveKitAPIKey    = "voice.livekit_api_key"
	keyLiveKitAPISecret = "voice.livekit_api_secret"
)

// overrideKeyNames lists the keys of an overrides change set, sorted, for the
// audit row. Names only, never values.
func overrideKeyNames(changes map[string]any) []string {
	keys := make([]string, 0, len(changes))
	for k := range changes {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// wizardOverridesNeedRestart reports whether the change set carries a
// startup-only setting the running process has not applied. The persisted
// LiveKit credentials match the running state by construction.
func wizardOverridesNeedRestart(changes map[string]any) bool {
	for k := range changes {
		if k != keyLiveKitAPIKey && k != keyLiveKitAPISecret {
			return true
		}
	}
	return false
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

// computeContainerRestartURL is computeRestartURL for a container: the browser
// reaches the server through a published port that need not equal the
// in-container server.port, so the request's host:port is kept and only the
// scheme follows the wizard's TLS mode.
func computeContainerRestartURL(host string, wr *setupWizardRequest, running *config.Config) string {
	effMode := running.TLS.Mode
	if wr.TLSMode != nil {
		effMode = *wr.TLSMode
	}
	scheme := "https"
	if effMode == "off" {
		scheme = "http"
	}
	return scheme + "://" + host + "/admin"
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
