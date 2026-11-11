package ws_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// absenceWindow is how long an "it must NOT arrive" assertion waits. The
// dispatch it is watching for is synchronous, so anything that was going to
// land has landed well inside it.
const absenceWindow = 100 * time.Millisecond

// ─── helpers ────────────────────────────────────────────────────────────────

// seedGroupDM creates a group DM containing every listed user.
func seedGroupDM(t *testing.T, database *db.DB, name string, userIDs ...int64) int64 {
	t.Helper()
	ch, err := database.CreateGroupDMChannel(context.Background(), name, userIDs[0], userIDs)
	if err != nil {
		t.Fatalf("seedGroupDM: %v", err)
	}
	return ch.ID
}

// newGroupDMTrio builds a handler hub with an owner, two members and a group
// DM of the three, named after tag so usernames stay unique per test.
func newGroupDMTrio(t *testing.T, tag, name string) (*ws.Hub, *db.DB, *db.User, *db.User, *db.User, int64) {
	t.Helper()
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, tag+"-alice")
	bob := seedMemberUser(t, database, tag+"-bob")
	carol := seedMemberUser(t, database, tag+"-carol")
	chID := seedGroupDM(t, database, name, alice.ID, bob.ID, carol.ID)
	return hub, database, alice, bob, carol, chID
}

// connectRingPair registers alice (already in the call, as a ring requires)
// and bob on chID and returns alice's client and bob's send queue.
func connectRingPair(t *testing.T, hub *ws.Hub, alice, bob *db.User, chID int64) (*ws.Client, chan []byte) {
	t.Helper()
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, make(chan []byte, 64))
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)
	ws.SetVoiceChIDForTest(cAlice, chID)
	return cAlice, sendBob
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
	hub, _, alice, bob, carol, chID := newGroupDMTrio(t, "grp-send", "Trio")

	cAlice, _ := connectClient(t, hub, alice, chID, 64)
	_, sendBob := connectClient(t, hub, bob, chID, 64)
	_, sendCarol := connectClient(t, hub, carol, chID, 64)

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
	hub, database, alice, bob, carol, chID := newGroupDMTrio(t, "grp-open", "Openers")

	// A closed DM is what makes the send re-open it and emit dm_channel_open.
	if err := database.CloseDM(context.Background(), bob.ID, chID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}
	if err := database.CloseDM(context.Background(), carol.ID, chID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	cAlice, _ := connectClient(t, hub, alice, chID, 64)
	_, sendBob := connectClient(t, hub, bob, chID, 64)

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

// A send that re-opens a closed group DM builds a dm_channel_open, and that
// frame must carry the group's owner_id: it is how a client learns the room has
// owners at all (WP 3B-10a review item).
func TestGroupDM_ReopenOnSendCarriesOwnerID(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "grp-owner-alice")
	bob := seedMemberUser(t, database, "grp-owner-bob")
	carol := seedMemberUser(t, database, "grp-owner-carol")
	// seedGroupDM makes the first user the owner.
	chID := seedGroupDM(t, database, "Owned", alice.ID, bob.ID, carol.ID)
	if err := database.CloseDM(context.Background(), bob.ID, chID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	cAlice, _ := connectClient(t, hub, alice, chID, 64)
	_, sendBob := connectClient(t, hub, bob, chID, 64)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(chID, "ping"))

	env := dmWaitMsgType(sendBob, "dm_channel_open", waitTimeout)
	if env == nil {
		t.Fatal("bob did not receive dm_channel_open")
	}
	payload, _ := env["payload"].(map[string]any)
	if got, ok := payload["owner_id"].(float64); !ok || int64(got) != alice.ID {
		t.Errorf("dm_channel_open owner_id = %v, want %d (the creator)", payload["owner_id"], alice.ID)
	}
}

// Typing already fanned out over dm_participants; this pins that a group's
// third member is included and the sender is not.
func TestGroupDM_TypingReachesAllOthers(t *testing.T) {
	hub, _, alice, bob, carol, chID := newGroupDMTrio(t, "grp-type", "Typers")

	cAlice, sendAlice := connectClient(t, hub, alice, chID, 64)
	_, sendBob := connectClient(t, hub, bob, chID, 64)
	_, sendCarol := connectClient(t, hub, carol, chID, 64)

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
	hub, database, alice, bob, carol, chID := newGroupDMTrio(t, "grp-blk", "Blockers")

	if err := database.BlockUser(context.Background(), bob.ID, alice.ID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	cAlice, sendAlice := connectClient(t, hub, alice, chID, 64)
	_, sendCarol := connectClient(t, hub, carol, chID, 64)

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

	cAlice, sendAlice := connectClient(t, hub, alice, chID, 64)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(chID, "blocked"))

	if code := dmFindErrorCode(dmCollectAll(sendAlice, absenceWindow)); code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN on a blocked 1:1 send, got %q", code)
	}
}

// ─── call ringing ───────────────────────────────────────────────────────────

func TestCallRing_ForwardsToOtherParticipants(t *testing.T) {
	hub, _, alice, bob, carol, chID := newGroupDMTrio(t, "ring", "Ringers")

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	sendCarol := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	cCarol := ws.NewTestClientWithUser(hub, carol, chID, sendCarol)
	hub.Register(cAlice)
	ws.SetVoiceChIDForTest(cAlice, chID) // a ring comes from inside the call
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

	cMallory, sendMallory := connectClient(t, hub, mallory, chID, 64)
	_, sendBob := connectClient(t, hub, bob, chID, 64)

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

	_, sendAlice := connectClient(t, hub, alice, chID, 64)
	cBob, _ := connectClient(t, hub, bob, chID, 64)

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

func TestCallDecline_ReachesTheDeclinersOtherDevices(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "decline-dev-alice")
	bob := seedMemberUser(t, database, "decline-dev-bob")
	chID := seedDMChannel(t, database, alice.ID, bob.ID)

	// Three devices of one account are three connections with their own
	// sessions. Only the second declares call_sync; the third is an older client.
	sendBobFirst := make(chan []byte, 64)
	cBob := ws.NewTestClientWithTokenHash(hub, bob, "decline-dev-hash-1", chID, sendBobFirst)
	hub.Register(cBob)
	sendBobSecond := make(chan []byte, 64)
	cBob2 := ws.NewTestClientWithTokenHash(hub, bob, "decline-dev-hash-2", chID, sendBobSecond)
	ws.DeclareFeaturesForTest(cBob2, "call_sync")
	hub.Register(cBob2)
	sendBobOld := make(chan []byte, 64)
	cBobOld := ws.NewTestClientWithTokenHash(hub, bob, "decline-dev-hash-3", chID, sendBobOld)
	hub.Register(cBobOld)
	waitRegistered(t, hub, cBobOld)
	_, sendAlice := connectClient(t, hub, alice, chID, 64)

	hub.HandleMessageForTest(cBob, callMsg("call_decline", chID))

	// Bob's second device hears his decline; so does the ringer.
	env := dmWaitMsgType(sendBobSecond, "call_declined", waitTimeout)
	if env == nil {
		t.Fatal("the decliner's other device did not receive call_declined")
	}
	payload, _ := env["payload"].(map[string]any)
	if int64(payload["from_user"].(float64)) != bob.ID {
		t.Errorf("call_declined carried from_user %v, want %d", payload["from_user"], bob.ID)
	}
	if dmWaitMsgType(sendAlice, "call_declined", waitTimeout) == nil {
		t.Error("the ringer did not receive call_declined")
	}
	if dmWaitMsgType(sendAlice, "call_declined", 150*time.Millisecond) != nil {
		t.Error("the ringer received call_declined twice")
	}
	if dmWaitMsgType(sendBobOld, "call_declined", 150*time.Millisecond) != nil {
		t.Error("a device that did not declare call_sync received its own account's decline")
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
	ws.SetVoiceChIDForTest(cAlice, chID) // a ring comes from inside the call
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

	cAlice, sendAlice := connectClient(t, hub, alice, chID, 64)

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

	cAlice, sendAlice := connectClient(t, hub, alice, chID, 64)
	_, sendBob := connectClient(t, hub, bob, chID, 64)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))

	if code := dmFindErrorCode(dmCollectAll(sendAlice, absenceWindow)); code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN ringing a blocked 1:1 DM, got %q", code)
	}
	if got := dmFindMsgType(dmDrainAll(sendBob), "call_incoming"); got != nil {
		t.Error("a blocked user's ring reached the blocker")
	}
}

// TestCallRing_UntrustedRecipientDoesNotRing is B5-6's Codex P1-2 fix plus
// DM call review D-03: call_ring/call_incoming is a DM interaction like chat,
// typing and reactions, so an untrusted recipient of a pending request is
// never rung. The caller is told at once, with one code that names no
// recipient state, instead of waiting out a 30 s ring nobody can hear.
func TestCallRing_UntrustedRecipientDoesNotRing(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "ring-untrusted-alice")
	bob := seedMemberUser(t, database, "ring-untrusted-bob")
	chID := untrustedDMChannel(t, database, alice.ID, bob.ID)

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	hub.Register(cAlice)
	ws.SetVoiceChIDForTest(cAlice, chID) // a ring comes from inside the call
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))

	if code := dmFindErrorCode(dmCollectAll(sendAlice, absenceWindow)); code != "CALL_REQUIRES_ACCEPTANCE" {
		t.Errorf("expected CALL_REQUIRES_ACCEPTANCE ringing an untrusted recipient, got %q", code)
	}
	if got := dmFindMsgType(dmDrainAll(sendBob), "call_incoming"); got != nil {
		t.Error("an untrusted recipient of a pending request received call_incoming")
	}
}

// A decline is not a ring: the refusal D-03 adds to call_ring must not leak
// into call_decline, which stays a silent no-target success.
func TestCallDecline_UntrustedRecipientStaysSilent(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "decl-untrusted-alice")
	bob := seedMemberUser(t, database, "decl-untrusted-bob")
	chID := untrustedDMChannel(t, database, alice.ID, bob.ID)

	cAlice, sendAlice := connectClient(t, hub, alice, chID, 64)
	_, sendBob := connectClient(t, hub, bob, chID, 64)

	hub.HandleMessageForTest(cAlice, callMsg("call_decline", chID))

	if code := dmFindErrorCode(dmCollectAll(sendAlice, absenceWindow)); code != "" {
		t.Errorf("call_decline must stay a success, got error code %q", code)
	}
	if got := dmFindMsgType(dmDrainAll(sendBob), "call_declined"); got != nil {
		t.Error("an untrusted recipient received call_declined")
	}
}

// The group exemption applies to rings exactly as it does to sends: a block
// between two members must not silence the room's call signal for everyone.
func TestCallRing_GroupWithInternalBlockStillRings(t *testing.T) {
	hub, database, alice, bob, carol, chID := newGroupDMTrio(t, "ring-gblk", "BlockedRingers")

	if err := database.BlockUser(context.Background(), bob.ID, alice.ID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	sendBob := make(chan []byte, 64)
	sendCarol := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, make(chan []byte, 64))
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	cCarol := ws.NewTestClientWithUser(hub, carol, chID, sendCarol)
	hub.Register(cAlice)
	ws.SetVoiceChIDForTest(cAlice, chID) // a ring comes from inside the call
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

	cAlice, sendAlice := connectClient(t, hub, alice, 0, 64)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", 0))

	if code := dmFindErrorCode(dmCollectAll(sendAlice, absenceWindow)); code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for channel_id 0, got %q", code)
	}
}

// ─── ring reopens a closed DM; ring needs the caller in the call ────────────

// D-04: a ring into a DM the callee had closed must put the DM back in their
// sidebar, and the dm_channel_open must precede the call_incoming so the client
// already has the channel when the banner renders.
func TestCallRing_ReopensClosedDMBeforeIncoming(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "ring-reopen-alice")
	bob := seedMemberUser(t, database, "ring-reopen-bob")
	chID := seedDMChannel(t, database, alice.ID, bob.ID)
	if err := database.CloseDM(context.Background(), bob.ID, chID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	cAlice, sendBob := connectRingPair(t, hub, alice, bob, chID)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))

	var order []string
	for _, m := range dmCollectAll(sendBob, absenceWindow) {
		if m["type"] == "dm_channel_open" || m["type"] == "call_incoming" {
			order = append(order, m["type"].(string))
		}
	}
	if len(order) != 2 || order[0] != "dm_channel_open" || order[1] != "call_incoming" {
		t.Fatalf("bob's frames = %v, want [dm_channel_open call_incoming]", order)
	}
	open, err := database.GetUserDMChannels(context.Background(), bob.ID)
	if err != nil {
		t.Fatalf("GetOpenDMChannels: %v", err)
	}
	if len(open) != 1 || open[0].ChannelID != chID {
		t.Errorf("bob's open DMs = %v, want the rung channel %d", open, chID)
	}
}

// An already-open DM must not emit a dm_channel_open per ring (OC-0106): each
// one forces every other client's reconnect onto a full resync.
func TestCallRing_OpenDMEmitsNoChannelOpen(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "ring-open-alice")
	bob := seedMemberUser(t, database, "ring-open-bob")
	chID := seedDMChannel(t, database, alice.ID, bob.ID)

	cAlice, sendBob := connectRingPair(t, hub, alice, bob, chID)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))

	msgs := dmCollectAll(sendBob, absenceWindow)
	if dmFindMsgType(msgs, "call_incoming") == nil {
		t.Fatal("bob did not receive call_incoming")
	}
	if dmFindMsgType(msgs, "dm_channel_open") != nil {
		t.Error("ringing an already-open DM emitted dm_channel_open")
	}
}

// Untrusted recipients are neither reopened nor rung.
func TestCallRing_UntrustedRecipientIsNotReopened(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "ring-untrust-reopen-alice")
	bob := seedMemberUser(t, database, "ring-untrust-reopen-bob")
	chID := untrustedDMChannel(t, database, alice.ID, bob.ID)
	if err := database.CloseDM(context.Background(), bob.ID, chID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	cAlice, sendBob := connectRingPair(t, hub, alice, bob, chID)

	hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))

	msgs := dmCollectAll(sendBob, absenceWindow)
	if dmFindMsgType(msgs, "dm_channel_open") != nil || dmFindMsgType(msgs, "call_incoming") != nil {
		t.Error("an untrusted recipient was reopened or rung")
	}
}

// D-02 (server half): a ring from someone who is not in that DM's voice
// channel is refused and nobody is rung.
func TestCallRing_RefusedWhenCallerNotInCall(t *testing.T) {
	for name, voiceCh := range map[string]func(chID int64) int64{
		"in no voice channel":      func(int64) int64 { return 0 },
		"in another voice channel": func(chID int64) int64 { return chID + 1000 },
	} {
		t.Run(name, func(t *testing.T) {
			hub, database := newHandlerHub(t)
			alice := seedOwnerUser(t, database, "ring-notin-alice")
			bob := seedMemberUser(t, database, "ring-notin-bob")
			chID := seedDMChannel(t, database, alice.ID, bob.ID)

			cAlice, sendAlice := connectClient(t, hub, alice, chID, 64)
			_, sendBob := connectClient(t, hub, bob, chID, 64)
			ws.SetVoiceChIDForTest(cAlice, voiceCh(chID))

			hub.HandleMessageForTest(cAlice, callMsg("call_ring", chID))

			if code := dmFindErrorCode(dmCollectAll(sendAlice, absenceWindow)); code != "VOICE_ERROR" {
				t.Errorf("expected VOICE_ERROR ringing without being in the call, got %q", code)
			}
			if got := dmFindMsgType(dmDrainAll(sendBob), "call_incoming"); got != nil {
				t.Error("a ring from outside the call reached bob")
			}
		})
	}
}
