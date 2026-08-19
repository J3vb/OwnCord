package db_test

import (
	"context"
	"testing"
)

// OC-0081: EnableCameraIfUnderLimit's guard subquery counted every video
// stream in the channel INCLUDING the requester's own camera row, so a user
// whose server-side camera flag was already 1 could never re-enable at the
// cap: the sole publisher in a max_video=1 room got VIDEO_LIMIT against
// their own stream, with no path out (the client believes the camera is off
// and never sends a disable). Re-enable must be idempotent; a genuinely new
// publisher at the cap must still be refused; the requester's OTHER stream
// (screenshare) must still count against enabling their camera.

func TestVoice_EnableCameraIfUnderLimit_ReEnableIdempotentAtCap(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "cam-reen-u1")
	chanID := seedVoiceChannel(t, database, "cam-reen-ch")
	_ = database.JoinVoiceChannel(context.Background(), u1, chanID)

	ok, err := database.EnableCameraIfUnderLimit(context.Background(), u1, chanID, 1)
	if err != nil || !ok {
		t.Fatalf("first enable: ok=%v err=%v, want true", ok, err)
	}

	// Same user, camera row already 1, still the only stream in the room.
	ok, err = database.EnableCameraIfUnderLimit(context.Background(), u1, chanID, 1)
	if err != nil {
		t.Fatalf("re-enable: %v", err)
	}
	if !ok {
		t.Error("re-enable at the cap was refused against the requester's own camera row")
	}
}

func TestVoice_EnableCameraIfUnderLimit_OtherUserStillRefusedAtCap(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "cam-cap-u1")
	u2 := seedVoiceUser(t, database, "cam-cap-u2")
	chanID := seedVoiceChannel(t, database, "cam-cap-ch")
	_ = database.JoinVoiceChannel(context.Background(), u1, chanID)
	_ = database.JoinVoiceChannel(context.Background(), u2, chanID)

	if ok, err := database.EnableCameraIfUnderLimit(context.Background(), u1, chanID, 1); err != nil || !ok {
		t.Fatalf("u1 enable: ok=%v err=%v, want true", ok, err)
	}
	ok, err := database.EnableCameraIfUnderLimit(context.Background(), u2, chanID, 1)
	if err != nil {
		t.Fatalf("u2 enable: %v", err)
	}
	if ok {
		t.Error("a new publisher was admitted past the video cap")
	}
}

func TestVoice_EnableCameraIfUnderLimit_OwnScreenshareStillCounts(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "cam-ss-u1")
	chanID := seedVoiceChannel(t, database, "cam-ss-ch")
	_ = database.JoinVoiceChannel(context.Background(), u1, chanID)

	if ok, err := database.EnableScreenshareIfUnderLimit(context.Background(), u1, chanID, 1); err != nil || !ok {
		t.Fatalf("screenshare enable: ok=%v err=%v, want true", ok, err)
	}
	// The camera would be a SECOND stream from this user; the cap is 1.
	ok, err := database.EnableCameraIfUnderLimit(context.Background(), u1, chanID, 1)
	if err != nil {
		t.Fatalf("camera enable: %v", err)
	}
	if ok {
		t.Error("own screenshare must still count toward the cap when enabling the camera")
	}
}

func TestVoice_EnableScreenshareIfUnderLimit_ReEnableIdempotentAtCap(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "ss-reen-u1")
	chanID := seedVoiceChannel(t, database, "ss-reen-ch")
	_ = database.JoinVoiceChannel(context.Background(), u1, chanID)

	if ok, err := database.EnableScreenshareIfUnderLimit(context.Background(), u1, chanID, 1); err != nil || !ok {
		t.Fatalf("first enable: ok=%v err=%v, want true", ok, err)
	}
	ok, err := database.EnableScreenshareIfUnderLimit(context.Background(), u1, chanID, 1)
	if err != nil {
		t.Fatalf("re-enable: %v", err)
	}
	if !ok {
		t.Error("screenshare re-enable at the cap was refused against the requester's own row")
	}
}
