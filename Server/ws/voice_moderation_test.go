package ws_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"testing/fstest"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/ws"
)

// voiceModSchema is voiceSchema plus audit_log, so the moderation handlers'
// db.WriteAudit calls land in a real table instead of erroring out.
var voiceModSchema = append(append([]byte{}, voiceSchema...), []byte(`
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL REFERENCES users(id),
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
`)...)

// newVoiceModHub mirrors newVoiceHub but on the audit-capable schema.
func newVoiceModHub(t *testing.T) (*ws.Hub, *db.DB) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	migrFS := fstest.MapFS{"001_schema.sql": {Data: voiceModSchema}}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}

	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter, nil)
	lk, err := ws.NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "test-api-key-12345",
		LiveKitAPISecret: "test-api-secret-67890abcdef",
		LiveKitURL:       "ws://localhost:7880",
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	hub.SetLiveKit(lk)

	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database
}

// seedVoiceUserWithRole inserts a user with an explicit role id from the
// default role table (1 Owner/pos 100, 2 Admin/pos 80, 3 Moderator/pos 60,
// 4 Member/pos 40). Admin holds MUTE_MEMBERS without ADMINISTRATOR; Moderator
// holds neither, which is what the denial cases below rely on.
func seedVoiceUserWithRole(t *testing.T, database *db.DB, username string, roleID int) *db.User {
	t.Helper()
	if _, err := database.CreateUser(context.Background(), username, "hash", roleID); err != nil {
		t.Fatalf("seedVoiceUserWithRole CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || user == nil {
		t.Fatalf("seedVoiceUserWithRole GetUserByUsername: %v", err)
	}
	return user
}

// joinVoice registers a client for user and puts them in chanID via voice_join,
// returning the client and its send channel drained of the join traffic.
func joinVoice(t *testing.T, hub *ws.Hub, user *db.User, chanID int64) (*ws.Client, chan []byte) {
	t.Helper()
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	drainChanTimeout(send, 30*time.Millisecond)
	return c, send
}

func voiceModMuteMsg(channelID, userID int64, muted bool) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_mod_mute",
		"payload": map[string]any{"channel_id": channelID, "user_id": userID, "muted": muted},
	})
	return raw
}

func voiceModDeafenMsg(channelID, userID int64, deafened bool) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_mod_deafen",
		"payload": map[string]any{"channel_id": channelID, "user_id": userID, "deafened": deafened},
	})
	return raw
}

func voiceModMoveMsg(userID, toChannelID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_mod_move",
		"payload": map[string]any{"user_id": userID, "to_channel_id": toChannelID},
	})
	return raw
}

func voiceModKickMsg(userID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_mod_kick",
		"payload": map[string]any{"user_id": userID},
	})
	return raw
}

// auditActions returns the actions recorded in the audit log, newest first.
func auditActions(t *testing.T, database *db.DB) []string {
	t.Helper()
	entries, err := database.GetAuditLog(context.Background(), 50, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	actions := make([]string, 0, len(entries))
	for _, e := range entries {
		actions = append(actions, e.Action)
	}
	return actions
}

// ─── authorization ────────────────────────────────────────────────────────────

func TestVoiceMod_Mute_WithoutMutePermission_Forbidden(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-perm")
	actor := seedVoiceUserWithRole(t, database, "mod-noperm", 3)   // Moderator: no MUTE_MEMBERS
	target := seedVoiceUserWithRole(t, database, "target-perm", 4) // Member

	joinVoice(t, hub, target, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMuteMsg(chanID, target.ID, true))

	if code := receiveErrorCode(send, waitTimeout); code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", code)
	}
	state, _ := database.GetVoiceState(context.Background(), target.ID)
	if state == nil || state.ServerMuted {
		t.Error("target must not be server muted after a refused action")
	}
}

func TestVoiceMod_Mute_TargetOutranksActor_Forbidden(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-rank")
	actor := seedVoiceUserWithRole(t, database, "admin-rank", 2)  // Admin, position 80
	target := seedVoiceUserWithRole(t, database, "owner-rank", 1) // Owner, position 100

	joinVoice(t, hub, target, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMuteMsg(chanID, target.ID, true))

	if code := receiveErrorCode(send, waitTimeout); code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", code)
	}
	state, _ := database.GetVoiceState(context.Background(), target.ID)
	if state == nil || state.ServerMuted {
		t.Error("higher-ranked target must not be server muted")
	}
}

func TestVoiceMod_Mute_TargetNotInVoice_VoiceError(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-absent")
	actor := seedVoiceUserWithRole(t, database, "admin-absent", 2)
	target := seedVoiceUserWithRole(t, database, "member-absent", 4)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMuteMsg(chanID, target.ID, true))

	if code := receiveErrorCode(send, waitTimeout); code != "VOICE_ERROR" {
		t.Fatalf("error code = %q, want VOICE_ERROR", code)
	}
}

func TestVoiceMod_Mute_WrongChannel_VoiceError(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanA := seedVoiceChan(t, database, "vc-wrong-a")
	chanB := seedVoiceChan(t, database, "vc-wrong-b")
	actor := seedVoiceUserWithRole(t, database, "admin-wrong", 2)
	target := seedVoiceUserWithRole(t, database, "member-wrong", 4)

	joinVoice(t, hub, target, chanA)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanA, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMuteMsg(chanB, target.ID, true))

	if code := receiveErrorCode(send, waitTimeout); code != "VOICE_ERROR" {
		t.Fatalf("error code = %q, want VOICE_ERROR", code)
	}
}

func TestVoiceMod_Kick_Self_BadRequest(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-self")
	actor := seedVoiceUserWithRole(t, database, "admin-self", 2)

	c, send := joinVoice(t, hub, actor, chanID)
	hub.HandleMessageForTest(c, voiceModKickMsg(actor.ID))

	if code := receiveErrorCode(send, waitTimeout); code != "BAD_REQUEST" {
		t.Fatalf("error code = %q, want BAD_REQUEST", code)
	}
}

// voice_mod_kick and friends carry no channel id for the target, so
// MUTE_MEMBERS alone let a moderator reach into a private DM call they are
// not a participant of by targeting a user id. The refusal must look exactly
// like "target not in voice" — a VOICE_ERROR, not FORBIDDEN — so the actor
// cannot use the response to learn the target is in a DM call at all.
func TestVoiceMod_Mute_TargetInDMCallActorNotParticipant_VoiceError(t *testing.T) {
	hub, database := newVoiceModHub(t)
	alice := seedVoiceUserWithRole(t, database, "dm-alice", 4)     // Member, DM participant
	bob := seedVoiceUserWithRole(t, database, "dm-bob", 4)         // Member, DM participant (target)
	mallory := seedVoiceUserWithRole(t, database, "dm-mallory", 2) // Admin: has MUTE_MEMBERS, not a participant
	dmID := seedDMChannel(t, database, alice.ID, bob.ID)

	joinVoice(t, hub, bob, dmID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, mallory, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMuteMsg(dmID, bob.ID, true))

	if code := receiveErrorCode(send, waitTimeout); code != "VOICE_ERROR" {
		t.Fatalf("error code = %q, want VOICE_ERROR (must not disclose the DM call via FORBIDDEN)", code)
	}
	state, _ := database.GetVoiceState(context.Background(), bob.ID)
	if state == nil || state.ServerMuted {
		t.Error("target in a DM call the actor is not part of must not be server muted")
	}
}

// A MUTE_MEMBERS holder who genuinely IS a participant of the DM call may
// still moderate it, same as any other voice channel.
func TestVoiceMod_Mute_TargetInDMCallActorIsParticipant_Allowed(t *testing.T) {
	hub, database := newVoiceModHub(t)
	admin := seedVoiceUserWithRole(t, database, "dm-admin", 2)   // Admin: MUTE_MEMBERS, DM participant
	member := seedVoiceUserWithRole(t, database, "dm-member", 4) // Member (target)
	dmID := seedDMChannel(t, database, admin.ID, member.ID)

	joinVoice(t, hub, member, dmID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, admin, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMuteMsg(dmID, member.ID, true))

	state, err := database.GetVoiceState(context.Background(), member.ID)
	if err != nil || state == nil || !state.ServerMuted {
		t.Fatalf("expected target to be server muted, state=%+v err=%v", state, err)
	}
}

// ─── happy paths ──────────────────────────────────────────────────────────────

func TestVoiceMod_Mute_SetsServerMutedAndBroadcasts(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-mute")
	actor := seedVoiceUserWithRole(t, database, "admin-mute", 2)
	target := seedVoiceUserWithRole(t, database, "member-mute", 4)

	_, targetSend := joinVoice(t, hub, target, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMuteMsg(chanID, target.ID, true))

	state, err := database.GetVoiceState(context.Background(), target.ID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if !state.ServerMuted {
		t.Error("ServerMuted = false, want true")
	}
	if !state.Muted {
		t.Error("Muted = false, want true (server mute implies muted)")
	}

	payload := receiveMsgOfType(targetSend, "voice_state", waitTimeout)
	if payload == nil {
		t.Fatal("no voice_state broadcast after voice_mod_mute")
	}
	if payload["server_muted"] != true {
		t.Errorf("broadcast server_muted = %v, want true", payload["server_muted"])
	}

	if !slices.Contains(auditActions(t, database), "voice_mod_mute") {
		t.Error("voice_mod_mute audit entry missing")
	}
}

func TestVoiceMod_Mute_Clear_LeavesSelfMuteAlone(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-unmute")
	actor := seedVoiceUserWithRole(t, database, "admin-unmute", 2)
	target := seedVoiceUserWithRole(t, database, "member-unmute", 4)

	joinVoice(t, hub, target, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMuteMsg(chanID, target.ID, true))
	hub.HandleMessageForTest(c, voiceModMuteMsg(chanID, target.ID, false))

	state, err := database.GetVoiceState(context.Background(), target.ID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state.ServerMuted {
		t.Error("ServerMuted = true after clear, want false")
	}
	if !state.Muted {
		t.Error("Muted = false, want true: clearing a server mute must not unmute for the user")
	}
}

func TestVoiceMod_Deafen_SetsServerDeafenedAndMutes(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-deafen")
	actor := seedVoiceUserWithRole(t, database, "admin-deafen", 2)
	target := seedVoiceUserWithRole(t, database, "member-deafen", 4)

	_, targetSend := joinVoice(t, hub, target, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModDeafenMsg(chanID, target.ID, true))

	state, err := database.GetVoiceState(context.Background(), target.ID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if !state.ServerDeafened || !state.Deafened {
		t.Errorf("ServerDeafened=%v Deafened=%v, want both true", state.ServerDeafened, state.Deafened)
	}
	if !state.ServerMuted {
		t.Error("ServerMuted = false, want true: a server deafen also silences the microphone")
	}

	payload := receiveMsgOfType(targetSend, "voice_state", waitTimeout)
	if payload == nil {
		t.Fatal("no voice_state broadcast after voice_mod_deafen")
	}
	if payload["server_deafened"] != true {
		t.Errorf("broadcast server_deafened = %v, want true", payload["server_deafened"])
	}
	if !slices.Contains(auditActions(t, database), "voice_mod_deafen") {
		t.Error("voice_mod_deafen audit entry missing")
	}
}

// Lifting a server deafen must also lift the mute it implied, or the target
// stays SFU-muted (and refused their own unmute) after the deafen is gone.
func TestVoiceMod_Deafen_ClearingRestoresSelfUnmute(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-undeafen")
	actor := seedVoiceUserWithRole(t, database, "admin-undeafen", 2)
	target := seedVoiceUserWithRole(t, database, "member-undeafen", 4)

	targetClient, targetSend := joinVoice(t, hub, target, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Server-deafen the target: implies a server mute too.
	hub.HandleMessageForTest(c, voiceModDeafenMsg(chanID, target.ID, true))
	drainChanTimeout(targetSend, 30*time.Millisecond)

	state, err := database.GetVoiceState(context.Background(), target.ID)
	if err != nil || state == nil || !state.ServerDeafened || !state.ServerMuted {
		t.Fatalf("precondition: expected server_deafened and server_muted both set, state=%+v err=%v", state, err)
	}

	// Lift the deafen.
	hub.HandleMessageForTest(c, voiceModDeafenMsg(chanID, target.ID, false))
	drainChanTimeout(targetSend, 30*time.Millisecond)

	state, err = database.GetVoiceState(context.Background(), target.ID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state.ServerDeafened {
		t.Error("ServerDeafened = true after clearing, want false")
	}
	if state.ServerMuted {
		t.Error("ServerMuted = true after clearing the deafen that implied it, want false")
	}

	// The target must now be able to self-unmute without SERVER_MUTED.
	hub.HandleMessageForTest(targetClient, voiceMuteMsg(false))
	if code := receiveErrorCode(targetSend, 200*time.Millisecond); code != "" {
		t.Fatalf("self-unmute refused with %q after deafen was cleared, want no error", code)
	}
}

func TestVoiceMod_Kick_RemovesFromVoiceAndNotifiesTarget(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-kick")
	actor := seedVoiceUserWithRole(t, database, "admin-kick", 2)
	target := seedVoiceUserWithRole(t, database, "member-kick", 4)

	_, targetSend := joinVoice(t, hub, target, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModKickMsg(target.ID))

	waitFor(t, waitTimeout, func() bool {
		state, err := database.GetVoiceState(context.Background(), target.ID)
		return err == nil && state == nil
	}, "target's voice_states row to be deleted")

	if receiveMsgOfType(targetSend, "voice_disconnected", waitTimeout) == nil {
		t.Error("target did not receive voice_disconnected")
	}
	if !slices.Contains(auditActions(t, database), "voice_mod_kick") {
		t.Error("voice_mod_kick audit entry missing")
	}
}

func TestVoiceMod_Move_DisconnectsAndSendsVoiceMoved(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-move-from")
	toID := seedVoiceChan(t, database, "vc-move-to")
	actor := seedVoiceUserWithRole(t, database, "admin-move", 2)
	target := seedVoiceUserWithRole(t, database, "member-move", 4)

	_, targetSend := joinVoice(t, hub, target, fromID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, fromID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	payload := receiveMsgOfType(targetSend, "voice_moved", waitTimeout)
	if payload == nil {
		t.Fatal("target did not receive voice_moved")
	}
	if int64(payload["to_channel_id"].(float64)) != toID {
		t.Errorf("to_channel_id = %v, want %d", payload["to_channel_id"], toID)
	}
	waitFor(t, waitTimeout, func() bool {
		state, err := database.GetVoiceState(context.Background(), target.ID)
		return err == nil && state == nil
	}, "target to be removed from the old channel pending re-join")

	if !slices.Contains(auditActions(t, database), "voice_mod_move") {
		t.Error("voice_mod_move audit entry missing")
	}
}

// TestVoiceMod_Move_PreservesServerMute locks OC-0245: a moderator move is
// implemented as a server-driven leave (which deletes the target's
// voice_states row) followed by the target's client answering voice_moved
// with an ordinary voice_join to the destination — exactly like
// dispatcher.ts's VOICE_MOVED handler. voiceJoinLeaveCurrent's flag snapshot
// is gated on currentChID > 0, which is already 0 by the time that re-join
// runs (the moderator's goroutine cleared it), so a moderator-imposed
// server_muted/server_deafened must not be silently lifted by the very move
// the moderator asked for.
func TestVoiceMod_Move_PreservesServerMute(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-move-mute-from")
	toID := seedVoiceChan(t, database, "vc-move-mute-to")
	actor := seedVoiceUserWithRole(t, database, "admin-move-mute", 2)
	target := seedVoiceUserWithRole(t, database, "member-move-mute", 4)

	targetClient, targetSend := joinVoice(t, hub, target, fromID)

	if _, err := database.SetVoiceServerMute(context.Background(), target.ID, fromID, true); err != nil {
		t.Fatalf("SetVoiceServerMute: %v", err)
	}
	if _, err := database.SetVoiceServerDeafen(context.Background(), target.ID, fromID, true); err != nil {
		t.Fatalf("SetVoiceServerDeafen: %v", err)
	}

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, fromID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	if receiveMsgOfType(targetSend, "voice_moved", waitTimeout) == nil {
		t.Fatal("target did not receive voice_moved")
	}
	waitFor(t, waitTimeout, func() bool {
		state, err := database.GetVoiceState(context.Background(), target.ID)
		return err == nil && state == nil
	}, "target to be removed from the old channel pending re-join")

	// Simulate the target's client answering voice_moved with a plain
	// voice_join to the destination.
	hub.HandleMessageForTest(targetClient, voiceJoinMsg(toID))

	state, err := database.GetVoiceState(context.Background(), target.ID)
	if err != nil {
		t.Fatalf("GetVoiceState after move re-join: %v", err)
	}
	if state == nil || state.ChannelID != toID {
		t.Fatalf("target should be in channel %d after move re-join, got %+v", toID, state)
	}
	if !state.ServerMuted {
		t.Error("ServerMuted was cleared by the moderator move, want it to survive")
	}
	if !state.ServerDeafened {
		t.Error("ServerDeafened was cleared by the moderator move, want it to survive")
	}
}

func TestVoiceMod_Move_TextChannelDestination_BadRequest(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-move-bad")
	textID, err := database.CreateChannel(context.Background(), "general-move", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	actor := seedVoiceUserWithRole(t, database, "admin-move-bad", 2)
	target := seedVoiceUserWithRole(t, database, "member-move-bad", 4)

	joinVoice(t, hub, target, fromID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, fromID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, textID))

	if code := receiveErrorCode(send, waitTimeout); code != "BAD_REQUEST" {
		t.Fatalf("error code = %q, want BAD_REQUEST", code)
	}
	state, _ := database.GetVoiceState(context.Background(), target.ID)
	if state == nil {
		t.Error("a refused move must leave the target in voice")
	}
}

// TestVoiceMod_Move_ArchivedDestination_BadRequest locks OC-0072: the move
// pre-flight validates destination type, target access, and capacity, but
// skipped dest.Archived even though the re-join it hands off to
// (handleVoiceJoin) refuses an archived channel outright. Without the gate,
// the pre-flight commits the destructive half of the move — the target is
// dropped from their current channel — for a re-join guaranteed to bounce,
// leaving the target stranded out of voice entirely.
func TestVoiceMod_Move_ArchivedDestination_BadRequest(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-move-archived-from")
	toID := seedVoiceChan(t, database, "vc-move-archived-to")
	if err := database.AdminUpdateChannel(context.Background(), toID, db.ChannelUpdate{
		Name:     "vc-move-archived-to",
		Archived: true,
	}); err != nil {
		t.Fatalf("AdminUpdateChannel: %v", err)
	}
	actor := seedVoiceUserWithRole(t, database, "admin-move-archived", 2)
	target := seedVoiceUserWithRole(t, database, "member-move-archived", 4)

	joinVoice(t, hub, target, fromID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, fromID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	if code := receiveErrorCode(send, waitTimeout); code != "BAD_REQUEST" {
		t.Fatalf("error code = %q, want BAD_REQUEST", code)
	}
	state, err := database.GetVoiceState(context.Background(), target.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil {
		t.Error("a refused move must leave the target in voice")
	} else if state.ChannelID != fromID {
		t.Errorf("target channel = %d, want %d (unchanged)", state.ChannelID, fromID)
	}
}

// TestVoiceMod_Move_TargetCannotConnectToDestination_Forbidden locks the
// destination gate that is evaluated against the TARGET's access, not the
// moderator's: a move must not become a way to place someone in a channel they
// could not join themselves. The actor keeps MUTE_MEMBERS and still outranks
// the target, so only the target's missing CONNECT_VOICE can refuse this.
func TestVoiceMod_Move_TargetCannotConnectToDestination_Forbidden(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-move-noconnect-from")
	toID := seedVoiceChan(t, database, "vc-move-noconnect-to")
	actor := seedVoiceUserWithRole(t, database, "admin-move-noconnect", 2)
	target := seedVoiceUserWithRole(t, database, "member-move-noconnect", 4)

	// Destination denies CONNECT_VOICE to the target's role (Member, id 4).
	if err := database.UpsertChannelOverride(
		context.Background(), toID, 4, 0, permissions.ConnectVoice,
	); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	_, targetSend := joinVoice(t, hub, target, fromID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, fromID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	if code := receiveErrorCode(send, waitTimeout); code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", code)
	}
	if payload := receiveMsgOfType(targetSend, "voice_moved", 100*time.Millisecond); payload != nil {
		t.Errorf("target must not receive voice_moved for a refused move, got %v", payload)
	}
	state, err := database.GetVoiceState(context.Background(), target.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil {
		t.Fatal("a refused move must leave the target in voice")
	} else if state.ChannelID != fromID {
		t.Errorf("target channel = %d, want %d (unchanged)", state.ChannelID, fromID)
	}
	if slices.Contains(auditActions(t, database), "voice_mod_move") {
		t.Error("a refused move must not write a voice_mod_move audit entry")
	}
}

// TestVoiceMod_Kick_EvictionIsScopedToAuthorizedChannel locks the fix for
// v024: voiceModTarget authorizes against a DB snapshot, but the eviction ran
// through the unscoped VoiceModerator.DisconnectFromVoice, which drops the
// target from whatever channel their live connection reports at that instant.
// A channel switch committed on the target's own read-pump goroutine while the
// moderator's checks were in flight therefore redirected the kick onto a
// channel nobody authorized — up to a DM call the actor is not part of.
//
// The interleaving itself is microseconds wide and cannot be forced from a
// test, so the post-condition it produces is staged directly: the DB row (what
// the moderator authorized against) names channel A while the client's
// in-memory voice state — the only thing DisconnectFromVoice reads — already
// names channel B. The eviction must refuse rather than tear the target out of
// B.
func TestVoiceMod_Kick_EvictionIsScopedToAuthorizedChannel(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanA := seedVoiceChan(t, database, "vc-kick-scope-a")
	chanB := seedVoiceChan(t, database, "vc-kick-scope-b")
	actor := seedVoiceUserWithRole(t, database, "admin-kick-scope", 2)
	target := seedVoiceUserWithRole(t, database, "member-kick-scope", 4)

	targetClient, _ := joinVoice(t, hub, target, chanA)
	ws.SetClientVoiceStateForTest(targetClient, chanB, "join-token-b")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanA, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModKickMsg(target.ID))

	if code := receiveErrorCode(send, waitTimeout); code != "VOICE_ERROR" {
		t.Fatalf("error code = %q, want VOICE_ERROR", code)
	}
	if got := ws.GetClientVoiceChIDForTest(targetClient); got != chanB {
		t.Errorf("target voice channel = %d after a kick authorized for channel %d, want %d (the newer membership must survive)",
			got, chanA, chanB)
	}
}

// TestVoiceMod_Move_RefusedMoveClearsPendingModStash locks OC-0278:
// handleVoiceModMoveV2 stashes the target's server_muted/server_deafened onto
// their live connection (stashPendingModFlags) BEFORE the eviction that is
// supposed to justify it. When the target switched channels concurrently —
// staged here the same way TestVoiceMod_Kick_EvictionIsScopedToAuthorizedChannel
// stages it, since the interleaving itself cannot be forced from a test — the
// scoped eviction (DisconnectFromVoiceInChannel) refuses and the move errors
// out, but nothing undoes the stash. The residue has no expiry and no binding
// to this move: the target's next voice_join taken with no live row
// (currentChID == 0) re-applies a server mute nobody currently ordered,
// silently reverting whatever happened to server_muted in the meantime.
//
// A correct refusal must leave no residue: the stash should only survive a
// move that actually evicted the target.
func TestVoiceMod_Move_RefusedMoveClearsPendingModStash(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanA := seedVoiceChan(t, database, "vc-move-stash-a")
	chanB := seedVoiceChan(t, database, "vc-move-stash-b") // where target "concurrently" switched to
	chanC := seedVoiceChan(t, database, "vc-move-stash-c") // intended destination of the move
	actor := seedVoiceUserWithRole(t, database, "admin-move-stash", 2)
	target := seedVoiceUserWithRole(t, database, "member-move-stash", 4)

	targetClient, _ := joinVoice(t, hub, target, chanA)
	if _, err := database.SetVoiceServerMute(context.Background(), target.ID, chanA, true); err != nil {
		t.Fatalf("SetVoiceServerMute: %v", err)
	}
	// Stage the concurrent switch: the DB row (what voiceModTarget authorizes
	// against) still names chanA, but the client's live connection — the only
	// thing the eviction below reads — already names chanB.
	ws.SetClientVoiceStateForTest(targetClient, chanB, "join-token-b")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanA, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, chanC))

	if code := receiveErrorCode(send, waitTimeout); code != "VOICE_ERROR" {
		t.Fatalf("error code = %q, want VOICE_ERROR (move must refuse when the target left the authorized channel)", code)
	}
	if gotMuted, gotDeafened := ws.PeekClientPendingModFlagsForTest(targetClient); gotMuted || gotDeafened {
		t.Errorf("pending mod stash after a refused move = (muted=%v, deafened=%v), want (false, false): "+
			"a refused move must leave no residue for an unrelated later join to re-apply",
			gotMuted, gotDeafened)
	}
}

// ─── self-service controls under a server mute ───────────────────────────────

func TestVoiceMute_SelfUnmuteWhileServerMuted_Refused(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-selfunmute")
	actor := seedVoiceUserWithRole(t, database, "admin-selfunmute", 2)
	target := seedVoiceUserWithRole(t, database, "member-selfunmute", 4)

	targetClient, targetSend := joinVoice(t, hub, target, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	hub.HandleMessageForTest(c, voiceModMuteMsg(chanID, target.ID, true))
	drainChanTimeout(targetSend, 30*time.Millisecond)

	hub.HandleMessageForTest(targetClient, voiceMuteMsg(false))

	if code := receiveErrorCode(targetSend, waitTimeout); code != "SERVER_MUTED" {
		t.Fatalf("error code = %q, want SERVER_MUTED", code)
	}
	state, _ := database.GetVoiceState(context.Background(), target.ID)
	if state == nil || !state.Muted {
		t.Error("target must still be muted after a refused self-unmute")
	}
}

func TestVoiceDeafen_SelfUndeafenWhileServerDeafened_Refused(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-selfundeaf")
	actor := seedVoiceUserWithRole(t, database, "admin-selfundeaf", 2)
	target := seedVoiceUserWithRole(t, database, "member-selfundeaf", 4)

	targetClient, targetSend := joinVoice(t, hub, target, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	hub.HandleMessageForTest(c, voiceModDeafenMsg(chanID, target.ID, true))
	drainChanTimeout(targetSend, 30*time.Millisecond)

	hub.HandleMessageForTest(targetClient, voiceDeafenMsg(false))

	if code := receiveErrorCode(targetSend, waitTimeout); code != "SERVER_DEAFENED" {
		t.Fatalf("error code = %q, want SERVER_DEAFENED", code)
	}
}

func TestVoiceMute_SelfMuteWhileServerMuted_Allowed(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-selfmute-ok")
	actor := seedVoiceUserWithRole(t, database, "admin-selfmute-ok", 2)
	target := seedVoiceUserWithRole(t, database, "member-selfmute-ok", 4)

	targetClient, targetSend := joinVoice(t, hub, target, chanID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	hub.HandleMessageForTest(c, voiceModMuteMsg(chanID, target.ID, true))
	drainChanTimeout(targetSend, 30*time.Millisecond)

	hub.HandleMessageForTest(targetClient, voiceMuteMsg(true))

	if code := receiveErrorCode(targetSend, 200*time.Millisecond); code != "" {
		t.Fatalf("self-mute refused with %q, want no error", code)
	}
}
