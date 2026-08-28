package ws

// OC-0006: EnableCameraIfUnderLimit / EnableScreenshareIfUnderLimit gate on
// COUNT(*) FROM voice_states WHERE ... (camera = 1 OR screenshare = 1) < N —
// one row per *user*, not one unit per *stream*. camera and screenshare are
// independent columns on the same row, so a single user with both flags set
// consumes only one slot in the count while actually publishing two streams.
// A channel capped at N simultaneous video streams can therefore over-admit
// to 2N live streams while still refusing the next publisher, claiming the
// N-stream cap is reached when more than N streams are already live.

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

const oc0006VideoStreamRoleID = int64(211)

func newOC0006VideoStreamDB(t *testing.T) *db.DB {
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
		 VALUES (?, 'oc-0006-video', NULL, ?, 5, 0)`,
		oc0006VideoStreamRoleID,
		permissions.ReadMessages|permissions.ConnectVoice|permissions.SpeakVoice|permissions.UseVideo|permissions.ShareScreen,
	); err != nil {
		t.Fatalf("seed oc-0006-video role: %v", err)
	}
	return database
}

func seedOC0006VideoStreamUser(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	uid, err := database.CreateUser(context.Background(), username, "hash", int(oc0006VideoStreamRoleID))
	if err != nil {
		t.Fatalf("CreateUser %s: %v", username, err)
	}
	return uid
}

// mustCreateVideoCappedChannel2 mirrors mustCreateVideoCappedChannel from
// oc_0023_screenshare_video_limit_test.go (kept file-local to avoid a
// cross-file test helper dependency).
func mustCreateVideoCappedChannel2(t *testing.T, database *db.DB, name string, maxVideo int) int64 {
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

// A channel capped at 2 simultaneous video streams. Alice alone publishes
// both her camera and her screenshare -- that is 2 streams from one row.
// Bob's camera enable must then be refused: the cap is already saturated by
// Alice's two streams. Today the gate counts Alice's row once (camera=1 OR
// screenshare=1 matches her single row), so it reads slot usage as 1, not 2,
// and wrongly admits Bob's third stream.
func TestEnableVideoSlot_SameUserDoubleStreamCountsTwoSlots(t *testing.T) {
	ctx := context.Background()
	database := newOC0006VideoStreamDB(t)
	chID := mustCreateVideoCappedChannel2(t, database, "capped-room-samerow", 2)

	alice := seedOC0006VideoStreamUser(t, database, "alice-double")
	bob := seedOC0006VideoStreamUser(t, database, "bob-third")
	if err := database.JoinVoiceChannel(ctx, alice, chID); err != nil {
		t.Fatalf("JoinVoiceChannel alice: %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, bob, chID); err != nil {
		t.Fatalf("JoinVoiceChannel bob: %v", err)
	}

	d := VoiceDeps{DB: database, Permissions: permissions.NewChecker(database)}

	ssRes := handleVoiceScreenshareV2(ctx, VoiceScreenshareCmd{userID: alice, enabled: true}, ClientInfo{UserID: alice, VoiceChannelID: chID}, d)
	if ssRes.Error != nil {
		t.Fatalf("alice screenshare enable (1st stream, cap 2) should succeed, got error: %+v", ssRes.Error)
	}

	camRes := handleVoiceCameraV2(ctx, VoiceCameraCmd{userID: alice, enabled: true}, ClientInfo{UserID: alice, VoiceChannelID: chID}, d)
	if camRes.Error != nil {
		t.Fatalf("alice camera enable (2nd stream, cap 2) should succeed, got error: %+v", camRes.Error)
	}

	// Cap is now saturated: Alice alone is publishing 2 of the 2 allowed
	// streams. Bob's camera enable is a 3rd stream and must be refused.
	bobCamRes := handleVoiceCameraV2(ctx, VoiceCameraCmd{userID: bob, enabled: true}, ClientInfo{UserID: bob, VoiceChannelID: chID}, d)
	if bobCamRes.Error == nil {
		t.Fatal("bob's camera enable succeeded as the channel's 3rd live video stream against a cap of 2 -- the same-user double-publish (camera+screenshare on one row) was undercounted as a single slot")
	}
	if ce, ok := bobCamRes.Error.(ClientError); !ok || ce.Code != ErrCodeVideoLimit {
		t.Errorf("error = %+v, want ClientError{Code: %q}", bobCamRes.Error, ErrCodeVideoLimit)
	}

	vs, err := database.GetVoiceState(ctx, bob)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState bob: %v", err)
	}
	if vs.Camera {
		t.Error("bob's camera flag was set to true despite the VIDEO_LIMIT refusal")
	}
}
