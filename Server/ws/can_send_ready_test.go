package ws_test

import (
	"encoding/json"
	"testing"
)

// TestBuildReady_IncludesCanSend confirms every ready channel carries the
// can_send affordance flag the client composer keys off.
func TestBuildReady_IncludesCanSend(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cansend-user")
	role, err := database.GetRoleByID(1)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}
	if _, err := database.CreateChannel("general", "text", "", "", 0); err != nil {
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
