package ws

import (
	"time"
)

// Voice rate limit settings.
const (
	voiceMuteRateLimit        = 2
	voiceMuteWindow           = time.Second
	voiceDeafenRateLimit      = 2
	voiceDeafenWindow         = time.Second
	voiceCameraRateLimit      = 2
	voiceCameraWindow         = time.Second
	voiceScreenshareRateLimit = 2
	voiceScreenshareWindow    = time.Second
)

// voiceQualities maps accepted voice quality presets to their target bitrate
// in bits/s. This is the single source of truth — voice_join.go validates
// against these keys, qualityBitrate looks up the value.
var voiceQualities = map[string]int{
	"low":    32000,
	"medium": 64000,
	"high":   128000,
}

// qualityBitrate returns the target audio bitrate in bits/s based on a quality preset.
func qualityBitrate(quality string) int {
	if bitrate, ok := voiceQualities[quality]; ok {
		return bitrate
	}
	return voiceQualities["medium"]
}
