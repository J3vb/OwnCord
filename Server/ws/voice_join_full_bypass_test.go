package ws_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
)

// voiceModRoleID is a role seeded with the voice-moderator bits:
// CONNECT_VOICE and READ_MESSAGES to join, MUTE_MEMBERS to moderate voice. The
// default Moderator role (id 3) does not hold MUTE_MEMBERS, so it is not used.
const voiceModRoleID = int64(20)

// seedVoiceModerator creates a user in a role holding MUTE_MEMBERS: the
// voice-moderator authority that joins past voice_max_users.
func seedVoiceModerator(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, permissions, position, is_default)
		 VALUES (?, 'voice-mod', ?, 50, 0)
		 ON CONFLICT(id) DO NOTHING`,
		voiceModRoleID, permissions.ConnectVoice|permissions.ReadMessages|permissions.MuteMembers,
	); err != nil {
		t.Fatalf("seedVoiceModerator role: %v", err)
	}
	if _, err := database.CreateUser(context.Background(), username, "hash", int(voiceModRoleID)); err != nil {
		t.Fatalf("seedVoiceModerator CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || user == nil {
		t.Fatalf("seedVoiceModerator GetUserByUsername: %v", err)
	}
	return user
}

// fillVoiceChannel joins a fresh Member into chanID so a max-1 channel is full.
func fillVoiceChannel(t *testing.T, hub *ws.Hub, database *db.DB, chanID int64, username string) {
	t.Helper()
	filler := seedVoiceMember(t, database, username)
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, filler, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	drainChanTimeout(send, 30*time.Millisecond)
	if st, err := database.GetVoiceState(context.Background(), filler.ID); err != nil || st == nil || st.ChannelID != chanID {
		t.Fatalf("filler not in channel %d: state=%+v err=%v", chanID, st, err)
	}
}

// joinAndExpectChannel sends voice_join for chanID and asserts the user's
// voice_states row ends up there with no error frame on the socket.
func joinAndExpectChannel(t *testing.T, hub *ws.Hub, database *db.DB, c *ws.Client, send chan []byte, userID, chanID int64) {
	t.Helper()
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	for _, m := range drainChanTimeout(send, 50*time.Millisecond) {
		if extractType(t, m) == "error" {
			t.Fatalf("join to channel %d answered with an error: %s", chanID, m)
		}
	}
	st, err := database.GetVoiceState(context.Background(), userID)
	if err != nil || st == nil || st.ChannelID != chanID {
		t.Fatalf("user %d not in channel %d after join: state=%+v err=%v", userID, chanID, st, err)
	}
}

// TestVoice_Join_FullChannel_ModeratorAdmitted: a member is refused a full
// channel (TestVoice_Join_ChannelFull), a voice moderator joins it anyway.
func TestVoice_Join_FullChannel_ModeratorAdmitted(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChanMaxUsers(t, database, "vc-full-mod", 1)
	fillVoiceChannel(t, hub, database, chanID, "full-mod-filler")

	mod := seedVoiceModerator(t, database, "full-mod")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, mod, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	joinAndExpectChannel(t, hub, database, c, send, mod.ID, chanID)
}

// TestVoice_Join_SwitchToFullChannel_ModeratorAdmitted: the switch pre-flight
// (OC-0351) holds a member in their old call, but lets a voice moderator
// through, and the moderator lands in the full channel.
func TestVoice_Join_SwitchToFullChannel_ModeratorAdmitted(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanA := seedVoiceChan(t, database, "vc-full-mod-a")
	chanB := seedVoiceChanMaxUsers(t, database, "vc-full-mod-b", 1)
	fillVoiceChannel(t, hub, database, chanB, "full-mod-switch-filler")

	mod := seedVoiceModerator(t, database, "full-mod-switcher")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, mod, chanA, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	joinAndExpectChannel(t, hub, database, c, send, mod.ID, chanA)

	joinAndExpectChannel(t, hub, database, c, send, mod.ID, chanB)
}

// TestVoice_Join_FullChannel_ModeratorDeniedInChannel: a channel override that
// denies MUTE_MEMBERS to the moderator's role takes the bypass away there, the
// same way it takes away voice moderation in that channel.
func TestVoice_Join_FullChannel_ModeratorDeniedInChannel(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChanMaxUsers(t, database, "vc-full-mod-deny", 1)
	mod := seedVoiceModerator(t, database, "full-mod-deny")
	if err := database.UpsertChannelOverride(context.Background(), chanID, voiceModRoleID, 0, permissions.MuteMembers); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	fillVoiceChannel(t, hub, database, chanID, "full-mod-deny-filler")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, mod, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	if code := drainForErrorCode(send, 300*time.Millisecond); code != "CHANNEL_FULL" {
		t.Fatalf("error code = %q, want CHANNEL_FULL", code)
	}
	if st, err := database.GetVoiceState(context.Background(), mod.ID); err != nil || st != nil {
		t.Fatalf("denied moderator should not be in voice: state=%+v err=%v", st, err)
	}
}
