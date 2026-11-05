package ws_test

import (
	"context"
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

	raw := mustBuildReadyWithRole(t, hub, database, targetUID, targetRole)
	var payload readyNoticesPayload
	mustUnmarshal(t, raw, &payload)
	if len(payload.Payload.Notices) != 1 {
		t.Fatalf("notices = %+v, want exactly 1", payload.Payload.Notices)
	}
	if got := payload.Payload.Notices[0]; got.ID != id || got.Kind != "warning" || got.Reason != "please be nice" {
		t.Fatalf("notice = %+v, want {id:%d kind:warning reason:\"please be nice\"}", got, id)
	}

	if ok, err := database.AcknowledgeWarning(ctx, targetUID, id); err != nil || !ok {
		t.Fatalf("AcknowledgeWarning: ok=%v err=%v", ok, err)
	}

	raw2 := mustBuildReadyWithRole(t, hub, database, targetUID, targetRole)
	var payload2 readyNoticesPayload
	mustUnmarshal(t, raw2, &payload2)
	if len(payload2.Payload.Notices) != 0 {
		t.Fatalf("notices after acknowledgement = %+v, want none", payload2.Payload.Notices)
	}
}
