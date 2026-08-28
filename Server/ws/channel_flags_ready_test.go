package ws_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// The channel feature flags (nsfw + the two voice capacity limits) have to be
// in `ready` and not only in the channel_update broadcast: a client that has
// just connected has received no broadcasts, and the desktop client pre-fills
// its edit modal and draws the sidebar's age-gate indicator straight from the
// channel store.
func TestBuildReady_CarriesChannelFeatureFlags(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "flags-user")
	role, err := database.GetRoleByID(context.Background(), 1)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}

	plainID, err := database.CreateChannel(context.Background(), "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	loungeID, err := database.CreateChannel(context.Background(), "lounge", "voice", "", "", 1)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.AdminUpdateChannel(context.Background(), loungeID, db.ChannelUpdate{
		Name:          "lounge",
		SlowMode:      30,
		Position:      1,
		NSFW:          true,
		VoiceMaxUsers: 5,
		VoiceMaxVideo: 2,
	}); err != nil {
		t.Fatalf("AdminUpdateChannel: %v", err)
	}

	msg, err := hub.BuildReadyWithRoleForTest(database, user.ID, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}
	var env struct {
		Payload struct {
			Channels []map[string]any `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	byID := make(map[float64]map[string]any, len(env.Payload.Channels))
	for _, ch := range env.Payload.Channels {
		id, ok := ch["id"].(float64)
		if !ok {
			t.Fatalf("channel %v has no numeric id", ch)
		}
		byID[id] = ch
	}

	lounge, ok := byID[float64(loungeID)]
	if !ok {
		t.Fatalf("lounge missing from ready channels: %v", env.Payload.Channels)
	}
	if lounge["nsfw"] != true {
		t.Errorf("lounge nsfw = %v, want true", lounge["nsfw"])
	}
	if lounge["voice_max_users"] != float64(5) {
		t.Errorf("lounge voice_max_users = %v, want 5", lounge["voice_max_users"])
	}
	if lounge["voice_max_video"] != float64(2) {
		t.Errorf("lounge voice_max_video = %v, want 2", lounge["voice_max_video"])
	}
	if lounge["slow_mode"] != float64(30) {
		t.Errorf("lounge slow_mode = %v, want 30", lounge["slow_mode"])
	}

	// An unflagged channel sends the keys with their zero values rather than
	// omitting them — "absent" must not have to mean two different things.
	plain, ok := byID[float64(plainID)]
	if !ok {
		t.Fatalf("general missing from ready channels: %v", env.Payload.Channels)
	}
	for key, want := range map[string]any{
		"nsfw":            false,
		"voice_max_users": float64(0),
		"voice_max_video": float64(0),
	} {
		got, present := plain[key]
		if !present {
			t.Errorf("general is missing %q", key)
			continue
		}
		if got != want {
			t.Errorf("general %s = %v, want %v", key, got, want)
		}
	}
}
