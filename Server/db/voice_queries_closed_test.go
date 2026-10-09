package db_test

import (
	"context"
	"testing"
)

// TestVoiceQueries_ReportClosedDatabaseErrors proves every voice-state query
// surfaces the driver's error once the handle is closed, rather than panicking
// or reporting "no voice state" as if the lookup had succeeded.
func TestVoiceQueries_ReportClosedDatabaseErrors(t *testing.T) {
	database := openMigratedMemory(t)
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	calls := map[string]func() error{
		"JoinVoiceChannel": func() error { return database.JoinVoiceChannel(ctx, 1, 1) },
		"JoinVoiceChannelIfCapacity": func() error {
			return database.JoinVoiceChannelIfCapacity(ctx, 1, 1, 5)
		},
		"LeaveVoiceChannel": func() error { return database.LeaveVoiceChannel(ctx, 1) },
		"LeaveVoiceChannelIfMatch": func() error {
			_, err := database.LeaveVoiceChannelIfMatch(ctx, 1, 1, "token")
			return err
		},
		"GetVoiceState": func() error { _, err := database.GetVoiceState(ctx, 1); return err },
		"GetChannelVoiceStates": func() error {
			_, err := database.GetChannelVoiceStates(ctx, 1)
			return err
		},
		"GetAllVoiceStates":    func() error { _, err := database.GetAllVoiceStates(ctx); return err },
		"UpdateVoiceMute":      func() error { return database.UpdateVoiceMute(ctx, 1, true) },
		"UpdateVoiceDeafen":    func() error { return database.UpdateVoiceDeafen(ctx, 1, true) },
		"SetVoiceServerMute":   func() error { _, err := database.SetVoiceServerMute(ctx, 1, 1, true); return err },
		"SetVoiceServerDeafen": func() error { _, err := database.SetVoiceServerDeafen(ctx, 1, 1, true); return err },
		"MuteForTimeoutSession": func() error {
			_, _, err := database.MuteForTimeoutSession(ctx, 1, 1, 1, "token", nil)
			return err
		},
		"ClearServerMuteOwnedBy": func() error {
			_, _, _, err := database.ClearServerMuteOwnedBy(ctx, 1, []int64{1})
			return err
		},
		"FindOrphanedVoiceMutes": func() error { _, err := database.FindOrphanedVoiceMutes(ctx); return err },
		"ClearVoiceState":        func() error { return database.ClearVoiceState(ctx, 1) },
		"ClearAllVoiceStates":    func() error { return database.ClearAllVoiceStates(ctx) },
		"CountActiveCameras":     func() error { _, err := database.CountActiveCameras(ctx, 1); return err },
		"UpdateVoiceCamera":      func() error { return database.UpdateVoiceCamera(ctx, 1, true) },
		"EnableCameraIfUnderLimit": func() error {
			_, err := database.EnableCameraIfUnderLimit(ctx, 1, 1, 4)
			return err
		},
		"UpdateVoiceScreenshare": func() error { return database.UpdateVoiceScreenshare(ctx, 1, true) },
		"EnableScreenshareIfUnderLimit": func() error {
			_, err := database.EnableScreenshareIfUnderLimit(ctx, 1, 1, 4)
			return err
		},
		"CountChannelVoiceUsers": func() error {
			_, err := database.CountChannelVoiceUsers(ctx, 1)
			return err
		},
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			if err := call(); err == nil {
				t.Fatalf("%s on a closed database: want an error", name)
			}
		})
	}
}
