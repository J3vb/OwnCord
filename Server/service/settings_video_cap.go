package service

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// VoiceMaxVideoKbpsKey holds the server-wide video upload cap per person in kbit/s, camera and screen share
// together; 0 or a missing row means no cap.
const VoiceMaxVideoKbpsKey = "voice_max_video_kbps"

// Video cap bounds in kbit/s. The floor keeps a capped camera usable; the ceiling is above every client
// preset, so it never raises one.
const (
	VoiceMaxVideoKbpsMin = 300
	VoiceMaxVideoKbpsMax = 50000
)

// normalizeVoiceMaxVideoKbps accepts 0 (no cap) or [VoiceMaxVideoKbpsMin, VoiceMaxVideoKbpsMax], in canonical
// decimal form.
func normalizeVoiceMaxVideoKbps(key, value string) (string, error) {
	kbps, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || kbps < 0 || (kbps != 0 && kbps < VoiceMaxVideoKbpsMin) || kbps > VoiceMaxVideoKbpsMax {
		return "", fmt.Errorf("%s: must be 0 (no limit) or between %d and %d", key, VoiceMaxVideoKbpsMin, VoiceMaxVideoKbpsMax)
	}
	return strconv.Itoa(kbps), nil
}

// VoiceMaxVideoBitrate reads a stored value as bits per second: 0 (no cap) for a blank row or a hand-edited
// one outside the accepted range.
func VoiceMaxVideoBitrate(stored string) int {
	normalized, err := normalizeVoiceMaxVideoKbps(VoiceMaxVideoKbpsKey, stored)
	if err != nil {
		return 0
	}
	kbps, err := strconv.Atoi(normalized)
	if err != nil {
		return 0
	}
	return kbps * 1000
}

// VoiceMaxVideoBitrateFromRead interprets a read of VoiceMaxVideoKbpsKey as bits per second: a missing row is
// no cap; ok is false when the read failed.
func VoiceMaxVideoBitrateFromRead(stored string, err error) (bitrate int, ok bool, readErr error) {
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return 0, true, nil
		}
		return 0, false, fmt.Errorf("read %s: %w", VoiceMaxVideoKbpsKey, err)
	}
	return VoiceMaxVideoBitrate(stored), true, nil
}

// ServerUploadMbpsKey holds the server's own upload speed in Mbit/s as typed by the admin; only the admin
// panel reads it, to estimate how many people can watch one stream. 0 or a missing row means not set.
const ServerUploadMbpsKey = "server_upload_mbps"

// ServerUploadMbpsMax is the largest accepted upload speed in Mbit/s.
const ServerUploadMbpsMax = 100000

// normalizeServerUploadMbps accepts 0 (not set) or 1 to [ServerUploadMbpsMax], in canonical decimal form.
func normalizeServerUploadMbps(key, value string) (string, error) {
	mbps, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || mbps < 0 || mbps > ServerUploadMbpsMax {
		return "", fmt.Errorf("%s: must be 0 (not set) or between 1 and %d", key, ServerUploadMbpsMax)
	}
	return strconv.Itoa(mbps), nil
}
