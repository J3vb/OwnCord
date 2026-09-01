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
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
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
		if err := d.Voice.Join(ctx, targetID, chanB, 0); err != nil {
			t.Fatalf("hook: joining chanB: %v", err)
		}
	}
	defer func() { voiceModDeafenPreMuteRaceHook = nil }()

	cmd := VoiceModDeafenCmd{userID: actorID, channelID: chanA, targetID: targetID, deafened: true}
	info := ClientInfo{UserID: actorID}
	deps := VoiceDeps{Voice: service.NewVoiceService(database), Reader: database, Permissions: permissions.NewChecker(database)}

	result := handleVoiceModDeafenV2(ctx, cmd, info, deps)

	if !hookRan {
		t.Fatal("voiceModDeafenPreMuteRaceHook never fired — test setup is broken, not exercising the race window")
	}
	var clientErr ClientError
	ok := errors.As(result.Error, &clientErr)
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

// TestVoiceModDeafen_UndeafenRollbackDoesNotApplyOnUnauthorizedChannel pins
// OC-0036: when the moderator's command is an UNDEAFEN (c.Deafened() ==
// false), the compensating rollback runs in the opposite direction from
// TestVoiceModDeafen_RollbackFollowsTargetChannelMove above -- it APPLIES a
// server deafen, not clears one. Scoping that apply to the target's CURRENT
// channel (cur.ChannelID, re-read after the race) stamps a moderator
// restriction onto a channel voiceModTarget never authorized the actor
// against, exactly the hazard SetVoiceServerDeafen's channel scoping exists
// to prevent for the ordinary (non-rollback) write path. The rollback must
// instead scope the APPLY direction to the channel that WAS authorized
// (state.ChannelID), so a target who moved channels mid-request simply ends
// up with the rollback matching zero rows -- the safe outcome.
func TestVoiceModDeafen_UndeafenRollbackDoesNotApplyOnUnauthorizedChannel(t *testing.T) {
	database := newDeafenRaceDB(t)
	ctx := context.Background()

	chanA := mustCreateDeafenRaceChannel(t, database, "vc-undeafen-race-a")
	chanB := mustCreateDeafenRaceChannel(t, database, "vc-undeafen-race-b")
	actorID := seedDeafenRaceUser(t, database, "undeafen-race-admin", deafenRaceRoleAdmin)
	targetID := seedDeafenRaceUser(t, database, "undeafen-race-member", deafenRaceRoleMember)

	if err := database.JoinVoiceChannel(ctx, targetID, chanA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	// Seed a pre-existing server deafen on chanA so the command below is a
	// genuine undeafen (the ordinary direction: volume-menu.ts sends
	// !mod.serverDeafened, and toggling off is the common case).
	if matched, err := database.SetVoiceServerDeafen(ctx, targetID, chanA, true); err != nil || !matched {
		t.Fatalf("seed SetVoiceServerDeafen: matched=%v err=%v", matched, err)
	}

	// Fire exactly between the deafen-clear write (which matches, since the
	// target is still on chanA at that point) and the implied-mute write:
	// move the target's row to chanB, which is what makes the mute write
	// fail to match against the chanA snapshot the handler is holding.
	var hookRan bool
	voiceModDeafenPreMuteRaceHook = func(ctx context.Context, d VoiceDeps, targetID int64) {
		hookRan = true
		if err := d.Voice.Join(ctx, targetID, chanB, 0); err != nil {
			t.Fatalf("hook: joining chanB: %v", err)
		}
	}
	defer func() { voiceModDeafenPreMuteRaceHook = nil }()

	// deafened: false -- an UNDEAFEN, the opposite direction from the sibling
	// test above.
	cmd := VoiceModDeafenCmd{userID: actorID, channelID: chanA, targetID: targetID, deafened: false}
	info := ClientInfo{UserID: actorID}
	deps := VoiceDeps{Voice: service.NewVoiceService(database), Reader: database, Permissions: permissions.NewChecker(database)}

	result := handleVoiceModDeafenV2(ctx, cmd, info, deps)

	if !hookRan {
		t.Fatal("voiceModDeafenPreMuteRaceHook never fired — test setup is broken, not exercising the race window")
	}
	var clientErr ClientError
	ok := errors.As(result.Error, &clientErr)
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
		t.Error("ServerDeafened = true on chanB after the mismatched mute write, want false: " +
			"the compensating rollback re-applies a deafen (the command was an undeafen), which " +
			"must only ever land on the channel voiceModTarget actually authorized (chanA) -- " +
			"stamping it onto chanB, a channel nobody authorized the actor against, is OC-0036")
	}
}
