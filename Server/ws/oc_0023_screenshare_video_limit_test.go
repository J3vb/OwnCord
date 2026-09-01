package ws

// OC-0023: voice_max_video is enforced only for camera publishes.
// handleVoiceScreenshareV2 never checks the channel's VIDEO_LIMIT cap before
// writing UpdateVoiceScreenshare, and EnableCameraIfUnderLimit's slot-count
// subquery only ever counted `camera = 1` rows, so the two publish kinds
// neither share a budget nor respect each other's occupancy of it.

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// oc0023VideoLimitRoleID is a dedicated, non-seeded role carrying every
// permission bit these tests exercise (connect, speak, camera, screenshare),
// so the test does not depend on what the migrations grant the defaults.
const oc0023VideoLimitRoleID = int64(210)

func newOC0023VideoLimitDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (?, 'oc-0023-video', NULL, ?, 5, 0)`,
		oc0023VideoLimitRoleID,
		permissions.ReadMessages|permissions.ConnectVoice|permissions.SpeakVoice|permissions.UseVideo|permissions.ShareScreen,
	); err != nil {
		t.Fatalf("seed oc-0023-video role: %v", err)
	}
	return database
}

func seedOC0023VideoLimitUser(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	uid, err := database.CreateUser(context.Background(), username, "hash", int(oc0023VideoLimitRoleID))
	if err != nil {
		t.Fatalf("CreateUser %s: %v", username, err)
	}
	return uid
}

// mustCreateVideoCappedChannel creates a voice channel and sets its
// voice_max_video cap via the same AdminUpdateChannel path an admin PATCH
// takes, so GetChannel(...).VoiceMaxVideo comes back real rather than faked.
func mustCreateVideoCappedChannel(t *testing.T, database *db.DB, name string, maxVideo int) int64 {
	t.Helper()
	chID, err := database.CreateChannel(context.Background(), name, "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel %s: %v", name, err)
	}
	if err := database.AdminUpdateChannel(context.Background(), chID, db.ChannelUpdate{
		Name:          name,
		VoiceMaxVideo: maxVideo,
	}); err != nil {
		t.Fatalf("AdminUpdateChannel %s: %v", name, err)
	}
	return chID
}

// A channel capped at one simultaneous video stream already has a camera
// publisher occupying the slot. A second user's voice_screenshare(true) must
// be refused with VIDEO_LIMIT, exactly like a second camera enable would be.
// Today handleVoiceScreenshareV2 performs no cap check at all, so this
// currently enables the screenshare and returns no error.
func TestHandleVoiceScreenshareV2_RefusedWhenCameraSlotFull(t *testing.T) {
	ctx := context.Background()
	database := newOC0023VideoLimitDB(t)
	chID := mustCreateVideoCappedChannel(t, database, "capped-room", 1)

	userA := seedOC0023VideoLimitUser(t, database, "cam-holder")
	userB := seedOC0023VideoLimitUser(t, database, "share-hopeful")
	if err := database.JoinVoiceChannel(ctx, userA, chID); err != nil {
		t.Fatalf("JoinVoiceChannel A: %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, userB, chID); err != nil {
		t.Fatalf("JoinVoiceChannel B: %v", err)
	}

	d := VoiceDeps{Voice: service.NewVoiceService(database), Reader: database, Permissions: permissions.NewChecker(database)}

	camRes := handleVoiceCameraV2(ctx, VoiceCameraCmd{userID: userA, enabled: true}, ClientInfo{UserID: userA, VoiceChannelID: chID}, d)
	if camRes.Error != nil {
		t.Fatalf("user A camera enable under an empty cap should succeed, got error: %+v", camRes.Error)
	}

	ssRes := handleVoiceScreenshareV2(ctx, VoiceScreenshareCmd{userID: userB, enabled: true}, ClientInfo{UserID: userB, VoiceChannelID: chID}, d)
	if ssRes.Error == nil {
		t.Fatal("voice_screenshare succeeded with the channel's single video slot already held by a camera publisher — VIDEO_LIMIT was never checked")
	}
	var ce ClientError
	if !errors.As(ssRes.Error, &ce) || ce.Code != ErrCodeVideoLimit {
		t.Errorf("error = %+v, want ClientError{Code: %q}", ssRes.Error, ErrCodeVideoLimit)
	}

	vs, err := database.GetVoiceState(ctx, userB)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState B: %v", err)
	}
	if vs.Screenshare {
		t.Error("user B's screenshare flag was set to true despite the VIDEO_LIMIT refusal")
	}
}

// Symmetrically: a channel capped at one slot already occupied by a
// screenshare must refuse a second user's camera enable. Today
// EnableCameraIfUnderLimit's slot-count subquery only counts `camera = 1`
// rows, so a screensharing user is invisible to it and the camera enable
// wrongly succeeds.
func TestHandleVoiceCameraV2_RefusedWhenScreenshareSlotFull(t *testing.T) {
	ctx := context.Background()
	database := newOC0023VideoLimitDB(t)
	chID := mustCreateVideoCappedChannel(t, database, "capped-room-2", 1)

	userA := seedOC0023VideoLimitUser(t, database, "share-holder")
	userB := seedOC0023VideoLimitUser(t, database, "cam-hopeful")
	if err := database.JoinVoiceChannel(ctx, userA, chID); err != nil {
		t.Fatalf("JoinVoiceChannel A: %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, userB, chID); err != nil {
		t.Fatalf("JoinVoiceChannel B: %v", err)
	}

	d := VoiceDeps{Voice: service.NewVoiceService(database), Reader: database, Permissions: permissions.NewChecker(database)}

	ssRes := handleVoiceScreenshareV2(ctx, VoiceScreenshareCmd{userID: userA, enabled: true}, ClientInfo{UserID: userA, VoiceChannelID: chID}, d)
	if ssRes.Error != nil {
		t.Fatalf("user A screenshare enable under an empty cap should succeed, got error: %+v", ssRes.Error)
	}

	camRes := handleVoiceCameraV2(ctx, VoiceCameraCmd{userID: userB, enabled: true}, ClientInfo{UserID: userB, VoiceChannelID: chID}, d)
	if camRes.Error == nil {
		t.Fatal("voice_camera succeeded with the channel's single video slot already held by a screenshare publisher — the slot-count query ignores screenshare rows")
	}
	var ce ClientError
	if !errors.As(camRes.Error, &ce) || ce.Code != ErrCodeVideoLimit {
		t.Errorf("error = %+v, want ClientError{Code: %q}", camRes.Error, ErrCodeVideoLimit)
	}

	vs, err := database.GetVoiceState(ctx, userB)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState B: %v", err)
	}
	if vs.Camera {
		t.Error("user B's camera flag was set to true despite the VIDEO_LIMIT refusal")
	}
}
