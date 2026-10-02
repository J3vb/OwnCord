package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// Limits on the settings the first-run wizard and the admin settings PATCH
// both write. One copy, so the two entry points cannot drift apart.
const (
	// MaxServerNameLen and MaxMotdLen bound the trimmed value in bytes, as the
	// wizard always has.
	MaxServerNameLen = 100
	MaxMotdLen       = 500
	// MaxUploadSizeMB is the largest upload cap either surface accepts
	// (10 GiB); the smallest is 1 MB.
	MaxUploadSizeMB = 10240
)

// voiceQualityPresets are the presets the voice code maps to a bitrate
// (ws.voiceQualities); ws pins the two lists equal in a test.
var voiceQualityPresets = []string{"low", "medium", "high"}

// VoiceQualityPresets returns the accepted voice_quality values.
func VoiceQualityPresets() []string { return slices.Clone(voiceQualityPresets) }

// NormalizeServerName trims a server name and requires 1 to MaxServerNameLen
// bytes.
func NormalizeServerName(v string) (string, error) {
	name := strings.TrimSpace(v)
	if name == "" {
		return "", errors.New("server_name cannot be empty")
	}
	if len(name) > MaxServerNameLen {
		return "", fmt.Errorf("server_name must be at most %d characters", MaxServerNameLen)
	}
	return name, nil
}

// NormalizeMotd trims a message of the day and bounds it to MaxMotdLen bytes.
// Empty is allowed: it clears the message.
func NormalizeMotd(v string) (string, error) {
	motd := strings.TrimSpace(v)
	if len(motd) > MaxMotdLen {
		return "", fmt.Errorf("motd must be at most %d characters", MaxMotdLen)
	}
	return motd, nil
}

// NormalizeVoiceQuality lower-cases and trims a voice quality preset and
// requires one the voice code accepts.
func NormalizeVoiceQuality(v string) (string, error) {
	q := strings.ToLower(strings.TrimSpace(v))
	if !slices.Contains(voiceQualityPresets, q) {
		return "", fmt.Errorf("voice_quality must be one of: %s", strings.Join(voiceQualityPresets, ", "))
	}
	return q, nil
}

// normalizeMaxUploadBytes requires a whole number of bytes from 1 MB to
// MaxUploadSizeMB and returns it in canonical decimal form.
func normalizeMaxUploadBytes(v string) (string, error) {
	const minBytes, maxBytes = int64(1) << 20, int64(MaxUploadSizeMB) << 20
	n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
	if err != nil || n < minBytes || n > maxBytes {
		return "", fmt.Errorf("max_upload_bytes must be a whole number of bytes from %d (1 MB) to %d (%d MB)", minBytes, maxBytes, MaxUploadSizeMB)
	}
	return strconv.FormatInt(n, 10), nil
}

// normalizeValueSetting validates the four settings whose limits the wizard
// shares, reporting ok=false for any other key.
func normalizeValueSetting(key, value string) (normalized string, ok bool, err error) {
	switch key {
	case "server_name":
		normalized, err = NormalizeServerName(value)
	case "motd":
		normalized, err = NormalizeMotd(value)
	case "voice_quality":
		normalized, err = NormalizeVoiceQuality(value)
	case "max_upload_bytes":
		normalized, err = normalizeMaxUploadBytes(value)
	default:
		return "", false, nil
	}
	return normalized, true, err
}

func getBooleanSetting(ctx context.Context, st Store, key string, defaultValue bool) (bool, error) {
	value, err := st.GetSetting(ctx, key)
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return defaultValue, nil
		}
		return false, err
	}
	return parseBooleanSettingValue(value)
}

func parseBooleanSettingValue(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true":
		return true, nil
	case "0", "false":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean setting value %q", value)
	}
}
