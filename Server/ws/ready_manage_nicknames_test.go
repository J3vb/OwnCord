package ws

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// TestReady_CapabilityManageNicknames: ready advertises manage_nicknames so a
// new client does not offer Change Nickname against a server without the route.
func TestReady_CapabilityManageNicknames(t *testing.T) {
	f := newActivityFixture(t)
	u := f.user(t, "nick-cap", permissions.MemberRoleID)
	raw, err := f.hub.readyBytes(f.db, u.ID, nil)
	if err != nil {
		t.Fatalf("readyBytes: %v", err)
	}
	var env struct {
		Payload struct {
			Capabilities map[string]any `json:"capabilities"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	if got, ok := env.Payload.Capabilities["manage_nicknames"].(bool); !ok || !got {
		t.Errorf("capabilities.manage_nicknames = %v, want true", env.Payload.Capabilities["manage_nicknames"])
	}
}

// TestNicknameRoute_OfflineTarget_NextReadyCarriesName: a renamed member who
// is offline has no frame to receive, so the next ready must carry the new
// name. The first ready warms the shared member cache; the rename must
// invalidate it (the member_generation trigger on display_name).
func TestNicknameRoute_OfflineTarget_NextReadyCarriesName(t *testing.T) {
	f := newActivityFixture(t)
	viewer := f.user(t, "nick-viewer", permissions.MemberRoleID)
	target := f.user(t, "nick-target", permissions.MemberRoleID)
	actor := f.user(t, "nick-actor", permissions.AdminRoleID)

	displayNameOf := func(raw []byte) *string {
		t.Helper()
		var env struct {
			Payload struct {
				Members []struct {
					ID          int64   `json:"id"`
					DisplayName *string `json:"display_name"`
				} `json:"members"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("unmarshal ready: %v", err)
		}
		for _, m := range env.Payload.Members {
			if m.ID == target.ID {
				return m.DisplayName
			}
		}
		t.Fatalf("target %d not in ready members", target.ID)
		return nil
	}

	raw, err := f.hub.readyBytes(f.db, viewer.ID, nil)
	if err != nil {
		t.Fatalf("readyBytes: %v", err)
	}
	if got := displayNameOf(raw); got != nil {
		t.Fatalf("display_name before = %q, want none", *got)
	}

	name := "Fresh Name"
	if _, err := f.db.SetDisplayNameAsModerator(context.Background(), actor.ID, target.ID, &name); err != nil {
		t.Fatalf("SetDisplayNameAsModerator: %v", err)
	}
	raw, err = f.hub.readyBytes(f.db, viewer.ID, nil)
	if err != nil {
		t.Fatalf("readyBytes after: %v", err)
	}
	if got := displayNameOf(raw); got == nil || *got != name {
		t.Fatalf("display_name after = %v, want %q", got, name)
	}
}
