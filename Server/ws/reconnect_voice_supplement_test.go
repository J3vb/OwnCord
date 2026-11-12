package ws

// reconnect_voice_supplement_test.go — regression test for finding v107.
//
// Voice membership can outlive READ_MESSAGES (a mid-call revocation, or a
// closed DM), and the live fan-out path deliberately unions the READ audience with the room's
// current participants for exactly that reason (broadcastVoiceEvent). Replay,
// though, filtered purely on computeAllowedChannels — READ-visible channels
// plus open DMs — so a resuming participant silently missed the buffered
// voice_state/voice_leave for the very room they were still in, including a
// key holder's departure, which is the E2EE stall the live-path union exists
// to prevent.
//
// The supplement must not widen what the client can read: the room stays out
// of allowedChannelIDs (that map also gates the ChannelTopic subscription in
// registerNow), so this test asserts the room's chat frames are still filtered
// out while its voice frames come through.

import (
	"context"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestReconnect_ReplaysOwnVoiceRoomOutsideReadableChannels(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID := mustCreateUser(t, database, "voice-resume-user", 1)
	// A role with no permissions at all: VisibleChannelIDs returns nothing, so
	// the voice room the user is live in cannot be in allowedChannelIDs.
	noPerms, err := database.CreateRole(ctx, "voice-only", nil, 0, 1, false, false)
	if err != nil || noPerms == nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if err := database.UpdateUserRole(ctx, userID, noPerms.ID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	user := mustGetUser(t, database, userID)

	vcID := mustCreateChannel(t, database, "vc-resume", "voice")
	mustJoinVoice(t, database, userID, vcID)
	vs, err := database.GetVoiceState(ctx, userID)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}

	token := seedSessionToken(t, database, userID)

	rig := newServeRigOn(t, database, nil)
	hub := rig.hub

	// Precondition: the room really is outside the READ-gated allowed set, so
	// the plain replay filter can never deliver its events.
	allowed, err := hub.computeAllowedChannels(ctx, database, user)
	if err != nil {
		t.Fatalf("computeAllowedChannels: %v", err)
	}
	if allowed[vcID] {
		t.Fatalf("precondition: voice channel %d must not be READ-visible to the resuming user", vcID)
	}

	// The still-registered previous connection is what carries the live voice
	// session across the resume (registerNow transfers it when lastSeq > 0).
	oldClient := NewTestClient(hub, userID, make(chan []byte, 64))
	oldClient.user = user
	oldClient.tokenHash = auth.HashToken(token) // the same device session, as a real resume's old socket is
	oldClient.voice.setState(vcID, vs.JoinedAt)
	hub.mu.Lock()
	hub.clients[userID] = []*Client{oldClient}
	hub.mu.Unlock()

	// Ring buffer: everything is scoped to the unreadable voice room. seq 99
	// only exists so last_seq=100 sits strictly inside the buffer window.
	rb := hub.ReplayBuffer()
	push := func(seq uint64, eventType string) {
		rb.Push(seq, vcID, fmt.Appendf(nil, `{"seq":%d,"type":%q,"payload":{"channel_id":%d}}`, seq, eventType, vcID))
	}
	push(99, MsgTypeChatMessage)
	push(100, MsgTypeChatMessage)
	push(101, MsgTypeChatMessage) // must stay filtered out — no READ on this channel
	push(102, MsgTypeVoiceState)
	push(103, MsgTypeVoiceLeaveBC)

	conn := rig.dialAuth(t, ctx, token, 100, 0)

	expectFrame(t, ctx, conn, MsgTypeAuthOK, " (buffer-tier resume)")
	// Replay frames are written synchronously inside handleReconnect, before
	// writePump starts, so they are the next two frames on the wire.
	for i, want := range []string{MsgTypeVoiceState, MsgTypeVoiceLeaveBC} {
		got, frame := readFrameType(t, ctx, conn)
		if got == MsgTypeChatMessage {
			t.Fatalf("replay frame %d leaked a chat frame for a channel the user cannot READ: %s", i, frame)
		}
		if got != want {
			t.Fatalf("replay frame %d: got type=%q, want %q — the resuming participant's own voice room was filtered out of replay", i, got, want)
		}
	}
}
