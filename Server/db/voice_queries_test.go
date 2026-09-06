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
CREATE TABLE IF NOT EXISTS moderation_actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL DEFAULT 'timeout',
    target_id  INTEGER NOT NULL DEFAULT 0,
    lifted_at  TEXT,
    expires_at TEXT
);
CREATE TABLE IF NOT EXISTS voice_states (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted       INTEGER NOT NULL DEFAULT 0,
    deafened    INTEGER NOT NULL DEFAULT 0,
    speaking    INTEGER NOT NULL DEFAULT 0,
    camera      INTEGER NOT NULL DEFAULT 0,
    screenshare INTEGER NOT NULL DEFAULT 0,
    server_muted    INTEGER NOT NULL DEFAULT 0,
    server_muted_by INTEGER REFERENCES moderation_actions(id) ON DELETE SET NULL,
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

// seedTimeoutAction inserts a minimal moderation_actions row (round 4:
// voice_states.server_muted_by is a real FK, so MuteForTimeoutSession needs
// a genuine row to point at) and returns its id. active=false backdates
// expires_at into the past, simulating an action MuteForTimeoutSession's
// reclaim clause must treat as no longer the rightful owner.
func seedTimeoutAction(t *testing.T, database *db.DB, targetID int64, active bool) int64 {
	t.Helper()
	expires := "2999-01-01 00:00:00"
	if !active {
		expires = "2000-01-01 00:00:00"
	}
	var id int64
	row := database.QueryRowContext(context.Background(),
		`INSERT INTO moderation_actions (kind, target_id, expires_at) VALUES ('timeout', ?, ?) RETURNING id`,
		targetID, expires)
	if err := row.Scan(&id); err != nil {
		t.Fatalf("seedTimeoutAction: %v", err)
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

// ─── MuteForTimeoutSession / ClearServerMuteOwnedBy (round 4, replacing
// round 3's CompareAndSetServerMute) ─────────────────────────────────────────

// TestVoice_MuteForTimeoutSession_ChannelMismatch is TestVoice_
// SetVoiceServerMute_ScopedToChannel's twin for the timeout voice half's
// stricter, session-scoped mute: a write authorized against the channel a
// stale read showed must not follow the user to wherever they moved next.
func TestVoice_MuteForTimeoutSession_ChannelMismatch(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "cas-mismatch-user")
	chanA := seedVoiceChannel(t, database, "vc-cas-mismatch-a")
	chanB := seedVoiceChannel(t, database, "vc-cas-mismatch-b")
	actionID := seedTimeoutAction(t, database, userID, true)

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

	matched, transitioned, err := database.MuteForTimeoutSession(ctx, userID, chanA, actionID, stale.JoinedAt, nil)
	if err != nil {
		t.Fatalf("MuteForTimeoutSession: %v", err)
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

// TestVoice_MuteForTimeoutSession_JoinedAtMismatch is the same guard for a
// leave-and-rejoin of the SAME channel — the join-instance token
// (JoinVoiceChannel's joined_at) changes even though channel_id does not,
// which SetVoiceServerMute's own channel-only scoping would miss.
func TestVoice_MuteForTimeoutSession_JoinedAtMismatch(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "cas-rejoin-user")
	chanA := seedVoiceChannel(t, database, "vc-cas-rejoin-a")
	actionID := seedTimeoutAction(t, database, userID, true)

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

	matched, _, err := database.MuteForTimeoutSession(ctx, userID, chanA, actionID, stale.JoinedAt, nil)
	if err != nil {
		t.Fatalf("MuteForTimeoutSession: %v", err)
	}
	if matched {
		t.Fatal("matched = true, want false: the stale join instance is gone, even though the channel matches")
	}
}

// TestVoice_MuteForTimeoutSession_Transitioned proves ownership (P1-4
// PARTIAL): a genuine unmuted->muted transition reports transitioned=true;
// muting a target ALREADY server-muted BY THE SAME STILL-ACTIVE action
// reports transitioned=false — nothing new to claim.
func TestVoice_MuteForTimeoutSession_Transitioned(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "cas-transition-user")
	chanA := seedVoiceChannel(t, database, "vc-cas-transition-a")
	actionID := seedTimeoutAction(t, database, userID, true)

	if err := database.JoinVoiceChannel(ctx, userID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	state, err := database.GetVoiceState(ctx, userID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}

	matched, transitioned, err := database.MuteForTimeoutSession(ctx, userID, chanA, actionID, state.JoinedAt, nil)
	if err != nil {
		t.Fatalf("MuteForTimeoutSession (first mute): %v", err)
	}
	if !matched || !transitioned {
		t.Fatalf("matched=%v transitioned=%v, want both true: the first mute is a genuine unmuted->muted transition", matched, transitioned)
	}

	// Muting an already-muted target owned by the SAME still-active action:
	// matched, but nothing new transitioned.
	matched, transitioned, err = database.MuteForTimeoutSession(ctx, userID, chanA, actionID, state.JoinedAt, nil)
	if err != nil {
		t.Fatalf("MuteForTimeoutSession (already muted): %v", err)
	}
	if !matched {
		t.Fatal("matched = false, want true: the session is still live and in the right channel")
	}
	if transitioned {
		t.Fatal("transitioned = true, want false: the same action already owns this mute")
	}

	channelID, joinedAt, cleared, err := database.ClearServerMuteOwnedBy(ctx, userID, []int64{actionID})
	if err != nil {
		t.Fatalf("ClearServerMuteOwnedBy: %v", err)
	}
	if !cleared || channelID != chanA || joinedAt != state.JoinedAt {
		t.Fatalf("ClearServerMuteOwnedBy = (%d, %q, %v), want (%d, %q, true)", channelID, joinedAt, cleared, chanA, state.JoinedAt)
	}
	final, err := database.GetVoiceState(ctx, userID)
	if err != nil || final == nil {
		t.Fatalf("GetVoiceState (final): %v", err)
	}
	if final.ServerMuted {
		t.Error("ServerMuted = true, want false after ClearServerMuteOwnedBy")
	}
}

// TestVoice_MuteForTimeoutSession_ReclaimsFromInactiveOwner is round 4's
// stranded-ownership fix (Codex review): a session muted by a timeout that
// is no longer active (lifted or expired, simulating TimeoutUser's
// supersede-transfer having committed before the superseded row ever
// stamped ownership) can still be claimed by a different action's mute
// call, so a later lift of the NEW owner is not left unable to find it.
func TestVoice_MuteForTimeoutSession_ReclaimsFromInactiveOwner(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "cas-reclaim-user")
	chanA := seedVoiceChannel(t, database, "vc-cas-reclaim-a")
	staleAction := seedTimeoutAction(t, database, userID, true) // active for now
	newAction := seedTimeoutAction(t, database, userID, true)

	if err := database.JoinVoiceChannel(ctx, userID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	state, err := database.GetVoiceState(ctx, userID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	// staleAction claims the mute first, while still active (round 5, Codex
	// review P2: the incoming action itself must be active for the mute to
	// land at all) — then goes inactive afterward, as if it landed before
	// its own row was superseded.
	if matched, transitioned, err := database.MuteForTimeoutSession(ctx, userID, chanA, staleAction, state.JoinedAt, nil); err != nil || !matched || !transitioned {
		t.Fatalf("seed mute: matched=%v transitioned=%v err=%v", matched, transitioned, err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE moderation_actions SET expires_at = '2000-01-01 00:00:00' WHERE id = ?`, staleAction); err != nil {
		t.Fatalf("backdate staleAction: %v", err)
	}

	matched, transitioned, err := database.MuteForTimeoutSession(ctx, userID, chanA, newAction, state.JoinedAt, nil)
	if err != nil {
		t.Fatalf("MuteForTimeoutSession (reclaim): %v", err)
	}
	if !matched || !transitioned {
		t.Fatalf("matched=%v transitioned=%v, want both true: an inactive owner's mute must be reclaimable", matched, transitioned)
	}

	// The stale action's own id can no longer clear it; the new owner's can.
	if _, _, cleared, err := database.ClearServerMuteOwnedBy(ctx, userID, []int64{staleAction}); err != nil || cleared {
		t.Fatalf("ClearServerMuteOwnedBy(stale) cleared=%v err=%v, want cleared=false", cleared, err)
	}
	if _, _, cleared, err := database.ClearServerMuteOwnedBy(ctx, userID, []int64{newAction}); err != nil || !cleared {
		t.Fatalf("ClearServerMuteOwnedBy(new) cleared=%v err=%v, want cleared=true", cleared, err)
	}
}

// TestVoice_MuteForTimeoutSession_NoSession is the no-such-row case: never
// joined, or already left entirely.
func TestVoice_MuteForTimeoutSession_NoSession(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "cas-nosession-user")
	chanA := seedVoiceChannel(t, database, "vc-cas-nosession-a")
	actionID := seedTimeoutAction(t, database, userID, true)

	matched, transitioned, err := database.MuteForTimeoutSession(ctx, userID, chanA, actionID, "no-such-join-token", nil)
	if err != nil {
		t.Fatalf("MuteForTimeoutSession: %v", err)
	}
	if matched || transitioned {
		t.Fatalf("matched=%v transitioned=%v, want both false: no such session", matched, transitioned)
	}
}

// TestVoice_FindOrphanedVoiceMutes_FindsLiftedAndExpiredOwners is the
// round-4 (B5-10 addendum) reconcile sweep's own query: a voice_states row
// owned by a LIFTED action, and one owned by an EXPIRED-but-never-lifted
// action, are both orphaned candidates.
func TestVoice_FindOrphanedVoiceMutes_FindsLiftedAndExpiredOwners(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	chanA := seedVoiceChannel(t, database, "vc-orphan-a")

	liftedUser := seedVoiceUser(t, database, "orphan-lifted-user")
	liftedAction := seedTimeoutAction(t, database, liftedUser, true) // active for now
	if err := database.JoinVoiceChannel(ctx, liftedUser, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	liftedState, err := database.GetVoiceState(ctx, liftedUser)
	if err != nil || liftedState == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	// Mute while still active (round 5, Codex review P2 requires it), THEN
	// mark it lifted — expires_at stays in the future, only lifted_at is set.
	if matched, transitioned, err := database.MuteForTimeoutSession(ctx, liftedUser, chanA, liftedAction, liftedState.JoinedAt, nil); err != nil || !matched || !transitioned {
		t.Fatalf("MuteForTimeoutSession(lifted): matched=%v transitioned=%v err=%v", matched, transitioned, err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE moderation_actions SET lifted_at = datetime('now') WHERE id = ?`, liftedAction); err != nil {
		t.Fatalf("mark liftedAction lifted: %v", err)
	}

	expiredUser := seedVoiceUser(t, database, "orphan-expired-user")
	expiredAction := seedTimeoutAction(t, database, expiredUser, true) // active for now
	if err := database.JoinVoiceChannel(ctx, expiredUser, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	expiredState, err := database.GetVoiceState(ctx, expiredUser)
	if err != nil || expiredState == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if matched, transitioned, err := database.MuteForTimeoutSession(ctx, expiredUser, chanA, expiredAction, expiredState.JoinedAt, nil); err != nil || !matched || !transitioned {
		t.Fatalf("MuteForTimeoutSession(expired): matched=%v transitioned=%v err=%v", matched, transitioned, err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE moderation_actions SET expires_at = '2000-01-01 00:00:00' WHERE id = ?`, expiredAction); err != nil {
		t.Fatalf("backdate expiredAction: %v", err)
	}

	got, err := database.FindOrphanedVoiceMutes(ctx)
	if err != nil {
		t.Fatalf("FindOrphanedVoiceMutes: %v", err)
	}
	want := map[int64]int64{liftedUser: liftedAction, expiredUser: expiredAction}
	if len(got) != len(want) {
		t.Fatalf("FindOrphanedVoiceMutes = %+v, want %d entries matching %+v", got, len(want), want)
	}
	for _, o := range got {
		if want[o.UserID] != o.ActionID {
			t.Errorf("FindOrphanedVoiceMutes entry %+v does not match want %+v", o, want)
		}
	}
}

// TestVoice_FindOrphanedVoiceMutes_ExcludesActiveOwnersAndManualMutes: a
// session owned by a STILL-ACTIVE timeout, and a manual moderator mute
// (server_muted_by NULL), are never candidates.
func TestVoice_FindOrphanedVoiceMutes_ExcludesActiveOwnersAndManualMutes(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	chanA := seedVoiceChannel(t, database, "vc-orphan-exclude-a")

	activeUser := seedVoiceUser(t, database, "orphan-active-user")
	activeAction := seedTimeoutAction(t, database, activeUser, true)
	if err := database.JoinVoiceChannel(ctx, activeUser, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	activeState, err := database.GetVoiceState(ctx, activeUser)
	if err != nil || activeState == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if matched, transitioned, err := database.MuteForTimeoutSession(ctx, activeUser, chanA, activeAction, activeState.JoinedAt, nil); err != nil || !matched || !transitioned {
		t.Fatalf("MuteForTimeoutSession: matched=%v transitioned=%v err=%v", matched, transitioned, err)
	}

	manualUser := seedVoiceUser(t, database, "orphan-manual-user")
	if err := database.JoinVoiceChannel(ctx, manualUser, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if matched, err := database.SetVoiceServerMute(ctx, manualUser, chanA, true); err != nil || !matched {
		t.Fatalf("SetVoiceServerMute: matched=%v err=%v", matched, err)
	}

	got, err := database.FindOrphanedVoiceMutes(ctx)
	if err != nil {
		t.Fatalf("FindOrphanedVoiceMutes: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("FindOrphanedVoiceMutes = %+v, want none: an active-owned mute and a manual mute are never candidates", got)
	}
}

// TestVoice_ClearServerMuteOwnedBy_NoSession is a no-op with no error when
// no actionIDs match anything — an ended or already-cleared session, or an
// unmuted target.
func TestVoice_ClearServerMuteOwnedBy_NoSession(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "clr-nosession-user")

	channelID, joinedAt, cleared, err := database.ClearServerMuteOwnedBy(ctx, userID, []int64{999})
	if err != nil {
		t.Fatalf("ClearServerMuteOwnedBy: %v", err)
	}
	if cleared || channelID != 0 || joinedAt != "" {
		t.Fatalf("got (%d, %q, %v), want (0, \"\", false)", channelID, joinedAt, cleared)
	}
}

// TestVoice_ClearServerMuteOwnedBy_ManualMuteNeverReclaimed proves the
// FK-null immunity migration 049's comment describes (round 4, Part A): a
// manual moderator mute (SetVoiceServerMute, server_muted_by always NULL)
// is never cleared by a timeout's lift, no matter which action ids it names.
func TestVoice_ClearServerMuteOwnedBy_ManualMuteNeverReclaimed(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "clr-manual-user")
	chanA := seedVoiceChannel(t, database, "vc-clr-manual-a")
	actionID := seedTimeoutAction(t, database, userID, true)

	if err := database.JoinVoiceChannel(ctx, userID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if matched, err := database.SetVoiceServerMute(ctx, userID, chanA, true); err != nil || !matched {
		t.Fatalf("SetVoiceServerMute: matched=%v err=%v", matched, err)
	}

	if _, _, cleared, err := database.ClearServerMuteOwnedBy(ctx, userID, []int64{actionID}); err != nil || cleared {
		t.Fatalf("ClearServerMuteOwnedBy cleared=%v err=%v, want false: a manual mute has no owning action to name", cleared, err)
	}
	state, err := database.GetVoiceState(ctx, userID)
	if err != nil || state == nil || !state.ServerMuted {
		t.Fatal("the manual mute must still be in effect")
	}
}

// TestVoice_ClearServerMuteOwnedBy_MatchesAnyOfTheChain proves LiftTimeout's
// defensive lift-all can pass a whole supersede chain (P2-9) and the
// SESSION's single owner (whichever one it currently is) still clears.
func TestVoice_ClearServerMuteOwnedBy_MatchesAnyOfTheChain(t *testing.T) {
	database := newVoiceTestDB(t)
	ctx := context.Background()
	userID := seedVoiceUser(t, database, "clr-chain-user")
	chanA := seedVoiceChannel(t, database, "vc-clr-chain-a")
	owner := seedTimeoutAction(t, database, userID, true)
	other := seedTimeoutAction(t, database, userID, true)

	if err := database.JoinVoiceChannel(ctx, userID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	state, err := database.GetVoiceState(ctx, userID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if matched, transitioned, err := database.MuteForTimeoutSession(ctx, userID, chanA, owner, state.JoinedAt, nil); err != nil || !matched || !transitioned {
		t.Fatalf("seed mute: matched=%v transitioned=%v err=%v", matched, transitioned, err)
	}

	if _, _, cleared, err := database.ClearServerMuteOwnedBy(ctx, userID, []int64{other, owner}); err != nil || !cleared {
		t.Fatalf("ClearServerMuteOwnedBy cleared=%v err=%v, want true: owner is one of the chain ids", cleared, err)
	}
}
