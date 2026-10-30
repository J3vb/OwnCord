package ws_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
)

// WP 8.4a: voice_mod_move is gated on MOVE_MEMBERS alone (neither
// MUTE_MEMBERS nor ADMINISTRATOR opens it) and has no rank rule;
// mute, deafen and disconnect keep MUTE_MEMBERS and the rank rule. Roles come
// from the test schema: 1 Owner (100), 2 Admin (80), 3 Moderator (60),
// 4 Member (40). Admin and Moderator carry bit 13 there; only Admin and
// Owner carry MUTE_MEMBERS until a test adds it.

// moveActor registers a connected client for actor in chanID.
func moveActor(t *testing.T, hub *ws.Hub, actor *db.User, chanID int64) (*ws.Client, chan []byte) {
	t.Helper()
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, actor, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	return c, send
}

func setRolePerms(t *testing.T, database *db.DB, roleID int64, perms int64) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(), `UPDATE roles SET permissions = ? WHERE id = ?`, perms, roleID); err != nil {
		t.Fatalf("set role %d permissions: %v", roleID, err)
	}
}

func assertMoved(t *testing.T, database *db.DB, targetSend chan []byte, toID int64) {
	t.Helper()
	payload := receiveMsgOfType(targetSend, "voice_moved", waitTimeout)
	if payload == nil {
		t.Fatal("target did not receive voice_moved")
	}
	if int64(payload["to_channel_id"].(float64)) != toID {
		t.Errorf("to_channel_id = %v, want %d", payload["to_channel_id"], toID)
	}
}

func assertStillIn(t *testing.T, database *db.DB, target *db.User, chanID int64) {
	t.Helper()
	state, err := database.GetVoiceState(context.Background(), target.ID)
	if err != nil || state == nil || state.ChannelID != chanID {
		t.Fatalf("target voice state = %+v, %v; want still in channel %d", state, err, chanID)
	}
}

func TestVoiceMod_Move_HigherRankedTargetWithMoveMembers_Succeeds(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-mv-hi-from")
	toID := seedVoiceChan(t, database, "vc-mv-hi-to")
	actor := seedVoiceUserWithRole(t, database, "mover-lowrank", 3) // Moderator, position 60
	target := seedVoiceUserWithRole(t, database, "admin-target", 2) // Admin, position 80

	_, targetSend := joinVoice(t, hub, target, fromID)
	c, _ := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	assertMoved(t, database, targetSend, toID)
	if !slices.Contains(auditActions(t, database), "voice_mod_move") {
		t.Error("voice_mod_move audit entry missing")
	}
}

func TestVoiceMod_Move_OwnerTarget_SwitchOnByDefault_Succeeds(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-mv-own-from")
	toID := seedVoiceChan(t, database, "vc-mv-own-to")
	actor := seedVoiceUserWithRole(t, database, "mover-owner-on", 3)
	owner := seedVoiceUserWithRole(t, database, "owner-target-on", 1)

	_, ownerSend := joinVoice(t, hub, owner, fromID)
	c, _ := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(owner.ID, toID))

	assertMoved(t, database, ownerSend, toID)
}

func TestVoiceMod_Move_OwnerTarget_SwitchTrueRow_Succeeds(t *testing.T) {
	hub, database := newVoiceModHub(t)
	if err := database.SetSetting(context.Background(), "voice_owner_movable", "true"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	fromID := seedVoiceChan(t, database, "vc-mv-own2-from")
	toID := seedVoiceChan(t, database, "vc-mv-own2-to")
	actor := seedVoiceUserWithRole(t, database, "mover-owner-true", 3)
	owner := seedVoiceUserWithRole(t, database, "owner-target-true", 1)

	_, ownerSend := joinVoice(t, hub, owner, fromID)
	c, _ := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(owner.ID, toID))

	assertMoved(t, database, ownerSend, toID)
}

func TestVoiceMod_Move_OwnerTarget_SwitchOff_Refused(t *testing.T) {
	hub, database := newVoiceModHub(t)
	if err := database.SetSetting(context.Background(), "voice_owner_movable", "false"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	fromID := seedVoiceChan(t, database, "vc-mv-off-from")
	toID := seedVoiceChan(t, database, "vc-mv-off-to")
	actor := seedVoiceUserWithRole(t, database, "mover-owner-off", 3)
	owner := seedVoiceUserWithRole(t, database, "owner-target-off", 1)
	member := seedVoiceUserWithRole(t, database, "member-target-off", 4)

	_, ownerSend := joinVoice(t, hub, owner, fromID)
	_, memberSend := joinVoice(t, hub, member, fromID)
	c, send := moveActor(t, hub, actor, fromID)

	hub.HandleMessageForTest(c, voiceModMoveMsg(owner.ID, toID))
	frame, ok := receiveErrorFrame(send, waitTimeout)
	if !ok || frame.Code != "FORBIDDEN" || frame.Message != "the owner cannot be moved" {
		t.Fatalf("error frame = %+v (ok=%v), want FORBIDDEN \"the owner cannot be moved\"", frame, ok)
	}
	if payload := receiveMsgOfType(ownerSend, "voice_moved", 100*time.Millisecond); payload != nil {
		t.Errorf("owner must not receive voice_moved, got %v", payload)
	}
	assertStillIn(t, database, owner, fromID)

	// Everyone else stays movable with the switch off.
	hub.HandleMessageForTest(c, voiceModMoveMsg(member.ID, toID))
	assertMoved(t, database, memberSend, toID)
}

func TestVoiceMod_Move_OwnerTarget_SwitchUnreadable_FailsClosed(t *testing.T) {
	hub, database := newVoiceModHub(t)
	if err := database.SetSetting(context.Background(), "voice_owner_movable", "not-a-bool"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	fromID := seedVoiceChan(t, database, "vc-mv-junk-from")
	toID := seedVoiceChan(t, database, "vc-mv-junk-to")
	actor := seedVoiceUserWithRole(t, database, "mover-owner-junk", 3)
	owner := seedVoiceUserWithRole(t, database, "owner-target-junk", 1)

	joinVoice(t, hub, owner, fromID)
	c, send := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(owner.ID, toID))

	frame, ok := receiveErrorFrame(send, waitTimeout)
	if !ok || frame.Code != "FORBIDDEN" || frame.Message != "the owner cannot be moved" {
		t.Fatalf("error frame = %+v (ok=%v), want FORBIDDEN \"the owner cannot be moved\"", frame, ok)
	}
	assertStillIn(t, database, owner, fromID)
}

// Mute, deafen and disconnect keep the rank rule even for an actor who holds
// both MOVE_MEMBERS and MUTE_MEMBERS.
func TestVoiceMod_MuteDeafenKick_HigherRankedTargetStillRefusedWithMoveMembers(t *testing.T) {
	hub, database := newVoiceModHub(t)
	chanID := seedVoiceChan(t, database, "vc-mv-rank-keep")
	// Moderator (60) gets MUTE_MEMBERS on top of its bit-13 MOVE_MEMBERS.
	setRolePerms(t, database, 3, 0xFFFFF|permissions.MuteMembers)
	actor := seedVoiceUserWithRole(t, database, "mover-muter", 3)
	target := seedVoiceUserWithRole(t, database, "admin-rank-keep", 2)

	_, targetSend := joinVoice(t, hub, target, chanID)
	c, send := moveActor(t, hub, actor, chanID)

	for name, msg := range map[string][]byte{
		"mute":   voiceModMuteMsg(chanID, target.ID, true),
		"deafen": voiceModDeafenMsg(chanID, target.ID, true),
		"kick":   voiceModKickMsg(target.ID),
	} {
		hub.HandleMessageForTest(c, msg)
		frame, ok := receiveErrorFrame(send, waitTimeout)
		if !ok || frame.Code != "FORBIDDEN" || frame.Message != "cannot moderate a user of equal or higher rank" {
			t.Errorf("%s: error frame = %+v (ok=%v), want FORBIDDEN rank refusal", name, frame, ok)
		}
	}
	state, err := database.GetVoiceState(context.Background(), target.ID)
	if err != nil || state == nil || state.ServerMuted || state.ServerDeafened {
		t.Fatalf("target state = %+v, %v; want untouched, still in voice", state, err)
	}
	if payload := receiveMsgOfType(targetSend, "voice_disconnected", 100*time.Millisecond); payload != nil {
		t.Errorf("target must not be disconnected, got %v", payload)
	}
}

// insertMuteOnlyRole adds role 9 (position 50) holding MUTE_MEMBERS and no
// MOVE_MEMBERS.
func insertMuteOnlyRole(t *testing.T, database *db.DB) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (9, 'muter', ?, 50, 0)`,
		permissions.ReadMessages|permissions.ConnectVoice|permissions.MuteMembers); err != nil {
		t.Fatalf("insert role: %v", err)
	}
}

// assertMoveRefused checks the actor got the missing-bit refusal and the
// target was neither told to move nor moved.
func assertMoveRefused(t *testing.T, database *db.DB, send, targetSend chan []byte, target *db.User, fromID int64) {
	t.Helper()
	frame, ok := receiveErrorFrame(send, waitTimeout)
	if !ok || frame.Code != "FORBIDDEN" || frame.Message != "missing MOVE_MEMBERS permission" {
		t.Fatalf("error frame = %+v (ok=%v), want FORBIDDEN missing MOVE_MEMBERS", frame, ok)
	}
	if payload := receiveMsgOfType(targetSend, "voice_moved", 100*time.Millisecond); payload != nil {
		t.Errorf("target must not receive voice_moved, got %v", payload)
	}
	assertStillIn(t, database, target, fromID)
}

// MUTE_MEMBERS no longer opens a move, not even of a member the actor
// outranks: only MOVE_MEMBERS does.
func TestVoiceMod_Move_MuteMembersOnly_CannotMoveLowerRank(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-mv-muteonly-from")
	toID := seedVoiceChan(t, database, "vc-mv-muteonly-to")
	insertMuteOnlyRole(t, database)
	actor := seedVoiceUserWithRole(t, database, "mute-only", 9)
	target := seedVoiceUserWithRole(t, database, "member-mute-only", 4)

	_, targetSend := joinVoice(t, hub, target, fromID)
	c, send := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	assertMoveRefused(t, database, send, targetSend, target, fromID)
}

// The reported case: the owner takes MOVE_MEMBERS off the Admin role, which
// keeps MUTE_MEMBERS, and an admin can no longer move a member.
func TestVoiceMod_Move_AdminRoleWithoutMoveMembers_Refused(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-mv-admin-off-from")
	toID := seedVoiceChan(t, database, "vc-mv-admin-off-to")
	adminRole, err := database.GetRoleByID(context.Background(), 2)
	if err != nil || adminRole == nil {
		t.Fatalf("GetRoleByID(2) = %v, %v", adminRole, err)
	}
	setRolePerms(t, database, 2, adminRole.Permissions&^permissions.MoveMembers|permissions.MuteMembers)
	actor := seedVoiceUserWithRole(t, database, "admin-move-off", 2)
	target := seedVoiceUserWithRole(t, database, "member-admin-move-off", 4)

	_, targetSend := joinVoice(t, hub, target, fromID)
	c, send := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	assertMoveRefused(t, database, send, targetSend, target, fromID)
}

// ADMINISTRATOR does not stand in for MOVE_MEMBERS: a role carrying it but
// not the move bit cannot move anyone, while it still mutes.
func TestVoiceMod_Move_AdministratorWithoutMoveMembers_Refused(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-mv-administrator-from")
	toID := seedVoiceChan(t, database, "vc-mv-administrator-to")
	setRolePerms(t, database, 2, permissions.Administrator|permissions.ReadMessages|permissions.ConnectVoice)
	actor := seedVoiceUserWithRole(t, database, "administrator-no-move", 2)
	target := seedVoiceUserWithRole(t, database, "member-administrator-no-move", 4)

	_, targetSend := joinVoice(t, hub, target, fromID)
	c, send := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))
	assertMoveRefused(t, database, send, targetSend, target, fromID)

	setRolePerms(t, database, 2, permissions.Administrator|permissions.MoveMembers|permissions.ReadMessages|permissions.ConnectVoice)
	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))
	assertMoved(t, database, targetSend, toID)
}

// MOVE_MEMBERS granted only by a secondary role still moves a higher-ranked
// target: the mask is the OR of every held role.
func TestVoiceMod_Move_MoveMembersFromSecondaryRole_MovesHigherRank(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-mv-multi-from")
	toID := seedVoiceChan(t, database, "vc-mv-multi-to")
	for _, r := range []struct {
		id    int
		name  string
		perms int64
		pos   int
	}{
		{12, "plain-top", permissions.ReadMessages | permissions.ConnectVoice, 50},
		{13, "movers", permissions.ReadMessages | permissions.MoveMembers, 45},
	} {
		if _, err := database.ExecContext(context.Background(),
			`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (?, ?, ?, ?, 0)`,
			r.id, r.name, r.perms, r.pos); err != nil {
			t.Fatalf("insert role %d: %v", r.id, err)
		}
	}
	actor := seedVoiceUserWithRole(t, database, "multi-role-mover", 12)
	if _, err := database.GrantUserRole(context.Background(), actor.ID, 13); err != nil {
		t.Fatalf("GrantUserRole: %v", err)
	}
	target := seedVoiceUserWithRole(t, database, "admin-multi-target", 2)

	_, targetSend := joinVoice(t, hub, target, fromID)
	c, _ := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	assertMoved(t, database, targetSend, toID)
}

// Without MOVE_MEMBERS a target who is not in voice must be indistinguishable
// from one who is: the same refusal either way, for a role with no bit, one
// with only MUTE_MEMBERS and one with only ADMINISTRATOR.
func TestVoiceMod_Move_WithoutMoveMembers_CannotProbeVoicePresence(t *testing.T) {
	for _, tc := range []struct {
		name  string
		perms int64
	}{
		{"neither bit", permissions.ReadMessages | permissions.ConnectVoice},
		{"mute only", permissions.ReadMessages | permissions.ConnectVoice | permissions.MuteMembers},
		{"administrator only", permissions.Administrator},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hub, database := newVoiceModHub(t)
			fromID := seedVoiceChan(t, database, "vc-mv-probe-from")
			toID := seedVoiceChan(t, database, "vc-mv-probe-to")
			// Outranks the targets: the refusal must not depend on whether
			// the target is in voice.
			if _, err := database.ExecContext(context.Background(),
				`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (14, 'plain', ?, 50, 0)`,
				tc.perms); err != nil {
				t.Fatalf("insert role: %v", err)
			}
			actor := seedVoiceUserWithRole(t, database, "no-move-probe", 14)
			inVoice := seedVoiceUserWithRole(t, database, "probe-in", 4)
			absent := seedVoiceUserWithRole(t, database, "probe-out", 4)

			joinVoice(t, hub, inVoice, fromID)
			c, send := moveActor(t, hub, actor, fromID)

			hub.HandleMessageForTest(c, voiceModMoveMsg(inVoice.ID, toID))
			gotIn, ok1 := receiveErrorFrame(send, waitTimeout)
			hub.HandleMessageForTest(c, voiceModMoveMsg(absent.ID, toID))
			gotOut, ok2 := receiveErrorFrame(send, waitTimeout)
			if !ok1 || !ok2 || gotIn != gotOut || gotIn.Code != "FORBIDDEN" || gotIn.Message != "missing MOVE_MEMBERS permission" {
				t.Fatalf("in-voice = %+v, absent = %+v; want identical FORBIDDEN refusals", gotIn, gotOut)
			}
		})
	}
}

// The owner keeps moving members, even out of a channel whose user override
// denies them MOVE_MEMBERS: the owner's Administrator bit ignores overrides.
func TestVoiceMod_Move_OwnerMovesDespiteChannelDeny(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-mv-owner-from")
	toID := seedVoiceChan(t, database, "vc-mv-owner-to")
	actor := seedVoiceUserWithRole(t, database, "owner-mover", 1)
	target := seedVoiceUserWithRole(t, database, "member-owner-moved", 4)
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, 0, ?)`,
		fromID, actor.ID, permissions.MoveMembers); err != nil {
		t.Fatalf("insert user override: %v", err)
	}

	_, targetSend := joinVoice(t, hub, target, fromID)
	c, _ := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	assertMoved(t, database, targetSend, toID)
}

func TestVoiceMod_Move_MoverCannotSeeDestination_NotFound(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-mv-hidden-from")
	toID := seedVoiceChan(t, database, "vc-mv-hidden-to")
	// The destination is hidden from the mover's role (Moderator, id 3) but
	// not from the target's (Member, id 4).
	if err := database.UpsertChannelOverride(context.Background(), toID, 3, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	actor := seedVoiceUserWithRole(t, database, "mover-blind", 3)
	target := seedVoiceUserWithRole(t, database, "member-blind", 4)

	_, targetSend := joinVoice(t, hub, target, fromID)
	c, send := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	hiddenFrame, ok := receiveErrorFrame(send, waitTimeout)
	if !ok || hiddenFrame.Code != "NOT_FOUND" || hiddenFrame.Message != "channel not found" {
		t.Fatalf("error frame = %+v (ok=%v), want NOT_FOUND \"channel not found\"", hiddenFrame, ok)
	}
	// Byte-identical to a channel that does not exist.
	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID+1000))
	missingFrame, ok := receiveErrorFrame(send, waitTimeout)
	if !ok || missingFrame != hiddenFrame {
		t.Errorf("missing-channel frame = %+v, want %+v", missingFrame, hiddenFrame)
	}
	if payload := receiveMsgOfType(targetSend, "voice_moved", 100*time.Millisecond); payload != nil {
		t.Errorf("target must not receive voice_moved, got %v", payload)
	}
	assertStillIn(t, database, target, fromID)
}

// The extra per-target limit (3 per 30 s) applies only to a move that uses
// the rank bypass.
func TestVoiceMod_Move_PerTargetLimit_OnlyForRankBypass(t *testing.T) {
	limiter := auth.NewRateLimiter()
	hub, database := newVoiceModHubWithLimiter(t, limiter)
	fromID := seedVoiceChan(t, database, "vc-mv-lim-from")
	toID := seedVoiceChan(t, database, "vc-mv-lim-to")
	actor := seedVoiceUserWithRole(t, database, "mover-limited", 3)  // Moderator, 60
	higher := seedVoiceUserWithRole(t, database, "admin-limited", 2) // 80: bypass
	lower := seedVoiceUserWithRole(t, database, "member-limited", 4) // 40: no bypass

	for _, id := range []int64{higher.ID, lower.ID} {
		for range 3 {
			limiter.Allow(auth.Key("voice_mod_move_target", id), 3, 30*time.Second)
		}
	}

	_, higherSend := joinVoice(t, hub, higher, fromID)
	_, lowerSend := joinVoice(t, hub, lower, fromID)
	c, send := moveActor(t, hub, actor, fromID)

	hub.HandleMessageForTest(c, voiceModMoveMsg(higher.ID, toID))
	if code := receiveErrorCode(send, waitTimeout); code != "RATE_LIMITED" {
		t.Fatalf("bypass move code = %q, want RATE_LIMITED", code)
	}
	if payload := receiveMsgOfType(higherSend, "voice_moved", 100*time.Millisecond); payload != nil {
		t.Errorf("rate-limited target must not receive voice_moved, got %v", payload)
	}
	assertStillIn(t, database, higher, fromID)

	hub.HandleMessageForTest(c, voiceModMoveMsg(lower.ID, toID))
	assertMoved(t, database, lowerSend, toID)
}

// A target of EQUAL rank is also a bypass: the actor does not strictly outrank
// them, so the per-target limit applies.
func TestVoiceMod_Move_PerTargetLimit_AppliesToEqualRank(t *testing.T) {
	limiter := auth.NewRateLimiter()
	hub, database := newVoiceModHubWithLimiter(t, limiter)
	fromID := seedVoiceChan(t, database, "vc-mv-eq-from")
	toID := seedVoiceChan(t, database, "vc-mv-eq-to")
	actor := seedVoiceUserWithRole(t, database, "mover-equal", 3)
	peer := seedVoiceUserWithRole(t, database, "moderator-peer", 3)
	for range 3 {
		limiter.Allow(auth.Key("voice_mod_move_target", peer.ID), 3, 30*time.Second)
	}

	_, peerSend := joinVoice(t, hub, peer, fromID)
	c, send := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(peer.ID, toID))

	if code := receiveErrorCode(send, waitTimeout); code != "RATE_LIMITED" {
		t.Fatalf("equal-rank move code = %q, want RATE_LIMITED", code)
	}
	if payload := receiveMsgOfType(peerSend, "voice_moved", 100*time.Millisecond); payload != nil {
		t.Errorf("rate-limited peer must not receive voice_moved, got %v", payload)
	}
	assertStillIn(t, database, peer, fromID)
}

// A mover whose READ_MESSAGES comes only from a channel allow (the base role
// holds MOVE_MEMBERS but not READ_MESSAGES) still moves a higher-ranked
// target: the base check looks at the MOVE_MEMBERS bit alone and the channel
// verdict comes from the resolved subject.
func TestVoiceMod_Move_ReadFromChannelAllow_MovesHigherRank(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-mv-ovr-from")
	toID := seedVoiceChan(t, database, "vc-mv-ovr-to")
	setRolePerms(t, database, 3, permissions.MoveMembers|permissions.ConnectVoice)
	for _, ch := range []int64{fromID, toID} {
		if err := database.UpsertChannelOverride(context.Background(), ch, 3, permissions.ReadMessages, 0); err != nil {
			t.Fatalf("UpsertChannelOverride: %v", err)
		}
	}
	actor := seedVoiceUserWithRole(t, database, "mover-ovr-read", 3)
	target := seedVoiceUserWithRole(t, database, "admin-target-ovr", 2)

	_, targetSend := joinVoice(t, hub, target, fromID)
	c, _ := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	assertMoved(t, database, targetSend, toID)
}

// WP 8.4b: a moderator move names the mover so the moved client can say who
// moved it; the AFK sweep's voice_moved (voice_afk_sweep_test.go) names nobody.
func TestVoiceMod_Move_VoiceMovedCarriesMoverID(t *testing.T) {
	hub, database := newVoiceModHub(t)
	fromID := seedVoiceChan(t, database, "vc-mv-by-from")
	toID := seedVoiceChan(t, database, "vc-mv-by-to")
	actor := seedVoiceUserWithRole(t, database, "mover-by", 3)
	target := seedVoiceUserWithRole(t, database, "target-by", 4)

	_, targetSend := joinVoice(t, hub, target, fromID)
	c, _ := moveActor(t, hub, actor, fromID)
	hub.HandleMessageForTest(c, voiceModMoveMsg(target.ID, toID))

	payload := receiveMsgOfType(targetSend, "voice_moved", waitTimeout)
	if payload == nil {
		t.Fatal("target did not receive voice_moved")
	}
	if got, _ := payload["by_user_id"].(float64); int64(got) != actor.ID {
		t.Errorf("by_user_id = %v, want %d", payload["by_user_id"], actor.ID)
	}
	if _, present := payload["reason"]; present {
		t.Errorf("moderator move carries reason %v, want none", payload["reason"])
	}
}
