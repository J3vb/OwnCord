package ws_test

import (
	"context"
	"encoding/json"
	"testing"
)

// TestBuildReady_IncludesCanSend confirms every ready channel carries the
// can_send affordance flag the client composer keys off.
func TestBuildReady_IncludesCanSend(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cansend-user")
	role, err := database.GetRoleByID(context.Background(), 1)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}
	if _, err := database.CreateChannel(context.Background(), "general", "text", "", "", 0); err != nil {
		t.Fatalf("CreateChannel: %v", err)
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
	if len(env.Payload.Channels) == 0 {
		t.Fatal("expected at least one channel")
	}
	for _, ch := range env.Payload.Channels {
		canSend, ok := ch["can_send"]
		if !ok {
			t.Errorf("channel %v missing can_send", ch["name"])
			continue
		}
		// Owner role → can_send true everywhere.
		if canSend != true {
			t.Errorf("channel %v can_send = %v, want true for owner", ch["name"], canSend)
		}
	}
}

// TestBuildReady_CanModerateVoice: every ready channel carries the B9 Q5
// voice-moderation affordance — true for a role that holds MUTE_MEMBERS,
// false for the default Member role, which does not.
func TestBuildReady_CanModerateVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "modvoice-ready-user")
	if _, err := database.CreateChannel(context.Background(), "lounge", "voice", "", "", 0); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	for _, tc := range []struct {
		roleID int64
		want   bool
	}{{1, true}, {4, false}} {
		role, err := database.GetRoleByID(context.Background(), tc.roleID)
		if err != nil || role == nil {
			t.Fatalf("GetRoleByID(%d): %v", tc.roleID, err)
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
		if len(env.Payload.Channels) == 0 {
			t.Fatalf("role %d: expected at least one channel", tc.roleID)
		}
		for _, ch := range env.Payload.Channels {
			if got, ok := ch["can_moderate_voice"]; !ok || got != tc.want {
				t.Errorf("role %d channel %v can_moderate_voice = %v (present %v), want %v", tc.roleID, ch["name"], got, ok, tc.want)
			}
		}
	}
}
