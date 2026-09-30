package service

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// TestSettingsPatch_ValueLimits pins the limits the setup wizard shares with
// the settings PATCH at the service seam: a bad value is ErrBadRequest with
// the key's own message, and nothing is written.
func TestSettingsPatch_ValueLimits(t *testing.T) {
	svc := NewSettingsService(newTestDB(t))
	ctx := context.Background()
	bad := map[string]string{
		"max_upload_bytes": "-5",
		"voice_quality":    "ultra",
		"server_name":      strings.Repeat("n", MaxServerNameLen+1),
		"motd":             strings.Repeat("m", MaxMotdLen+1),
	}
	for key, value := range bad {
		_, err := svc.Patch(ctx, 1, map[string]string{key: value})
		if !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", key, err)
			continue
		}
		if !strings.HasPrefix(err.Error(), key) {
			t.Errorf("%s: message %q does not name the key", key, err.Error())
		}
		if got, _ := svc.Setting(ctx, key); got == value {
			t.Errorf("%s: invalid value was written", key)
		}
	}
	all, err := svc.Patch(ctx, 1, map[string]string{
		"max_upload_bytes": " 104857600 ",
		"voice_quality":    "Low",
		"server_name":      "  Home  ",
		"motd":             strings.Repeat("m", MaxMotdLen),
	})
	if err != nil {
		t.Fatalf("valid patch: %v", err)
	}
	for key, want := range map[string]string{"max_upload_bytes": "104857600", "voice_quality": "low", "server_name": "Home"} {
		if all[key] != want {
			t.Errorf("%s = %q, want %q", key, all[key], want)
		}
	}
	if got := VoiceQualityPresets(); strings.Join(got, ",") != "low,medium,high" {
		t.Errorf("VoiceQualityPresets() = %v", got)
	}
}
