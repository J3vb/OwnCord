package ws_test

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// WP 6.3c: ready carries every member's held roles (top first), the role list
// carries hoist and mentionable, and the capability advertises both.
func TestReady_MembersCarryRoleIDs(t *testing.T) {
	hub, database := newTestHub(t)
	ctx := context.Background()
	viewer := seedOwnerUser(t, database, "viewer")
	multi := seedTestUser(t, database, "multi") // Member
	single := seedTestUser(t, database, "single")
	if err := database.AddUserRole(ctx, multi, permissions.ModeratorRoleID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}

	raw, err := hub.BuildReadyWithReaderForTest(database, viewer.ID)
	if err != nil {
		t.Fatalf("buildReady: %v", err)
	}
	members := readyMembers(t, raw)
	ids := func(id int64) any { return members[id]["role_ids"] }
	if got, want := ids(multi), []any{float64(permissions.ModeratorRoleID), float64(permissions.MemberRoleID)}; !reflect.DeepEqual(got, want) {
		t.Errorf("multi-role member role_ids = %v, want %v (top first)", got, want)
	}
	if members[multi]["role"] != "moderator" {
		t.Errorf("multi-role member role = %v, want the top role's name", members[multi]["role"])
	}
	if got, want := ids(single), []any{float64(permissions.MemberRoleID)}; !reflect.DeepEqual(got, want) {
		t.Errorf("single-role member role_ids = %v, want %v", got, want)
	}

	var env struct {
		Payload struct {
			Capabilities map[string]any `json:"capabilities"`
			Roles        []struct {
				ID          int64 `json:"id"`
				Hoist       *bool `json:"hoist"`
				Mentionable *bool `json:"mentionable"`
			} `json:"roles"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	if env.Payload.Capabilities["multi_role"] != true {
		t.Errorf("capabilities = %v, want multi_role true", env.Payload.Capabilities)
	}
	if len(env.Payload.Roles) == 0 {
		t.Fatal("ready carries no roles")
	}
	for _, r := range env.Payload.Roles {
		if r.Hoist == nil || r.Mentionable == nil {
			t.Errorf("role %d is missing hoist or mentionable", r.ID)
		}
	}
}

// Removing a role that is NOT the member's top role changes what they may read
// without moving users.role_id. On a live connection the channel only that role
// granted is released at once, and its frames stop.
func TestRemoveUserRole_NonTopRoleRevokesLiveChannel(t *testing.T) {
	database := openTestDB(t)
	ctx := context.Background()
	// Neither role reads anything by itself; Member reads chX through its
	// channel override alone.
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = 0 WHERE id IN (3, 4)`); err != nil {
		t.Fatalf("strip roles: %v", err)
	}
	chX := seedTestChannel(t, database, "member-only")
	if err := database.UpsertChannelOverride(ctx, chX, permissions.MemberRoleID, permissions.ReadMessages, 0); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	hub := newTestHubDeps(t, database, nil, nil)
	go hub.Run()
	t.Cleanup(func() {
		hub.Stop()
		<-hub.Done()
	})

	// The member holds Moderator (top) and Member; Member is the one removed.
	targetID, err := database.CreateUser(ctx, "two-roles", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := database.AddUserRole(ctx, targetID, permissions.ModeratorRoleID); err != nil {
		t.Fatalf("AddUserRole: %v", err)
	}
	target, err := database.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.RoleID != permissions.ModeratorRoleID {
		t.Fatalf("GetUserByID = %+v, %v, want the mirror on Moderator", target, err)
	}
	send := make(chan []byte, 256)
	c := ws.NewTestClientWithUser(hub, target, chX, send)
	hub.RegisterNowForTest(c)
	hub.PubSubForTest().Subscribe(c, ws.ChannelTopic(chX))

	chat := func(marker string) []byte {
		return []byte(`{"type":"chat_message","payload":{"channel_id":` + strconv.FormatInt(chX, 10) + `,"content":"` + marker + `"}}`)
	}
	hub.BroadcastToChannel(chX, chat("before-removal"))
	if !hasFrame(rvDrain(send, 400*time.Millisecond), "before-removal") {
		t.Fatal("setup: the member does not receive channel frames while holding Member")
	}

	ownerID, err := database.CreateUser(ctx, "owner-actor", "hash", int(permissions.OwnerRoleID))
	if err != nil {
		t.Fatalf("CreateUser owner: %v", err)
	}
	perms := service.NewPermissionService(database, permissions.NewChecker(database))
	mod := service.NewModerationService(database, perms)
	mod.SetPermissionNotifier(hub)
	if _, err := mod.RemoveUserRole(ctx, ownerID, targetID, permissions.MemberRoleID); err != nil {
		t.Fatalf("RemoveUserRole: %v", err)
	}
	if after, _ := database.GetUserByID(ctx, targetID); after == nil || after.RoleID != permissions.ModeratorRoleID {
		t.Fatalf("users.role_id = %+v, want it unmoved on Moderator: the removed role was not the top one", after)
	}

	hub.BroadcastToChannel(chX, chat("after-removal"))
	if hasFrame(rvDrain(send, 400*time.Millisecond), "after-removal") {
		t.Error("a channel frame reached the member after the only role that granted READ was removed")
	}
}
