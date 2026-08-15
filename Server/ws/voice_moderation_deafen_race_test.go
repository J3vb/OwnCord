package ws

// voice_moderation_deafen_race_test.go — regression test for OC-0034.
//
// handleVoiceModDeafenV2 implies a server mute when it applies a server
// deafen. The two writes are separate statements (no transaction spans
// them), so when the second (the mute) fails to match because the target's
// voice_states row moved to a different channel in between, the handler
// best-effort rolls back the deafen it just applied. That rollback used to
// pass the same stale channel snapshot that just failed to match the mute
// write, so it also matched zero rows and silently no-opped — leaving the
// target server_deafened=1 with server_muted=0, on their new channel, with
// no SFU mute in effect yet still refused their own undeafen
// (refuseIfServerSilenced).
//
// The window is one SQLite statement wide and cannot be landed by staggering
// real goroutines, so voiceModDeafenPreMuteRaceHook (test-only, nil in
// production) fires at exactly that point, mirroring the existing
// voiceJoinPostTokenRaceHook / cleanupVoiceRaceClearHook pattern.

import (
	"context"
	"testing"

	"github.com/owncord/server/db"
)

// deafenRaceRoleAdmin / deafenRaceRoleMember reuse the default seeded roles
// (see migrations/001_initial_schema.sql): Admin holds MUTE_MEMBERS at
// position 80, Member sits below it at position 40, which is what
// voiceModTarget's outrank check needs.
const (
	deafenRaceRoleAdmin  = 2
	deafenRaceRoleMember = 4
)

func newDeafenRaceDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func seedDeafenRaceUser(t *testing.T, database *db.DB, username string, roleID int) int64 {
	t.Helper()
	uid, err := database.CreateUser(context.Background(), username, "hash", roleID)
	if err != nil {
		t.Fatalf("CreateUser %s: %v", username, err)
	}
	return uid
}

func mustCreateDeafenRaceChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	chID, err := database.CreateChannel(context.Background(), name, "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel %s: %v", name, err)
	}
	return chID
}

// TestVoiceModDeafen_RollbackFollowsTargetChannelMove pins OC-0034: the
// compensating deafen-clear must be scoped to the target's CURRENT channel,
// not the stale channel snapshot the mute write just failed to match
// against, or the rollback silently no-ops when the mismatch was caused by a
// channel move rather than the target leaving voice entirely.
func TestVoiceModDeafen_RollbackFollowsTargetChannelMove(t *testing.T) {
	database := newDeafenRaceDB(t)
	ctx := context.Background()

	chanA := mustCreateDeafenRaceChannel(t, database, "vc-deafen-race-a")
	chanB := mustCreateDeafenRaceChannel(t, database, "vc-deafen-race-b")
	actorID := seedDeafenRaceUser(t, database, "deafen-race-admin", deafenRaceRoleAdmin)
	targetID := seedDeafenRaceUser(t, database, "deafen-race-member", deafenRaceRoleMember)

	if err := database.JoinVoiceChannel(ctx, targetID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	// Fire exactly between the deafen write (which matches, since the target
	// is still on chanA at that point) and the implied-mute write: move the
	// target's row to chanB, which is what makes the mute write fail to
	// match against the chanA snapshot the handler is holding.
	var hookRan bool
	voiceModDeafenPreMuteRaceHook = func(ctx context.Context, d VoiceDeps, targetID int64) {
		hookRan = true
		if err := d.DB.JoinVoiceChannel(ctx, targetID, chanB); err != nil {
			t.Fatalf("hook: JoinVoiceChannel to chanB: %v", err)
		}
	}
	defer func() { voiceModDeafenPreMuteRaceHook = nil }()

	cmd := VoiceModDeafenCmd{userID: actorID, channelID: chanA, targetID: targetID, deafened: true}
	info := ClientInfo{UserID: actorID}
	deps := VoiceDeps{DB: database}

	result := handleVoiceModDeafenV2(ctx, cmd, info, deps)

	if !hookRan {
		t.Fatal("voiceModDeafenPreMuteRaceHook never fired — test setup is broken, not exercising the race window")
	}
	clientErr, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("result error = %#v (%T), want a ClientError", result.Error, result.Error)
	}
	if clientErr.Code != ErrCodeVoiceError {
		t.Fatalf("result error code = %q, want %q (target moved channels mid-request)", clientErr.Code, ErrCodeVoiceError)
	}

	state, err := database.GetVoiceState(ctx, targetID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil {
		t.Fatal("target's voice_states row disappeared")
	}
	if state.ChannelID != chanB {
		t.Fatalf("test setup broken: target channel = %d, want %d (chanB)", state.ChannelID, chanB)
	}
	if state.ServerDeafened {
		t.Error("ServerDeafened = true after the mismatched mute write, want false: " +
			"the compensating rollback must clear it on the target's CURRENT channel, " +
			"not the stale channel snapshot that already failed to match")
	}
	if state.ServerMuted {
		t.Error("ServerMuted = true, want false: the implied-mute write never matched, so it must not have applied")
	}
}
