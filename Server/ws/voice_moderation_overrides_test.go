package ws_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
)

// TestVoiceMod_ChannelOverridesApply locks SEC-02's server half: the actor's
// authority is their EFFECTIVE permission in the target's channel
// (permissions.CanModerateVoice), so a role-layer or user-layer deny of
// MUTE_MEMBERS on that channel refuses the action even though the base role
// holds the bit, and a channel the actor cannot see (READ_MESSAGES denied)
// cannot be moderated either. Administrator keeps its bypass.
func TestVoiceMod_ChannelOverridesApply(t *testing.T) {
	cases := []struct {
		name      string
		actorRole int // 2 Admin: MUTE_MEMBERS without ADMINISTRATOR; 1 Owner: ADMINISTRATOR
		roleDeny  int64
		userDeny  int64
		wantCode  string // "" = allowed (target ends up server-muted)
	}{
		{"no override: allowed", 2, 0, 0, ""},
		{"role deny MUTE_MEMBERS in this channel", 2, permissions.MuteMembers, 0, "FORBIDDEN"},
		{"user deny MUTE_MEMBERS in this channel", 2, 0, permissions.MuteMembers, "FORBIDDEN"},
		{"role deny READ_MESSAGES: hidden channel", 2, permissions.ReadMessages, 0, "FORBIDDEN"},
		{"administrator bypasses the deny", 1, permissions.MuteMembers, permissions.MuteMembers, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub, database := newVoiceModHub(t)
			chanID := seedVoiceChan(t, database, "vc-override")
			actor := seedVoiceUserWithRole(t, database, "mod-override", tc.actorRole)
			target := seedVoiceUserWithRole(t, database, "target-override", 4) // Member
			ctx := context.Background()
			if err := database.UpsertChannelOverride(ctx, chanID, int64(tc.actorRole), 0, tc.roleDeny); err != nil {
				t.Fatalf("UpsertChannelOverride: %v", err)
			}
			if err := database.UpsertChannelUserOverride(ctx, chanID, actor.ID, 0, tc.userDeny); err != nil {
				t.Fatalf("UpsertChannelUserOverride: %v", err)
			}

			joinVoice(t, hub, target, chanID)

			send := make(chan []byte, 16)
			c := ws.NewTestClientWithUser(hub, actor, chanID, send)
			hub.Register(c)
			waitRegistered(t, hub, c)

			hub.HandleMessageForTest(c, voiceModMuteMsg(chanID, target.ID, true))

			state, err := database.GetVoiceState(ctx, target.ID)
			if err != nil || state == nil {
				t.Fatalf("GetVoiceState: state=%v err=%v", state, err)
			}
			if tc.wantCode == "" {
				if !state.ServerMuted {
					t.Fatal("expected the target to be server muted")
				}
				return
			}
			if code := receiveErrorCode(send, waitTimeout); code != tc.wantCode {
				t.Fatalf("error code = %q, want %s", code, tc.wantCode)
			}
			if state.ServerMuted {
				t.Fatal("target must not be server muted after a refused action")
			}
		})
	}
}
