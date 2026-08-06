package ws_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// absenceWindow is how long an "it must NOT arrive" assertion waits. The
// dispatch it is watching for is synchronous, so anything that was going to
// land has landed well inside it.
const absenceWindow = 100 * time.Millisecond

// ─── helpers ────────────────────────────────────────────────────────────────

// seedGroupDM creates a group DM containing every listed user.
func seedGroupDM(t *testing.T, database *db.DB, name string, userIDs ...int64) int64 {
	t.Helper()
	ch, err := database.CreateGroupDMChannel(context.Background(), name, userIDs)
	if err != nil {
		t.Fatalf("seedGroupDM: %v", err)
	}
	return ch.ID
}

func callMsg(msgType string, channelID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    msgType,
		"payload": map[string]any{"channel_id": channelID},
	})
	return raw
}

// ─── group DM fan-out ───────────────────────────────────────────────────────

// A chat_send into a group DM must reach every other participant, not just
// "the recipient" — the single-recipient assumption the DM path started with.
func TestGroupDM_ChatSendFansOutToAllParticipants(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "grp-send-alice")
	bob := seedMemberUser(t, database, "grp-send-bob")
	carol := seedMemberUser(t, database, "grp-send-carol")
	chID := seedGroupDM(t, database, "Trio", alice.ID, bob.ID, carol.ID)

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	sendCarol := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	cCarol := ws.NewTestClientWithUser(hub, carol, chID, sendCarol)
	hub.Register(cAlice)
	hub.Register(cBob)
	hub.Register(cCarol)
	waitRegistered(t, hub, cCarol)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(chID, "hello everyone"))

	if dmWaitMsgType(sendBob, "chat_message", waitTimeout) == nil {
		t.Error("bob did not receive the group message")
	}
	if dmWaitMsgType(sendCarol, "chat_message", waitTimeout) == nil {
		t.Error("carol did not receive the group message")
	}
}

// Every recipient's dm_channel_open must describe the group from *their* seat:
// they never appear in their own recipients list, and the list is the other two.
func TestGroupDM_ChannelOpenIsPerViewer(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "grp-open-alice")
	bob := seedMemberUser(t, database, "grp-open-bob")
	carol := seedMemberUser(t, database, "grp-open-carol")
	chID := seedGroupDM(t, database, "Openers", alice.ID, bob.ID, carol.ID)

	// A closed DM is what makes the send re-open it and emit dm_channel_open.
	if err := database.CloseDM(context.Background(), bob.ID, chID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}
	if err := database.CloseDM(context.Background(), carol.ID, chID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(chID, "ping"))

	env := dmWaitMsgType(sendBob, "dm_channel_open", waitTimeout)
	if env == nil {
		t.Fatal("bob did not receive dm_channel_open")
	}
	payload, _ := env["payload"].(map[string]any)
	if payload["is_group"] != true {
		t.Errorf("expected is_group=true, got %v", payload["is_group"])
	}
	if payload["name"] != "Openers" {
		t.Errorf("expected the group name on the wire, got %v", payload["name"])
	}
	recips, _ := payload["recipients"].([]any)
	if len(recips) != 2 {
		t.Fatalf("expected bob to see 2 other participants, got %d", len(recips))
	}
	for _, r := range recips {
		m, _ := r.(map[string]any)
		if int64(m["id"].(float64)) == bob.ID {
			t.Error("bob appears in his own recipients list")
		}
	}
}

// Typing already fanned out over dm_participants; this pins that a group's
// third member is included and the sender is not.
func TestGroupDM_TypingReachesAllOthers(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "grp-type-alice")
	bob := seedMemberUser(t, database, "grp-type-bob")
	carol := seedMemberUser(t, database, "grp-type-carol")
	chID := seedGroupDM(t, database, "Typers", alice.ID, bob.ID, carol.ID)

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	sendCarol := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	cCarol := ws.NewTestClientWithUser(hub, carol, chID, sendCarol)
	hub.Register(cAlice)
	hub.Register(cBob)
	hub.Register(cCarol)
	waitRegistered(t, hub, cCarol)

	hub.HandleMessageForTest(cAlice, dmTypingMsg(chID))

	if dmWaitMsgType(sendBob, "typing", waitTimeout) == nil {
		t.Error("bob did not receive the typing indicator")
	}
	if dmWaitMsgType(sendCarol, "typing", waitTimeout) == nil {
		t.Error("carol did not receive the typing indicator")
	}
	if got := dmFindMsgType(dmDrainAll(sendAlice), "typing"); got != nil {
		t.Error("the typist received their own typing indicator")
	}
}

// A block between two members of a group must NOT silence the group: the
// composer gate is a 1:1 rule, and dropping one member's messages for one
// other member would leave them reading different conversations.
func TestGroupDM_BlockDoesNotSilenceGroupSend(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "grp-blk-alice")
	bob := seedMemberUser(t, database, "grp-blk-bob")
	carol := seedMemberUser(t, database, "grp-blk-carol")
	chID := seedGroupDM(t, database, "Blockers", alice.ID, bob.ID, carol.ID)

	if err := database.BlockUser(context.Background(), bob.ID, alice.ID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	sendCarol := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	cCarol := ws.NewTestClientWithUser(hub, carol, chID, sendCarol)
	hub.Register(cAlice)
	hub.Register(cCarol)
	waitRegistered(t, hub, cCarol)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(chID, "still a room"))

	if dmWaitMsgType(sendAlice, "chat_send_ok", waitTimeout) == nil {
		t.Error("a group send was refused because of a block between two members")
	}
	if dmWaitMsgType(sendCarol, "chat_message", waitTimeout) == nil {
		t.Error("carol did not receive the group message")
	}
}

// A 1:1 block must still bite — the group exemption is not a general one.
func TestOneToOneDM_BlockStillRefusesSend(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "one-blk-alice")
	bob := seedMemberUser(t, database, "one-blk-bob")
	chID := seedDMChannel(t, database, alice.ID, bob.ID)

	if err := database.BlockUser(context.Background(), bob.ID, alice.ID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	hub.Register(cAlice)
	waitRegistered(t, hub, cAlice)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(chID, "blocked"))

	if code := dmFindErrorCode(dmCollectAll(sendAlice, absenceWindow)); code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN on a blocked 1:1 send, got %q", code)
	}
}

// ─── call ringing ───────────────────────────────────────────────────────────

func TestCallRing_ForwardsToOtherParticipants(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "ring-alice")
	bob := seedMemberUser(t, database, "ring-bob")
	carol := seedMemberUser(t, database, "ring-carol")
	chID := seedGroupDM(t, database, "Ringers", alice.ID, bob.ID, carol.ID)

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	sendCarol := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	cCarol := ws.NewTestClientWithUser(hub, carol, chID, sendCarol)
	hub.Register(cAlice)
	hub.Register(cBob)
	hub.Register(cCarol)
	waitRegistered(t, hub, cCarol)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))

	env := dmWaitMsgType(sendBob, "call_incoming", waitTimeout)
	if env == nil {
		t.Fatal("bob did not receive call_incoming")
	}
	payload, _ := env["payload"].(map[string]any)
	if int64(payload["channel_id"].(float64)) != chID {
		t.Errorf("call_incoming carried channel %v, want %d", payload["channel_id"], chID)
	}
	if int64(payload["from_user"].(float64)) != alice.ID {
		t.Errorf("call_incoming carried from_user %v, want %d", payload["from_user"], alice.ID)
	}
	if dmWaitMsgType(sendCarol, "call_incoming", waitTimeout) == nil {
		t.Error("carol did not receive call_incoming")
	}
	// The ringer must not ring themselves.
	if got := dmFindMsgType(dmDrainAll(sendAlice), "call_incoming"); got != nil {
		t.Error("the ringer received their own call_incoming")
	}
}

func TestCallRing_NonParticipantForbidden(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "ring-perm-alice")
	bob := seedMemberUser(t, database, "ring-perm-bob")
	mallory := seedMemberUser(t, database, "ring-perm-mallory")
	chID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendMallory := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cMallory := ws.NewTestClientWithUser(hub, mallory, chID, sendMallory)
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	hub.Register(cMallory)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cMallory, callMsg("call_ring", chID))

	if code := dmFindErrorCode(dmCollectAll(sendMallory, absenceWindow)); code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN ringing a DM she is not in, got %q", code)
	}
	if got := dmFindMsgType(dmDrainAll(sendBob), "call_incoming"); got != nil {
		t.Error("a non-participant's ring reached a participant")
	}
}

func TestCallDecline_ForwardsToOtherParticipants(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "decline-alice")
	bob := seedMemberUser(t, database, "decline-bob")
	chID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cBob, callMsg("call_decline", chID))

	env := dmWaitMsgType(sendAlice, "call_declined", waitTimeout)
	if env == nil {
		t.Fatal("the ringer did not receive call_declined")
	}
	payload, _ := env["payload"].(map[string]any)
	if int64(payload["from_user"].(float64)) != bob.ID {
		t.Errorf("call_declined carried from_user %v, want %d", payload["from_user"], bob.ID)
	}
}

func TestCallRing_RateLimited(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "ringlimit-alice")
	bob := seedMemberUser(t, database, "ringlimit-bob")
	chID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendAlice := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	hub.Register(cAlice)
	waitRegistered(t, hub, cAlice)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))
	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))

	if code := dmFindErrorCode(dmCollectAll(sendAlice, absenceWindow)); code != "RATE_LIMITED" {
		t.Errorf("expected RATE_LIMITED on a second immediate ring, got %q", code)
	}
}

func TestCallDecline_RateLimited(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "declinelimit-alice")
	bob := seedMemberUser(t, database, "declinelimit-bob")
	chID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendAlice := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	hub.Register(cAlice)
	waitRegistered(t, hub, cAlice)

	// Same shape as call_ring: each frame costs participant + block lookups
	// and a fan-out to every other participant, so it needs the same limit.
	hub.HandleMessageForTest(cAlice, callMsg("call_decline", chID))
	hub.HandleMessageForTest(cAlice, callMsg("call_decline", chID))

	if code := dmFindErrorCode(dmCollectAll(sendAlice, absenceWindow)); code != "RATE_LIMITED" {
		t.Errorf("expected RATE_LIMITED on a second immediate decline, got %q", code)
	}
	_ = bob
}

// A block must silence the 1:1 ring like every other DM sink: without it a
// blocked user could still make the blocker's client ring (A-2026-08-03).
func TestCallRing_BlockedOneToOneForbidden(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "ring-blk-alice")
	bob := seedMemberUser(t, database, "ring-blk-bob")
	chID := seedDMChannel(t, database, alice.ID, bob.ID)

	if err := database.BlockUser(context.Background(), bob.ID, alice.ID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))

	if code := dmFindErrorCode(dmCollectAll(sendAlice, absenceWindow)); code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN ringing a blocked 1:1 DM, got %q", code)
	}
	if got := dmFindMsgType(dmDrainAll(sendBob), "call_incoming"); got != nil {
		t.Error("a blocked user's ring reached the blocker")
	}
}

// The group exemption applies to rings exactly as it does to sends: a block
// between two members must not silence the room's call signal for everyone.
func TestCallRing_GroupWithInternalBlockStillRings(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "ring-gblk-alice")
	bob := seedMemberUser(t, database, "ring-gblk-bob")
	carol := seedMemberUser(t, database, "ring-gblk-carol")
	chID := seedGroupDM(t, database, "BlockedRingers", alice.ID, bob.ID, carol.ID)

	if err := database.BlockUser(context.Background(), bob.ID, alice.ID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	sendBob := make(chan []byte, 64)
	sendCarol := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, make(chan []byte, 64))
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	cCarol := ws.NewTestClientWithUser(hub, carol, chID, sendCarol)
	hub.Register(cAlice)
	hub.Register(cBob)
	hub.Register(cCarol)
	waitRegistered(t, hub, cCarol)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))

	if dmWaitMsgType(sendBob, "call_incoming", waitTimeout) == nil {
		t.Error("a group ring was silenced by a block between two members")
	}
	if dmWaitMsgType(sendCarol, "call_incoming", waitTimeout) == nil {
		t.Error("carol did not receive the group call_incoming")
	}
}

func TestCallRing_RejectsNonPositiveChannel(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "ringbad-alice")

	sendAlice := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, 0, sendAlice)
	hub.Register(cAlice)
	waitRegistered(t, hub, cAlice)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", 0))

	if code := dmFindErrorCode(dmCollectAll(sendAlice, absenceWindow)); code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for channel_id 0, got %q", code)
	}
}
