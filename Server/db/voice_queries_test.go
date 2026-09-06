package db_test

import (
	"context"
	"testing"
	"testing/fstest"

	"github.com/J3vb/OwnCord/Server/db"
)

var channelSchema = []byte(`
CREATE TABLE IF NOT EXISTS channels (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    type            TEXT    NOT NULL DEFAULT 'text',
    category        TEXT,
    topic           TEXT,
    position        INTEGER NOT NULL DEFAULT 0,
    slow_mode       INTEGER NOT NULL DEFAULT 0,
    archived        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    voice_max_users INTEGER NOT NULL DEFAULT 0,
    voice_quality   TEXT,
    mixing_threshold INTEGER,
    voice_max_video INTEGER NOT NULL DEFAULT 10,
    nsfw            INTEGER NOT NULL DEFAULT 0,
    is_group         INTEGER NOT NULL DEFAULT 0
);
`)

// newVoiceTestDB opens an in-memory DB with users, channels, and voice_states.
func newVoiceTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql":   {Data: testSchema},
		"002_channels.sql": {Data: channelSchema},
		"003_voice.sql": {Data: []byte(`
CREATE TABLE IF NOT EXISTS voice_states (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted       INTEGER NOT NULL DEFAULT 0,
    deafened    INTEGER NOT NULL DEFAULT 0,
    speaking    INTEGER NOT NULL DEFAULT 0,
    camera      INTEGER NOT NULL DEFAULT 0,
    screenshare INTEGER NOT NULL DEFAULT 0,
    server_muted    INTEGER NOT NULL DEFAULT 0,
    server_deafened INTEGER NOT NULL DEFAULT 0,
    joined_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_states_channel ON voice_states(channel_id);
`)},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// seedVoiceUser creates a user and returns its ID.
func seedVoiceUser(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	id, err := database.CreateUser(context.Background(), username, "hash", 4)
	if err != nil {
		t.Fatalf("seedVoiceUser: %v", err)
	}
	return id
}

// seedVoiceChannel creates a voice-type channel and returns its ID.
func seedVoiceChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	id, err := database.CreateChannel(context.Background(), name, "voice", "", "", 0)
	if err != nil {
		t.Fatalf("seedVoiceChannel: %v", err)
	}
	return id
}

// ─── JoinVoiceChannel ─────────────────────────────────────────────────────────

func TestVoice_JoinVoiceChannel_Success(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "alice")
	chanID := seedVoiceChannel(t, database, "general-voice")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	state, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil {
		t.Fatal("GetVoiceState returned nil after join")
	}
	if state.UserID != userID {
		t.Errorf("UserID = %d, want %d", state.UserID, userID)
	}
	if state.ChannelID != chanID {
		t.Errorf("ChannelID = %d, want %d", state.ChannelID, chanID)
	}
	if state.Muted {
		t.Error("Muted = true after join, want false")
	}
	if state.Deafened {
		t.Error("Deafened = true after join, want false")
	}
}

func TestVoice_JoinVoiceChannel_ReplacesExistingState(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "bob")
	chan1 := seedVoiceChannel(t, database, "voice-1")
	chan2 := seedVoiceChannel(t, database, "voice-2")

	if err := database.JoinVoiceChannel(context.Background(), userID, chan1); err != nil {
		t.Fatalf("first JoinVoiceChannel: %v", err)
	}
	// Join a different channel — should replace the old state.
	if err := database.JoinVoiceChannel(context.Background(), userID, chan2); err != nil {
		t.Fatalf("second JoinVoiceChannel: %v", err)
	}

	state, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil {
		t.Fatal("GetVoiceState returned nil after re-join")
	}
	if state.ChannelID != chan2 {
		t.Errorf("ChannelID = %d, want %d (new channel)", state.ChannelID, chan2)
	}
}

func TestVoice_JoinVoiceChannel_SameChannel_Idempotent(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "carol")
	chanID := seedVoiceChannel(t, database, "voice-same")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("first join: %v", err)
	}
	// Joining same channel again should not error.
	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("second join same channel: %v", err)
	}
}

// ─── LeaveVoiceChannel ────────────────────────────────────────────────────────

func TestVoice_LeaveVoiceChannel_ClearsState(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "dave")
	chanID := seedVoiceChannel(t, database, "voice-leave")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.LeaveVoiceChannel(context.Background(), userID); err != nil {
		t.Fatalf("LeaveVoiceChannel: %v", err)
	}

	state, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState after leave: %v", err)
	}
	if state != nil {
		t.Error("GetVoiceState returned non-nil after leave, want nil")
	}
}

func TestVoice_LeaveVoiceChannel_NoState_NoError(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "eve")

	// Leaving when not in any channel should not error.
	if err := database.LeaveVoiceChannel(context.Background(), userID); err != nil {
		t.Fatalf("LeaveVoiceChannel (not in channel): %v", err)
	}
}

// ─── GetVoiceState ────────────────────────────────────────────────────────────

func TestVoice_GetVoiceState_NotFound(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "frank")

	state, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState(not found): %v", err)
	}
	if state != nil {
		t.Error("GetVoiceState returned non-nil for user not in voice")
	}
}

func TestVoice_GetVoiceState_IncludesUsername(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "grace")
	chanID := seedVoiceChannel(t, database, "voice-username")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	state, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil {
		t.Fatal("GetVoiceState returned nil")
	}
	if state.Username != "grace" {
		t.Errorf("Username = %q, want %q", state.Username, "grace")
	}
}

// ─── GetChannelVoiceStates ────────────────────────────────────────────────────

func TestVoice_GetChannelVoiceStates_Empty(t *testing.T) {
	database := newVoiceTestDB(t)
	chanID := seedVoiceChannel(t, database, "empty-voice")

	states, err := database.GetChannelVoiceStates(context.Background(), chanID)
	if err != nil {
		t.Fatalf("GetChannelVoiceStates: %v", err)
	}
	if len(states) != 0 {
		t.Errorf("got %d states, want 0", len(states))
	}
}

func TestVoice_GetChannelVoiceStates_MultipleUsers(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "henry")
	u2 := seedVoiceUser(t, database, "iris")
	u3 := seedVoiceUser(t, database, "jack")
	chanID := seedVoiceChannel(t, database, "multi-voice")
	otherChan := seedVoiceChannel(t, database, "other-voice")

	if err := database.JoinVoiceChannel(context.Background(), u1, chanID); err != nil {
		t.Fatalf("join u1: %v", err)
	}
	if err := database.JoinVoiceChannel(context.Background(), u2, chanID); err != nil {
		t.Fatalf("join u2: %v", err)
	}
	// u3 joins a different channel — should not appear.
	if err := database.JoinVoiceChannel(context.Background(), u3, otherChan); err != nil {
		t.Fatalf("join u3: %v", err)
	}

	states, err := database.GetChannelVoiceStates(context.Background(), chanID)
	if err != nil {
		t.Fatalf("GetChannelVoiceStates: %v", err)
	}
	if len(states) != 2 {
		t.Errorf("got %d states, want 2", len(states))
	}

	ids := map[int64]bool{u1: true, u2: true}
	for _, s := range states {
		if !ids[s.UserID] {
			t.Errorf("unexpected user_id %d in channel states", s.UserID)
		}
	}
}

// ─── UpdateVoiceMute ──────────────────────────────────────────────────────────

func TestVoice_UpdateVoiceMute_True(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "kate")
	chanID := seedVoiceChannel(t, database, "voice-mute")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceMute(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceMute(true): %v", err)
	}

	state, _ := database.GetVoiceState(context.Background(), userID)
	if state == nil || !state.Muted {
		t.Error("Muted = false after UpdateVoiceMute(true)")
	}
}

func TestVoice_UpdateVoiceMute_False(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "leo")
	chanID := seedVoiceChannel(t, database, "voice-unmute")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceMute(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceMute(true): %v", err)
	}
	if err := database.UpdateVoiceMute(context.Background(), userID, false); err != nil {
		t.Fatalf("UpdateVoiceMute(false): %v", err)
	}

	state, _ := database.GetVoiceState(context.Background(), userID)
	if state == nil || state.Muted {
		t.Error("Muted = true after UpdateVoiceMute(false), want false")
	}
}

func TestVoice_UpdateVoiceMute_NotInChannel_NoError(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "mia")

	// Muting when not in a channel should not error.
	if err := database.UpdateVoiceMute(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceMute for non-member: %v", err)
	}
}

// ─── UpdateVoiceDeafen ────────────────────────────────────────────────────────

func TestVoice_UpdateVoiceDeafen_True(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "noah")
	chanID := seedVoiceChannel(t, database, "voice-deafen")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceDeafen(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceDeafen(true): %v", err)
	}

	state, _ := database.GetVoiceState(context.Background(), userID)
	if state == nil || !state.Deafened {
		t.Error("Deafened = false after UpdateVoiceDeafen(true)")
	}
}

func TestVoice_UpdateVoiceDeafen_False(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "olivia")
	chanID := seedVoiceChannel(t, database, "voice-undeafen")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceDeafen(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceDeafen(true): %v", err)
	}
	if err := database.UpdateVoiceDeafen(context.Background(), userID, false); err != nil {
		t.Fatalf("UpdateVoiceDeafen(false): %v", err)
	}

	state, _ := database.GetVoiceState(context.Background(), userID)
	if state == nil || state.Deafened {
		t.Error("Deafened = true after UpdateVoiceDeafen(false), want false")
	}
}

// ─── ClearVoiceState ──────────────────────────────────────────────────────────

func TestVoice_ClearVoiceState_RemovesState(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "pedro")
	chanID := seedVoiceChannel(t, database, "voice-clear")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.ClearVoiceState(context.Background(), userID); err != nil {
		t.Fatalf("ClearVoiceState: %v", err)
	}

	state, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState after clear: %v", err)
	}
	if state != nil {
		t.Error("GetVoiceState returned non-nil after ClearVoiceState")
	}
}

func TestVoice_ClearVoiceState_NotInChannel_NoError(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "quinn")

	if err := database.ClearVoiceState(context.Background(), userID); err != nil {
		t.Fatalf("ClearVoiceState for non-member: %v", err)
	}
}

// ─── Cascade delete ───────────────────────────────────────────────────────────

func TestVoice_GetChannelVoiceStates_IncludesUsername(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "rachel")
	chanID := seedVoiceChannel(t, database, "voice-name-check")

	if err := database.JoinVoiceChannel(context.Background(), u1, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	states, err := database.GetChannelVoiceStates(context.Background(), chanID)
	if err != nil {
		t.Fatalf("GetChannelVoiceStates: %v", err)
	}
	if len(states) != 1 {
		t.Fatalf("got %d states, want 1", len(states))
	}
	if states[0].Username != "rachel" {
		t.Errorf("Username = %q, want %q", states[0].Username, "rachel")
	}
}

// ─── UpdateVoiceCamera ────────────────────────────────────────────────────────

func TestVoice_UpdateVoiceCamera_True(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "cam-on")
	chanID := seedVoiceChannel(t, database, "voice-camera")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceCamera(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceCamera(true): %v", err)
	}

	state, _ := database.GetVoiceState(context.Background(), userID)
	if state == nil || !state.Camera {
		t.Error("Camera = false after UpdateVoiceCamera(true)")
	}
}

func TestVoice_UpdateVoiceCamera_False(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "cam-off")
	chanID := seedVoiceChannel(t, database, "voice-camera-off")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceCamera(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceCamera(true): %v", err)
	}
	if err := database.UpdateVoiceCamera(context.Background(), userID, false); err != nil {
		t.Fatalf("UpdateVoiceCamera(false): %v", err)
	}

	state, _ := database.GetVoiceState(context.Background(), userID)
	if state == nil || state.Camera {
		t.Error("Camera = true after UpdateVoiceCamera(false), want false")
	}
}

func TestVoice_UpdateVoiceCamera_NotInChannel_NoError(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "cam-noop")

	if err := database.UpdateVoiceCamera(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceCamera for non-member: %v", err)
	}
}

// ─── UpdateVoiceScreenshare ──────────────────────────────────────────────────

func TestVoice_UpdateVoiceScreenshare_True(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "share-on")
	chanID := seedVoiceChannel(t, database, "voice-screen")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceScreenshare(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceScreenshare(true): %v", err)
	}

	state, _ := database.GetVoiceState(context.Background(), userID)
	if state == nil || !state.Screenshare {
		t.Error("Screenshare = false after UpdateVoiceScreenshare(true)")
	}
}

func TestVoice_UpdateVoiceScreenshare_False(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "share-off")
	chanID := seedVoiceChannel(t, database, "voice-screen-off")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceScreenshare(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceScreenshare(true): %v", err)
	}
	if err := database.UpdateVoiceScreenshare(context.Background(), userID, false); err != nil {
		t.Fatalf("UpdateVoiceScreenshare(false): %v", err)
	}

	state, _ := database.GetVoiceState(context.Background(), userID)
	if state == nil || state.Screenshare {
		t.Error("Screenshare = true after UpdateVoiceScreenshare(false), want false")
	}
}

// ─── CountChannelVoiceUsers ──────────────────────────────────────────────────

func TestVoice_CountChannelVoiceUsers_Empty(t *testing.T) {
	database := newVoiceTestDB(t)
	chanID := seedVoiceChannel(t, database, "count-empty")

	count, err := database.CountChannelVoiceUsers(context.Background(), chanID)
	if err != nil {
		t.Fatalf("CountChannelVoiceUsers: %v", err)
	}
	if count != 0 {
		t.Errorf("count = %d, want 0", count)
	}
}

func TestVoice_CountChannelVoiceUsers_Multiple(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "count1")
	u2 := seedVoiceUser(t, database, "count2")
	u3 := seedVoiceUser(t, database, "count3")
	chanID := seedVoiceChannel(t, database, "count-multi")
	otherChan := seedVoiceChannel(t, database, "count-other")

	if err := database.JoinVoiceChannel(context.Background(), u1, chanID); err != nil {
		t.Fatalf("join u1: %v", err)
	}
	if err := database.JoinVoiceChannel(context.Background(), u2, chanID); err != nil {
		t.Fatalf("join u2: %v", err)
	}
	// u3 joins a different channel — should not be counted.
	if err := database.JoinVoiceChannel(context.Background(), u3, otherChan); err != nil {
		t.Fatalf("join u3: %v", err)
	}

	count, err := database.CountChannelVoiceUsers(context.Background(), chanID)
	if err != nil {
		t.Fatalf("CountChannelVoiceUsers: %v", err)
	}
	if count != 2 {
		t.Errorf("count = %d, want 2", count)
	}
}

// ─── ClearAllVoiceStates ─────────────────────────────────────────────────────

func TestVoice_ClearAllVoiceStates_RemovesAll(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "clear1")
	u2 := seedVoiceUser(t, database, "clear2")
	chan1 := seedVoiceChannel(t, database, "clear-ch1")
	chan2 := seedVoiceChannel(t, database, "clear-ch2")

	if err := database.JoinVoiceChannel(context.Background(), u1, chan1); err != nil {
		t.Fatalf("join u1: %v", err)
	}
	if err := database.JoinVoiceChannel(context.Background(), u2, chan2); err != nil {
		t.Fatalf("join u2: %v", err)
	}

	if err := database.ClearAllVoiceStates(context.Background()); err != nil {
		t.Fatalf("ClearAllVoiceStates: %v", err)
	}

	s1, _ := database.GetVoiceState(context.Background(), u1)
	s2, _ := database.GetVoiceState(context.Background(), u2)
	if s1 != nil || s2 != nil {
		t.Error("voice states still exist after ClearAllVoiceStates")
	}
}

func TestVoice_ClearAllVoiceStates_EmptyTable_NoError(t *testing.T) {
	database := newVoiceTestDB(t)

	if err := database.ClearAllVoiceStates(context.Background()); err != nil {
		t.Fatalf("ClearAllVoiceStates on empty table: %v", err)
	}
}

// ─── JoinVoiceChannel resets camera/screenshare ──────────────────────────────

func TestVoice_JoinVoiceChannel_ResetsCameraAndScreenshare(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "reset-av")
	chan1 := seedVoiceChannel(t, database, "voice-reset1")
	chan2 := seedVoiceChannel(t, database, "voice-reset2")

	// Join, enable camera and screenshare.
	if err := database.JoinVoiceChannel(context.Background(), userID, chan1); err != nil {
		t.Fatalf("first join: %v", err)
	}
	if err := database.UpdateVoiceCamera(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceCamera: %v", err)
	}
	if err := database.UpdateVoiceScreenshare(context.Background(), userID, true); err != nil {
		t.Fatalf("UpdateVoiceScreenshare: %v", err)
	}

	// Join a different channel — camera and screenshare should be reset.
	if err := database.JoinVoiceChannel(context.Background(), userID, chan2); err != nil {
		t.Fatalf("second join: %v", err)
	}

	state, _ := database.GetVoiceState(context.Background(), userID)
	if state == nil {
		t.Fatal("GetVoiceState returned nil after re-join")
	}
	if state.Camera {
		t.Error("Camera should be reset to false on re-join")
	}
	if state.Screenshare {
		t.Error("Screenshare should be reset to false on re-join")
	}
}

// ─── Camera/Screenshare in GetVoiceState ─────────────────────────────────────

func TestVoice_GetVoiceState_IncludesCameraAndScreenshare(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "av-fields")
	chanID := seedVoiceChannel(t, database, "voice-av-fields")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	// Initially both should be false.
	state, _ := database.GetVoiceState(context.Background(), userID)
	if state == nil {
		t.Fatal("GetVoiceState returned nil")
	}
	if state.Camera {
		t.Error("Camera should be false after join")
	}
	if state.Screenshare {
		t.Error("Screenshare should be false after join")
	}

	// Enable both.
	_ = database.UpdateVoiceCamera(context.Background(), userID, true)
	_ = database.UpdateVoiceScreenshare(context.Background(), userID, true)

	state, _ = database.GetVoiceState(context.Background(), userID)
	if state == nil {
		t.Fatal("GetVoiceState returned nil after update")
	}
	if !state.Camera {
		t.Error("Camera should be true after UpdateVoiceCamera(true)")
	}
	if !state.Screenshare {
		t.Error("Screenshare should be true after UpdateVoiceScreenshare(true)")
	}
}

// ─── Camera/Screenshare in GetChannelVoiceStates ─────────────────────────────

func TestVoice_GetChannelVoiceStates_IncludesCameraAndScreenshare(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "chan-av")
	chanID := seedVoiceChannel(t, database, "voice-chan-av")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	_ = database.UpdateVoiceCamera(context.Background(), userID, true)

	states, err := database.GetChannelVoiceStates(context.Background(), chanID)
	if err != nil {
		t.Fatalf("GetChannelVoiceStates: %v", err)
	}
	if len(states) != 1 {
		t.Fatalf("got %d states, want 1", len(states))
	}
	if !states[0].Camera {
		t.Error("Camera should be true in GetChannelVoiceStates")
	}
	if states[0].Screenshare {
		t.Error("Screenshare should be false in GetChannelVoiceStates")
	}
}

func TestVoice_JoinVoiceChannel_SameChannel_RefreshesJoinToken(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "same-channel-token")
	chanID := seedVoiceChannel(t, database, "voice-same-token")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("first JoinVoiceChannel: %v", err)
	}
	first, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState(first): %v", err)
	}
	if first == nil || first.JoinedAt == "" {
		t.Fatal("first join token missing")
	}

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("second JoinVoiceChannel: %v", err)
	}
	second, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState(second): %v", err)
	}
	if second == nil || second.JoinedAt == "" {
		t.Fatal("second join token missing")
	}
	if second.JoinedAt == first.JoinedAt {
		t.Fatalf("same-channel rejoin reused join token %q", second.JoinedAt)
	}
}

func TestVoice_LeaveVoiceChannelIfMatch_DoesNotDeleteSameChannelRejoin(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "stale-delete")
	chanID := seedVoiceChannel(t, database, "voice-stale-delete")

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("first JoinVoiceChannel: %v", err)
	}
	first, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState(first): %v", err)
	}
	if first == nil {
		t.Fatal("GetVoiceState(first) returned nil")
	}

	if err := database.JoinVoiceChannel(context.Background(), userID, chanID); err != nil {
		t.Fatalf("second JoinVoiceChannel: %v", err)
	}
	second, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState(second): %v", err)
	}
	if second == nil {
		t.Fatal("GetVoiceState(second) returned nil")
	}

	deleted, err := database.LeaveVoiceChannelIfMatch(context.Background(), userID, chanID, first.JoinedAt)
	if err != nil {
		t.Fatalf("LeaveVoiceChannelIfMatch: %v", err)
	}
	if deleted {
		t.Fatal("stale join token deleted the replacement same-channel row")
	}

	current, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState(current): %v", err)
	}
	if current == nil {
		t.Fatal("replacement voice state was removed")
	}
	if current.JoinedAt != second.JoinedAt {
		t.Fatalf("replacement join token = %q, want %q", current.JoinedAt, second.JoinedAt)
	}
}

// ─── SetVoiceServerMute / SetVoiceServerDeafen scoping (OC-0005) ────────────
//
// ApplyVoiceServerMute/ClearVoiceServerMute and their deafen equivalents
// match on `WHERE user_id = ?` alone. A moderator's mute/deafen command is
// authorized against a channel snapshot (voiceModTarget + requireTargetInChannel
// in ws/voice_moderation.go), but the DB write that follows several round
// trips later is not scoped to that channel: if the target's voice_states row
// has since moved to a different channel — including a DM call the moderator
// was never authorized against — the unscoped write still lands on it.

func TestVoice_SetVoiceServerMute_ScopedToChannel(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "scope-mute-user")
	chanA := seedVoiceChannel(t, database, "vc-scope-mute-a")
	chanB := seedVoiceChannel(t, database, "vc-scope-mute-b")

	if err := database.JoinVoiceChannel(ctx, userID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel A: %v", err)
	}
	// Simulate the race: the user's row moves to channel B — a channel nobody's
	// mute command was authorized against — before the write below lands.
	if err := database.JoinVoiceChannel(ctx, userID, chanB); err != nil {
		t.Fatalf("JoinVoiceChannel B: %v", err)
	}

	// A mute authorized against chanA (the channel a stale requireTargetInChannel
	// snapshot showed) must not land on the row now in chanB.
	matched, err := database.SetVoiceServerMute(ctx, userID, chanA, true)
	if err != nil {
		t.Fatalf("SetVoiceServerMute: %v", err)
	}
	if matched {
		t.Error("SetVoiceServerMute matched=true against channel A after the user moved to channel B")
	}

	state, err := database.GetVoiceState(ctx, userID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state.ChannelID != chanB {
		t.Fatalf("test setup broken: want user in channel B, got %d", state.ChannelID)
	}
	if state.ServerMuted {
		t.Error("ServerMuted = true, want false: an unscoped write must not follow the user to a channel nobody authorized the mute against")
	}

	// The scoped write must still succeed when the channel does match.
	matched, err = database.SetVoiceServerMute(ctx, userID, chanB, true)
	if err != nil {
		t.Fatalf("SetVoiceServerMute (matching channel): %v", err)
	}
	if !matched {
		t.Error("SetVoiceServerMute matched=false for the channel the user is actually in")
	}
	state, err = database.GetVoiceState(ctx, userID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if !state.ServerMuted {
		t.Error("ServerMuted = false, want true: a scoped write against the correct channel must still apply")
	}
}

func TestVoice_SetVoiceServerDeafen_ScopedToChannel(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "scope-deafen-user")
	chanA := seedVoiceChannel(t, database, "vc-scope-deafen-a")
	chanB := seedVoiceChannel(t, database, "vc-scope-deafen-b")

	if err := database.JoinVoiceChannel(ctx, userID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel A: %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, userID, chanB); err != nil {
		t.Fatalf("JoinVoiceChannel B: %v", err)
	}

	matched, err := database.SetVoiceServerDeafen(ctx, userID, chanA, true)
	if err != nil {
		t.Fatalf("SetVoiceServerDeafen: %v", err)
	}
	if matched {
		t.Error("SetVoiceServerDeafen matched=true against channel A after the user moved to channel B")
	}

	state, err := database.GetVoiceState(ctx, userID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state.ChannelID != chanB {
		t.Fatalf("test setup broken: want user in channel B, got %d", state.ChannelID)
	}
	if state.ServerDeafened {
		t.Error("ServerDeafened = true, want false: an unscoped write must not follow the user to a channel nobody authorized the deafen against")
	}

	matched, err = database.SetVoiceServerDeafen(ctx, userID, chanB, true)
	if err != nil {
		t.Fatalf("SetVoiceServerDeafen (matching channel): %v", err)
	}
	if !matched {
		t.Error("SetVoiceServerDeafen matched=false for the channel the user is actually in")
	}
	state, err = database.GetVoiceState(ctx, userID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if !state.ServerDeafened {
		t.Error("ServerDeafened = false, want true: a scoped write against the correct channel must still apply")
	}
}

// ─── CompareAndSetServerMute (P1-3/P1-4 PARTIAL) ────────────────────────────

// TestVoice_CompareAndSetServerMute_ChannelMismatch is TestVoice_
// SetVoiceServerMute_ScopedToChannel's twin for the timeout voice half's
// stricter, session-scoped compare-and-mute: a write authorized against the
// channel a stale read showed must not follow the user to wherever they
// moved next.
func TestVoice_CompareAndSetServerMute_ChannelMismatch(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "cas-mismatch-user")
	chanA := seedVoiceChannel(t, database, "vc-cas-mismatch-a")
	chanB := seedVoiceChannel(t, database, "vc-cas-mismatch-b")

	if err := database.JoinVoiceChannel(ctx, userID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel A: %v", err)
	}
	stale, err := database.GetVoiceState(ctx, userID)
	if err != nil || stale == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	// The user moves to channel B — an authorization against channel A must
	// not follow them there.
	if err := database.JoinVoiceChannel(ctx, userID, chanB); err != nil {
		t.Fatalf("JoinVoiceChannel B: %v", err)
	}

	matched, transitioned, err := database.CompareAndSetServerMute(ctx, userID, chanA, stale.JoinedAt, true)
	if err != nil {
		t.Fatalf("CompareAndSetServerMute: %v", err)
	}
	if matched || transitioned {
		t.Fatalf("matched=%v transitioned=%v, want both false: the session moved to channel B", matched, transitioned)
	}
	state, err := database.GetVoiceState(ctx, userID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state.ServerMuted {
		t.Error("ServerMuted = true, want false: an unscoped write must not follow the user to an unauthorized channel")
	}
}

// TestVoice_CompareAndSetServerMute_JoinedAtMismatch is the same guard for a
// leave-and-rejoin of the SAME channel — the join-instance token
// (JoinVoiceChannel's joined_at) changes even though channel_id does not,
// which SetVoiceServerMute's own channel-only scoping would miss.
func TestVoice_CompareAndSetServerMute_JoinedAtMismatch(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "cas-rejoin-user")
	chanA := seedVoiceChannel(t, database, "vc-cas-rejoin-a")

	if err := database.JoinVoiceChannel(ctx, userID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel (first): %v", err)
	}
	stale, err := database.GetVoiceState(ctx, userID)
	if err != nil || stale == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	// Leave and rejoin the SAME channel — a new join-instance token.
	if err := database.LeaveVoiceChannel(ctx, userID); err != nil {
		t.Fatalf("LeaveVoiceChannel: %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, userID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel (rejoin): %v", err)
	}
	fresh, err := database.GetVoiceState(ctx, userID)
	if err != nil || fresh == nil {
		t.Fatalf("GetVoiceState (after rejoin): %v", err)
	}
	if fresh.JoinedAt == stale.JoinedAt {
		t.Fatal("test setup broken: rejoin produced the same joined_at token")
	}

	matched, _, err := database.CompareAndSetServerMute(ctx, userID, chanA, stale.JoinedAt, true)
	if err != nil {
		t.Fatalf("CompareAndSetServerMute: %v", err)
	}
	if matched {
		t.Fatal("matched = true, want false: the stale join instance is gone, even though the channel matches")
	}
}

// TestVoice_CompareAndSetServerMute_Transitioned proves ownership (P1-4
// PARTIAL): a genuine unmuted->muted transition reports transitioned=true;
// muting a target ALREADY server-muted reports transitioned=false — the
// caller does not own a mute someone/something else already set.
func TestVoice_CompareAndSetServerMute_Transitioned(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "cas-transition-user")
	chanA := seedVoiceChannel(t, database, "vc-cas-transition-a")

	if err := database.JoinVoiceChannel(ctx, userID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	state, err := database.GetVoiceState(ctx, userID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}

	matched, transitioned, err := database.CompareAndSetServerMute(ctx, userID, chanA, state.JoinedAt, true)
	if err != nil {
		t.Fatalf("CompareAndSetServerMute (first mute): %v", err)
	}
	if !matched || !transitioned {
		t.Fatalf("matched=%v transitioned=%v, want both true: the first mute is a genuine unmuted->muted transition", matched, transitioned)
	}

	// Muting an already-muted target: matched, but NOT owned.
	matched, transitioned, err = database.CompareAndSetServerMute(ctx, userID, chanA, state.JoinedAt, true)
	if err != nil {
		t.Fatalf("CompareAndSetServerMute (already muted): %v", err)
	}
	if !matched {
		t.Fatal("matched = false, want true: the session is still live and in the right channel")
	}
	if transitioned {
		t.Fatal("transitioned = true, want false: the target was already server-muted — this call does not own that mute")
	}

	// Unmuting is never reported as "transitioned" (that flag is muted=true
	// only); it still applies.
	matched, transitioned, err = database.CompareAndSetServerMute(ctx, userID, chanA, state.JoinedAt, false)
	if err != nil {
		t.Fatalf("CompareAndSetServerMute (unmute): %v", err)
	}
	if !matched || transitioned {
		t.Fatalf("matched=%v transitioned=%v, want matched=true transitioned=false for an unmute", matched, transitioned)
	}
	final, err := database.GetVoiceState(ctx, userID)
	if err != nil || final == nil {
		t.Fatalf("GetVoiceState (final): %v", err)
	}
	if final.ServerMuted {
		t.Error("ServerMuted = true, want false after the unmute")
	}
}

// TestVoice_CompareAndSetServerMute_NoSession is the no-such-row case: never
// joined, or already left entirely.
func TestVoice_CompareAndSetServerMute_NoSession(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "cas-nosession-user")
	chanA := seedVoiceChannel(t, database, "vc-cas-nosession-a")

	matched, transitioned, err := database.CompareAndSetServerMute(ctx, userID, chanA, "no-such-join-token", true)
	if err != nil {
		t.Fatalf("CompareAndSetServerMute: %v", err)
	}
	if matched || transitioned {
		t.Fatalf("matched=%v transitioned=%v, want both false: no such session", matched, transitioned)
	}
}
