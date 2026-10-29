package ws_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
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

// TestBuildReady_CanMoveVoice: every ready channel carries the WP 8.4b move
// affordance, independent of can_moderate_voice. A role with only
// MOVE_MEMBERS moves but does not moderate; a role with only MUTE_MEMBERS
// moderates but does not move; a role with neither gets neither.
func TestBuildReady_CanMoveVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "movevoice-ready-user")
	if _, err := database.CreateChannel(context.Background(), "lounge", "voice", "", "", 0); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	base := permissions.ReadMessages | permissions.ConnectVoice
	for _, tc := range []struct {
		name          string
		perms         int64
		wantMove, mod bool
	}{
		{"move only", base | permissions.MoveMembers, true, false},
		{"mute only", base | permissions.MuteMembers, false, true},
		{"neither", base, false, false},
	} {
		role, err := database.GetRoleByID(context.Background(), 4)
		if err != nil || role == nil {
			t.Fatalf("GetRoleByID(4): %v", err)
		}
		role.Permissions = tc.perms
		msg, err := hub.BuildReadyWithRoleForTest(database, user.ID, role)
		if err != nil {
			t.Fatalf("%s: BuildReadyWithRoleForTest: %v", tc.name, err)
		}
		var env struct {
			Payload struct {
				Channels []map[string]any `json:"channels"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("%s: unmarshal: %v", tc.name, err)
		}
		if len(env.Payload.Channels) == 0 {
			t.Fatalf("%s: expected at least one channel", tc.name)
		}
		for _, ch := range env.Payload.Channels {
			if got, ok := ch["can_move_voice"]; !ok || got != tc.wantMove {
				t.Errorf("%s: channel %v can_move_voice = %v (present %v), want %v", tc.name, ch["name"], got, ok, tc.wantMove)
			}
			if got := ch["can_moderate_voice"]; got != tc.mod {
				t.Errorf("%s: channel %v can_moderate_voice = %v, want %v", tc.name, ch["name"], got, tc.mod)
			}
		}
	}
}

// TestBuildReady_MessageAffordances: every non-DM ready channel carries
// can_delete_others, can_pin and can_react for each kind of viewer, always
// present, and the dm_channels entries carry none of them.
func TestBuildReady_MessageAffordances(t *testing.T) {
	hub, database := newCoverageHub(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = permissions | ? WHERE id = 3`,
		permissions.ManageMessages|permissions.AddReactions); err != nil {
		t.Fatalf("pin Moderator permissions: %v", err)
	}
	general, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	staff, err := database.CreateChannel(ctx, "staff", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	news, err := database.CreateChannel(ctx, "news", "announcement", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	member := seedTestUser(t, database, "affordance-member")
	peer := seedTestUser(t, database, "affordance-peer")
	mod, err := database.CreateUser(ctx, "affordance-mod", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser mod: %v", err)
	}
	denied, err := database.CreateUser(ctx, "affordance-denied", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser denied: %v", err)
	}
	admin := seedCoverageOwner(t, database, "affordance-admin")
	if err := database.UpsertChannelUserOverride(ctx, staff, denied, 0, permissions.ManageMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	if _, _, err := database.GetOrCreateDMChannel(ctx, member, peer); err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	type verdict struct{ del, pin, react bool }
	cases := []struct {
		name   string
		userID int64
		want   map[int64]verdict
	}{
		{"member", member, map[int64]verdict{general: {false, false, true}, staff: {false, false, true}, news: {false, false, true}}},
		{"moderator", mod, map[int64]verdict{general: {true, true, true}, staff: {true, true, true}, news: {true, true, true}}},
		{"moderator with a user deny of MANAGE on one channel", denied, map[int64]verdict{general: {true, true, true}, staff: {false, false, true}, news: {true, true, true}}},
		{"administrator", admin.ID, map[int64]verdict{general: {true, true, true}, staff: {true, true, true}, news: {true, true, true}}},
	}
	for _, tc := range cases {
		user, err := database.GetUserByID(ctx, tc.userID)
		if err != nil || user == nil {
			t.Fatalf("%s: GetUserByID: %v", tc.name, err)
		}
		role, err := database.GetRoleForUser(ctx, tc.userID)
		if err != nil || role == nil {
			t.Fatalf("%s: GetRoleForUser: %v", tc.name, err)
		}
		msg, err := hub.BuildReadyWithRoleForTest(database, tc.userID, role)
		if err != nil {
			t.Fatalf("%s: BuildReadyWithRoleForTest: %v", tc.name, err)
		}
		var env struct {
			Payload struct {
				Channels   []map[string]any `json:"channels"`
				DMChannels []map[string]any `json:"dm_channels"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("%s: unmarshal: %v", tc.name, err)
		}
		seen := 0
		for _, ch := range env.Payload.Channels {
			id := int64(ch["id"].(float64))
			want, ok := tc.want[id]
			for _, key := range []string{"can_send", "can_moderate_voice", "can_delete_others", "can_pin", "can_react"} {
				if _, present := ch[key]; !present {
					t.Errorf("%s: channel %v missing %s", tc.name, ch["name"], key)
				}
			}
			if !ok {
				continue
			}
			seen++
			got := verdict{ch["can_delete_others"] == true, ch["can_pin"] == true, ch["can_react"] == true}
			if got != want {
				t.Errorf("%s: channel %v (del, pin, react) = %+v, want %+v", tc.name, ch["name"], got, want)
			}
		}
		if seen != len(tc.want) {
			t.Errorf("%s: saw %d of %d expected channels", tc.name, seen, len(tc.want))
		}
		if tc.userID == member {
			if len(env.Payload.DMChannels) == 0 {
				t.Fatalf("%s: expected an open DM in dm_channels", tc.name)
			}
			for _, dm := range env.Payload.DMChannels {
				for _, key := range []string{"can_send", "can_moderate_voice", "can_delete_others", "can_pin", "can_react"} {
					if _, present := dm[key]; present {
						t.Errorf("%s: dm_channels entry carries %s", tc.name, key)
					}
				}
			}
		}
	}
}
