package ws_test

import (
	"context"
	"encoding/json"
	"testing"
)

// readyNoticesPayload is the subset of ready's payload this file reads.
type readyNoticesPayload struct {
	Payload struct {
		Notices []struct {
			ID     int64  `json:"id"`
			Kind   string `json:"kind"`
			Reason string `json:"reason"`
		} `json:"notices"`
	} `json:"payload"`
}

// TestWarning_ReadyCarriesUnacknowledgedNotices: an unacknowledged warning
// appears in ready's notices slot, and acknowledging it removes it.
func TestWarning_ReadyCarriesUnacknowledgedNotices(t *testing.T) {
	hub, database := newServeHub(t)
	ctx := context.Background()

	owner := seedServeUser(t, database, "owner")
	targetUID, err := database.CreateUser(ctx, "targetuser", "hash", 4) // role 4: seeded Member
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	targetRole, err := database.GetRoleByID(ctx, 4)
	if err != nil || targetRole == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}

	id, err := database.WarnUser(ctx, targetUID, owner.ID, nil, "please be nice")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}

	raw, err := hub.BuildReadyWithRoleForTest(database, targetUID, targetRole)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}
	var payload readyNoticesPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	if len(payload.Payload.Notices) != 1 {
		t.Fatalf("notices = %+v, want exactly 1", payload.Payload.Notices)
	}
	if got := payload.Payload.Notices[0]; got.ID != id || got.Kind != "warning" || got.Reason != "please be nice" {
		t.Fatalf("notice = %+v, want {id:%d kind:warning reason:\"please be nice\"}", got, id)
	}

	if ok, err := database.AcknowledgeWarning(ctx, targetUID, id); err != nil || !ok {
		t.Fatalf("AcknowledgeWarning: ok=%v err=%v", ok, err)
	}

	raw2, err := hub.BuildReadyWithRoleForTest(database, targetUID, targetRole)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest after ack: %v", err)
	}
	var payload2 readyNoticesPayload
	if err := json.Unmarshal(raw2, &payload2); err != nil {
		t.Fatalf("unmarshal ready after ack: %v", err)
	}
	if len(payload2.Payload.Notices) != 0 {
		t.Fatalf("notices after acknowledgement = %+v, want none", payload2.Payload.Notices)
	}
}
