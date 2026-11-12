package ws_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// ─── roles_update ────────────────────────────────────────────────────────────

func TestBroadcastRolesUpdate_CarriesFullList(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	user := seedOwnerUser(t, database, "roles-owner")
	_, send := connectClient(t, hub, user, 0, 16)

	roles, err := database.ListRoles(context.Background())
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	hub.BroadcastRolesUpdate(roles)

	msg := drainForMsgType(t, send, "roles_update")
	payload, ok := msg["payload"].(map[string]any)
	if !ok {
		t.Fatalf("payload missing: %v", msg)
	}
	list, ok := payload["roles"].([]any)
	if !ok {
		t.Fatalf("roles missing: %v", payload)
	}
	if len(list) != len(roles) {
		t.Fatalf("broadcast carried %d roles, want %d", len(list), len(roles))
	}
	first, ok := list[0].(map[string]any)
	if !ok {
		t.Fatalf("role entry is not an object: %v", list[0])
	}
	// The client refreshes channelsStore.roles from this, so it needs the same
	// fields the ready payload's role list carries.
	for _, key := range []string{"id", "name", "color", "permissions", "position", "is_default"} {
		if _, present := first[key]; !present {
			t.Errorf("role entry missing %q: %v", key, first)
		}
	}
}

func TestBroadcastRolesUpdate_NilEntriesAreSkipped(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	user := seedOwnerUser(t, database, "roles-nil-owner")
	_, send := connectClient(t, hub, user, 0, 16)

	// A nil in the slice must not produce a null entry the client would have
	// to defend against.
	hub.BroadcastRolesUpdate([]*db.Role{nil, {ID: 7, Name: "Helper", Position: 3}})

	msg := drainForMsgType(t, send, "roles_update")
	raw, err := json.Marshal(msg["payload"])
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	var payload struct {
		Roles []db.Role `json:"roles"`
	}
	mustUnmarshal(t, raw, &payload)
	if len(payload.Roles) != 1 || payload.Roles[0].Name != "Helper" {
		t.Fatalf("roles = %+v, want just the non-nil entry", payload.Roles)
	}
}

// ─── RefreshAllChannelVisibility ─────────────────────────────────────────────

func TestRefreshAllChannelVisibility_CoversEveryChannel(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	firstID := seedTestChannel(t, database, "room-one")
	secondID := seedTestChannel(t, database, "room-two")

	memberID := seedTestUser(t, database, "vis-all-member")
	member := mustGetUser(t, database, memberID)
	_, send := connectClient(t, hub, member, firstID, 32)

	// Strip READ_MESSAGES from the Member role itself — the case a role edit
	// produces, where no single channel's overrides changed but every channel's
	// audience did.
	if _, err := database.ExecContext(context.Background(),
		`UPDATE roles SET permissions = 0 WHERE id = 4`,
	); err != nil {
		t.Fatalf("strip role permissions: %v", err)
	}

	hub.RefreshAllChannelVisibility()

	// Both channels are revoked, not just the focused one.
	seen := map[int64]bool{}
	for range 2 {
		msg := drainForMsgType(t, send, "channel_delete")
		payload, ok := msg["payload"].(map[string]any)
		if !ok {
			t.Fatalf("channel_delete payload missing: %v", msg)
		}
		id, ok := payload["id"].(float64)
		if !ok {
			t.Fatalf("channel_delete carries no id: %v", payload)
		}
		seen[int64(id)] = true
	}
	if !seen[firstID] || !seen[secondID] {
		t.Errorf("revoked channels = %v, want both %d and %d", seen, firstID, secondID)
	}
}

func TestRefreshAllChannelVisibility_SkipsDMChannels(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	memberID := seedTestUser(t, database, "vis-dm-member")
	member := mustGetUser(t, database, memberID)
	otherID := seedTestUser(t, database, "vis-dm-other")
	dm, _, err := database.GetOrCreateDMChannel(context.Background(), memberID, otherID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	_, send := connectClient(t, hub, member, dm.ID, 32)

	// A DM's access is participation, which no role change can revoke — so a
	// role-driven visibility sweep must leave it alone.
	if _, err := database.ExecContext(context.Background(),
		`UPDATE roles SET permissions = 0 WHERE id = 4`,
	); err != nil {
		t.Fatalf("strip role permissions: %v", err)
	}
	hub.RefreshAllChannelVisibility()

	assertNoMsgType(t, send, "channel_delete")
}
