package db_test

import (
	"testing"
	"testing/fstest"

	"github.com/owncord/server/db"
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
    voice_max_video INTEGER NOT NULL DEFAULT 10
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
	id, err := database.CreateUser(username, "hash", 4)
	if err != nil {
		t.Fatalf("seedVoiceUser: %v", err)
	}
	return id
}

// seedVoiceChannel creates a voice-type channel and returns its ID.
func seedVoiceChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	id, err := database.CreateChannel(name, "voice", "", "", 0)
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

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	state, err := database.GetVoiceState(userID)
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

	if err := database.JoinVoiceChannel(userID, chan1); err != nil {
		t.Fatalf("first JoinVoiceChannel: %v", err)
	}
	// Join a different channel — should replace the old state.
	if err := database.JoinVoiceChannel(userID, chan2); err != nil {
		t.Fatalf("second JoinVoiceChannel: %v", err)
	}

	state, err := database.GetVoiceState(userID)
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

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("first join: %v", err)
	}
	// Joining same channel again should not error.
	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("second join same channel: %v", err)
	}
}

// ─── LeaveVoiceChannel ────────────────────────────────────────────────────────

func TestVoice_LeaveVoiceChannel_ClearsState(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "dave")
	chanID := seedVoiceChannel(t, database, "voice-leave")

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.LeaveVoiceChannel(userID); err != nil {
		t.Fatalf("LeaveVoiceChannel: %v", err)
	}

	state, err := database.GetVoiceState(userID)
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
	if err := database.LeaveVoiceChannel(userID); err != nil {
		t.Fatalf("LeaveVoiceChannel (not in channel): %v", err)
	}
}

// ─── GetVoiceState ────────────────────────────────────────────────────────────

func TestVoice_GetVoiceState_NotFound(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "frank")

	state, err := database.GetVoiceState(userID)
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

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	state, err := database.GetVoiceState(userID)
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

	states, err := database.GetChannelVoiceStates(chanID)
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

	if err := database.JoinVoiceChannel(u1, chanID); err != nil {
		t.Fatalf("join u1: %v", err)
	}
	if err := database.JoinVoiceChannel(u2, chanID); err != nil {
		t.Fatalf("join u2: %v", err)
	}
	// u3 joins a different channel — should not appear.
	if err := database.JoinVoiceChannel(u3, otherChan); err != nil {
		t.Fatalf("join u3: %v", err)
	}

	states, err := database.GetChannelVoiceStates(chanID)
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

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceMute(userID, true); err != nil {
		t.Fatalf("UpdateVoiceMute(true): %v", err)
	}

	state, _ := database.GetVoiceState(userID)
	if state == nil || !state.Muted {
		t.Error("Muted = false after UpdateVoiceMute(true)")
	}
}

func TestVoice_UpdateVoiceMute_False(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "leo")
	chanID := seedVoiceChannel(t, database, "voice-unmute")

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceMute(userID, true); err != nil {
		t.Fatalf("UpdateVoiceMute(true): %v", err)
	}
	if err := database.UpdateVoiceMute(userID, false); err != nil {
		t.Fatalf("UpdateVoiceMute(false): %v", err)
	}

	state, _ := database.GetVoiceState(userID)
	if state == nil || state.Muted {
		t.Error("Muted = true after UpdateVoiceMute(false), want false")
	}
}

func TestVoice_UpdateVoiceMute_NotInChannel_NoError(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "mia")

	// Muting when not in a channel should not error.
	if err := database.UpdateVoiceMute(userID, true); err != nil {
		t.Fatalf("UpdateVoiceMute for non-member: %v", err)
	}
}

// ─── UpdateVoiceDeafen ────────────────────────────────────────────────────────

func TestVoice_UpdateVoiceDeafen_True(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "noah")
	chanID := seedVoiceChannel(t, database, "voice-deafen")

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceDeafen(userID, true); err != nil {
		t.Fatalf("UpdateVoiceDeafen(true): %v", err)
	}

	state, _ := database.GetVoiceState(userID)
	if state == nil || !state.Deafened {
		t.Error("Deafened = false after UpdateVoiceDeafen(true)")
	}
}

func TestVoice_UpdateVoiceDeafen_False(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "olivia")
	chanID := seedVoiceChannel(t, database, "voice-undeafen")

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceDeafen(userID, true); err != nil {
		t.Fatalf("UpdateVoiceDeafen(true): %v", err)
	}
	if err := database.UpdateVoiceDeafen(userID, false); err != nil {
		t.Fatalf("UpdateVoiceDeafen(false): %v", err)
	}

	state, _ := database.GetVoiceState(userID)
	if state == nil || state.Deafened {
		t.Error("Deafened = true after UpdateVoiceDeafen(false), want false")
	}
}

// ─── ClearVoiceState ──────────────────────────────────────────────────────────

func TestVoice_ClearVoiceState_RemovesState(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "pedro")
	chanID := seedVoiceChannel(t, database, "voice-clear")

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.ClearVoiceState(userID); err != nil {
		t.Fatalf("ClearVoiceState: %v", err)
	}

	state, err := database.GetVoiceState(userID)
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

	if err := database.ClearVoiceState(userID); err != nil {
		t.Fatalf("ClearVoiceState for non-member: %v", err)
	}
}

// ─── Cascade delete ───────────────────────────────────────────────────────────

func TestVoice_GetChannelVoiceStates_IncludesUsername(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "rachel")
	chanID := seedVoiceChannel(t, database, "voice-name-check")

	if err := database.JoinVoiceChannel(u1, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	states, err := database.GetChannelVoiceStates(chanID)
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

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceCamera(userID, true); err != nil {
		t.Fatalf("UpdateVoiceCamera(true): %v", err)
	}

	state, _ := database.GetVoiceState(userID)
	if state == nil || !state.Camera {
		t.Error("Camera = false after UpdateVoiceCamera(true)")
	}
}

func TestVoice_UpdateVoiceCamera_False(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "cam-off")
	chanID := seedVoiceChannel(t, database, "voice-camera-off")

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceCamera(userID, true); err != nil {
		t.Fatalf("UpdateVoiceCamera(true): %v", err)
	}
	if err := database.UpdateVoiceCamera(userID, false); err != nil {
		t.Fatalf("UpdateVoiceCamera(false): %v", err)
	}

	state, _ := database.GetVoiceState(userID)
	if state == nil || state.Camera {
		t.Error("Camera = true after UpdateVoiceCamera(false), want false")
	}
}

func TestVoice_UpdateVoiceCamera_NotInChannel_NoError(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "cam-noop")

	if err := database.UpdateVoiceCamera(userID, true); err != nil {
		t.Fatalf("UpdateVoiceCamera for non-member: %v", err)
	}
}

// ─── UpdateVoiceScreenshare ──────────────────────────────────────────────────

func TestVoice_UpdateVoiceScreenshare_True(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "share-on")
	chanID := seedVoiceChannel(t, database, "voice-screen")

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceScreenshare(userID, true); err != nil {
		t.Fatalf("UpdateVoiceScreenshare(true): %v", err)
	}

	state, _ := database.GetVoiceState(userID)
	if state == nil || !state.Screenshare {
		t.Error("Screenshare = false after UpdateVoiceScreenshare(true)")
	}
}

func TestVoice_UpdateVoiceScreenshare_False(t *testing.T) {
	database := newVoiceTestDB(t)
	userID := seedVoiceUser(t, database, "share-off")
	chanID := seedVoiceChannel(t, database, "voice-screen-off")

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateVoiceScreenshare(userID, true); err != nil {
		t.Fatalf("UpdateVoiceScreenshare(true): %v", err)
	}
	if err := database.UpdateVoiceScreenshare(userID, false); err != nil {
		t.Fatalf("UpdateVoiceScreenshare(false): %v", err)
	}

	state, _ := database.GetVoiceState(userID)
	if state == nil || state.Screenshare {
		t.Error("Screenshare = true after UpdateVoiceScreenshare(false), want false")
	}
}

// ─── CountChannelVoiceUsers ──────────────────────────────────────────────────

func TestVoice_CountChannelVoiceUsers_Empty(t *testing.T) {
	database := newVoiceTestDB(t)
	chanID := seedVoiceChannel(t, database, "count-empty")

	count, err := database.CountChannelVoiceUsers(chanID)
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

	if err := database.JoinVoiceChannel(u1, chanID); err != nil {
		t.Fatalf("join u1: %v", err)
	}
	if err := database.JoinVoiceChannel(u2, chanID); err != nil {
		t.Fatalf("join u2: %v", err)
	}
	// u3 joins a different channel — should not be counted.
	if err := database.JoinVoiceChannel(u3, otherChan); err != nil {
		t.Fatalf("join u3: %v", err)
	}

	count, err := database.CountChannelVoiceUsers(chanID)
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

	if err := database.JoinVoiceChannel(u1, chan1); err != nil {
		t.Fatalf("join u1: %v", err)
	}
	if err := database.JoinVoiceChannel(u2, chan2); err != nil {
		t.Fatalf("join u2: %v", err)
	}

	if err := database.ClearAllVoiceStates(); err != nil {
		t.Fatalf("ClearAllVoiceStates: %v", err)
	}

	s1, _ := database.GetVoiceState(u1)
	s2, _ := database.GetVoiceState(u2)
	if s1 != nil || s2 != nil {
		t.Error("voice states still exist after ClearAllVoiceStates")
	}
}

func TestVoice_ClearAllVoiceStates_EmptyTable_NoError(t *testing.T) {
	database := newVoiceTestDB(t)

	if err := database.ClearAllVoiceStates(); err != nil {
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
	if err := database.JoinVoiceChannel(userID, chan1); err != nil {
		t.Fatalf("first join: %v", err)
	}
	if err := database.UpdateVoiceCamera(userID, true); err != nil {
		t.Fatalf("UpdateVoiceCamera: %v", err)
	}
	if err := database.UpdateVoiceScreenshare(userID, true); err != nil {
		t.Fatalf("UpdateVoiceScreenshare: %v", err)
	}

	// Join a different channel — camera and screenshare should be reset.
	if err := database.JoinVoiceChannel(userID, chan2); err != nil {
		t.Fatalf("second join: %v", err)
	}

	state, _ := database.GetVoiceState(userID)
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

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	// Initially both should be false.
	state, _ := database.GetVoiceState(userID)
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
	_ = database.UpdateVoiceCamera(userID, true)
	_ = database.UpdateVoiceScreenshare(userID, true)

	state, _ = database.GetVoiceState(userID)
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

	if err := database.JoinVoiceChannel(userID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	_ = database.UpdateVoiceCamera(userID, true)

	states, err := database.GetChannelVoiceStates(chanID)
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
