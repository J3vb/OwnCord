package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestSettings_PatchVoiceMaxVideoKbps(t *testing.T) {
	svc, database := newSettingsService(t)
	ctx := context.Background()
	for _, tc := range []struct{ in, stored string }{
		{"0", "0"},
		{" 300 ", "300"},
		{"6000", "6000"},
		{"50000", "50000"},
	} {
		if _, err := svc.Patch(ctx, 0, map[string]string{VoiceMaxVideoKbpsKey: tc.in}); err != nil {
			t.Fatalf("Patch %q: %v", tc.in, err)
		}
		if got, err := database.GetSetting(ctx, VoiceMaxVideoKbpsKey); err != nil || got != tc.stored {
			t.Errorf("stored after %q = %q, %v; want %q", tc.in, got, err, tc.stored)
		}
	}
	for _, bad := range []string{"", "-1", "1", "299", "50001", "6 Mbps", "1.5"} {
		_, err := svc.Patch(ctx, 0, map[string]string{VoiceMaxVideoKbpsKey: bad})
		if !errors.Is(err, ErrBadRequest) {
			t.Errorf("Patch %q err = %v, want ErrBadRequest", bad, err)
		}
	}
	if got, _ := database.GetSetting(ctx, VoiceMaxVideoKbpsKey); got != "50000" {
		t.Errorf("a refused value changed the row to %q", got)
	}
}

func TestVoiceMaxVideoBitrate(t *testing.T) {
	for _, tc := range []struct {
		stored string
		want   int
	}{
		{"", 0}, {"0", 0}, {"300", 300_000}, {"6000", 6_000_000}, {"12", 0}, {"999999", 0}, {"junk", 0},
	} {
		if got := VoiceMaxVideoBitrate(tc.stored); got != tc.want {
			t.Errorf("VoiceMaxVideoBitrate(%q) = %d, want %d", tc.stored, got, tc.want)
		}
	}
	if got, ok, err := VoiceMaxVideoBitrateFromRead("", db.ErrNotFound); got != 0 || !ok || err != nil {
		t.Errorf("missing row = %d, %v, %v; want 0, true, nil", got, ok, err)
	}
	boom := errors.New("boom")
	if _, ok, err := VoiceMaxVideoBitrateFromRead("", boom); ok || !errors.Is(err, boom) {
		t.Errorf("failed read = ok %v, err %v; want false and the wrapped error", ok, err)
	}
}

func TestSettings_PatchServerUploadMbps(t *testing.T) {
	svc, database := newSettingsService(t)
	ctx := context.Background()
	for _, tc := range []struct{ in, stored string }{
		{"0", "0"},
		{" 1 ", "1"},
		{"250", "250"},
		{"100000", "100000"},
	} {
		if _, err := svc.Patch(ctx, 0, map[string]string{ServerUploadMbpsKey: tc.in}); err != nil {
			t.Fatalf("Patch %q: %v", tc.in, err)
		}
		if got, err := database.GetSetting(ctx, ServerUploadMbpsKey); err != nil || got != tc.stored {
			t.Errorf("stored after %q = %q, %v; want %q", tc.in, got, err, tc.stored)
		}
	}
	for _, bad := range []string{"", "-1", "100001", "1.5", "fast", "10 Mbps"} {
		_, err := svc.Patch(ctx, 0, map[string]string{ServerUploadMbpsKey: bad})
		if !errors.Is(err, ErrBadRequest) {
			t.Errorf("Patch %q err = %v, want ErrBadRequest", bad, err)
		}
	}
	if got, _ := database.GetSetting(ctx, ServerUploadMbpsKey); got != "100000" {
		t.Errorf("a refused value changed the row to %q", got)
	}
}
