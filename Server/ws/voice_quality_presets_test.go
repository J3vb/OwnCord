package ws

import (
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/service"
)

// TestVoiceQualities_MatchSettingsPresets: the admin settings PATCH and the
// setup wizard accept exactly service.VoiceQualityPresets, so every preset
// they store must be one this package maps to a bitrate, and the reverse.
func TestVoiceQualities_MatchSettingsPresets(t *testing.T) {
	presets := service.VoiceQualityPresets()
	for _, q := range presets {
		if !validVoiceQuality(q) {
			t.Errorf("settings accept voice_quality %q, which the voice code does not", q)
		}
	}
	for q := range voiceQualities {
		if !slices.Contains(presets, q) {
			t.Errorf("voice code accepts %q, which the settings refuse", q)
		}
	}
}
