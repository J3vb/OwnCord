package ws_test

import (
	"context"
	"testing"

	"github.com/coder/websocket"
)

// journeyFreshConnect records the whole handshake — auth, auth_ok, ready, and
// the member_join + presence_batch a first-ever connect broadcasts (which the
// connecting client receives too) — TWICE, once per kind of account.
//
// alice has every optional profile field set; bob has none. Recording only
// alice would freeze auth_ok.user and member_join.user in their populated form
// alone, so a rename, a retype or a dropped null on display_name, about,
// custom_status, avatar or identity_public_key would move no fixture. auth_ok
// is the frame B2-2 edits, which makes it the last one to leave half-frozen.
//
// bob's connect is also observed on alice's socket, which is idle by then: the
// two broadcasts reach her through the hub's per-client FIFO in the order they
// were sequenced, so her reads stay deterministic. One ping each, well inside
// the per-user budget (see barrier).
func journeyFreshConnect(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a := r.dial(t, "a")
	a.record = true
	// The real client stamps a correlation id on every frame it sends,
	// auth included (ws.ts send()); the server ignores it here.
	a.send(map[string]any{
		"type":    "auth",
		"id":      "req-auth-alice",
		"payload": map[string]any{"token": aliceTok, "last_seq": 0},
	})
	a.expect("auth_ok")
	a.expect("ready")
	a.expect("member_join")
	a.expect("presence_batch")

	// bob, recorded: the same five frames with the bare user object — nulls
	// for avatar/display_name/about/custom_status, identity_public_key omitted.
	b := r.dial(t, "b")
	b.record = true
	b.send(map[string]any{
		"type":    "auth",
		"id":      "req-auth-bob",
		"payload": map[string]any{"token": bobTok, "last_seq": 0},
	})
	b.expect("auth_ok")
	b.expect("ready")
	b.expect("member_join")
	b.expect("presence_batch")

	// bob's connect as an already-connected client sees it.
	a.expect("member_join")
	a.expect("presence_batch")

	a.barrier()
	b.barrier()
}

// journeyAuthFailure records the rejection an unknown session token earns.
// The two sibling rejections share the frame shape and differ only in the
// message string: "invalid message" (unparseable first frame) and "first
// message must be auth" (a first frame of any other type).
//
// This is the one journey with no ping/pong barrier: there is no session to
// ping. The server closes the socket right after the frame (serve.go:126-129),
// so the close is the proof that auth_error is the last thing said — and an
// extra frame slipped in ahead of it fails expectClosed rather than passing
// unrecorded.
func journeyAuthFailure(t *testing.T, r *epochRig) {
	r.seedBaseline(t)

	a := r.dial(t, "a")
	a.record = true
	a.send(map[string]any{
		"type":    "auth",
		"id":      "req-auth-rejected",
		"payload": map[string]any{"token": "not-a-real-session-token", "last_seq": 0},
	})
	a.expect("auth_error")
	a.expectClosed()
}

// journeyPing records the heartbeat round trip twice: the second pair is the
// barrier proving nothing follows the first pong. Two is the whole per-second
// ping budget (see barrier), so this journey sits exactly on the ceiling.
func journeyPing(t *testing.T, r *epochRig) {
	_, _, aliceTok, _ := r.seedBaseline(t)

	a := r.dial(t, "a")
	a.authenticate(aliceTok)

	a.record = true
	a.send(map[string]any{"type": "ping", "payload": map[string]any{}})
	a.expect("pong")
	a.barrier()
}

// journeyChatSendFanout records a channel message: the sender's direct
// chat_send_ok reply plus the sequenced chat_message every focused client in
// the channel receives, sender included.
func journeyChatSendFanout(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.recordedPair(t, aliceTok, bobTok, textChannelID)
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-chat-send-1",
		"payload": map[string]any{"channel_id": textChannelID, "content": "hello epoch one"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
	b.expect("chat_message")
	a.barrier()
	b.barrier()
}

// journeyChatEditDelete records the two mutations of an existing message.
// Neither carries a direct reply — the broadcast is the whole answer, so the
// author learns the outcome the same way every other client does.
func journeyChatEditDelete(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	msgID, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, "original text", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	a, b := r.recordedPair(t, aliceTok, bobTok, textChannelID)
	a.send(map[string]any{
		"type":    "chat_edit",
		"id":      "req-chat-edit-1",
		"payload": map[string]any{"message_id": msgID, "content": "edited text"},
	})
	a.expect("chat_edited")
	b.expect("chat_edited")

	a.send(map[string]any{
		"type":    "chat_delete",
		"id":      "req-chat-delete-1",
		"payload": map[string]any{"message_id": msgID},
	})
	a.expect("chat_deleted")
	b.expect("chat_deleted")
	a.barrier()
	b.barrier()
}

// journeyReactionAddRemove records both halves of a reaction. Add and remove
// share one frame type and differ only in the action field.
func journeyReactionAddRemove(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, bobTok := r.seedBaseline(t)
	msgID, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, "react to me", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	a, b := r.recordedPair(t, aliceTok, bobTok, textChannelID)
	a.send(map[string]any{
		"type":    "reaction_add",
		"id":      "req-reaction-add-1",
		"payload": map[string]any{"message_id": msgID, "emoji": "👍"},
	})
	a.expect("reaction_update")
	b.expect("reaction_update")

	a.send(map[string]any{
		"type":    "reaction_remove",
		"id":      "req-reaction-remove-1",
		"payload": map[string]any{"message_id": msgID, "emoji": "👍"},
	})
	a.expect("reaction_update")
	b.expect("reaction_update")
	a.barrier()
	b.barrier()
}

// journeyTyping records the typing indicator, which is delivered on the
// low-priority queue and excludes its sender. The ping/pong pair on "a" is the
// absence proof: the typist must not see its own typing frame.
//
// "a" focuses the channel first, exactly like the other fan-out journeys. That
// is what makes the absence proof mean anything: a live client joins a
// channel's topic only when it focuses that channel (handleChannelFocusV2,
// handlers_presence.go:97, whose SetChannelID result the hub applies), so an
// unfocused "a" could not receive the frame no matter what excludeUserID did,
// and the barrier would be proving the subscription was missing rather than
// that the server excludes the sender.
func journeyTyping(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.recordedPair(t, aliceTok, bobTok, textChannelID)
	a.send(map[string]any{
		"type":    "typing_start",
		"payload": map[string]any{"channel_id": textChannelID},
	})
	b.expect("typing")
	a.barrier()
	b.barrier()
}

// journeyChannelActivity records the unread hint (WP 2B-2): bob is connected
// but has not focused the channel alice posts in, so he gets a channel_activity
// frame and no chat_message. The hint is delivered by a worker on a 1 s
// window and rides the low queue, which a pong may overtake, so the journey
// flushes the window itself before bob's barrier and reads the frame first.
// alice's barrier proves her chat_send finished emitting before that flush.
func journeyChannelActivity(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.connectPair(t, aliceTok, bobTok)
	a.focus(textChannelID, false)

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-channel-activity-1",
		"payload": map[string]any{"channel_id": textChannelID, "content": "hello unfocused"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
	a.barrier()
	r.hub.FlushChannelActivityNowForTest()
	b.expect("channel_activity")
	b.barrier()
}

// journeyMarkRead records mark_read, which answers with one read_state frame
// to the caller (WP 3D-5c) and nothing else.
func journeyMarkRead(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, _ := r.seedBaseline(t)
	if _, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, "unread", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	a := r.dial(t, "a")
	a.authenticate(aliceTok)

	a.record = true
	a.send(map[string]any{
		"type":    "mark_read",
		"payload": map[string]any{"channel_id": textChannelID},
	})
	a.expect("read_state")
	a.barrier()
}

// journeyMarkUnread records mark_unread: the pointer moves to the message
// before the one named and the caller gets a read_state frame.
func journeyMarkUnread(t *testing.T, r *epochRig) {
	aliceID, _, aliceTok, _ := r.seedBaseline(t)
	if _, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, "first", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	second, err := r.db.CreateMessage(context.Background(), textChannelID, aliceID, "second", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	a := r.dial(t, "a")
	a.authenticate(aliceTok)

	a.record = true
	a.send(map[string]any{
		"type":    "mark_unread",
		"payload": map[string]any{"channel_id": textChannelID, "message_id": second},
	})
	a.expect("read_state")
	a.barrier()
}

// journeyDMSend records a direct message. DM traffic is addressed to the
// participant ids rather than a channel topic, so neither side needs focus,
// and the whole fan-out is synchronous on the sender's connection.
//
// B5-6 gate note: GetOrCreateDMChannel below runs at the DB layer, below
// service.MessageService's first-contact gate, and this pair has no
// trusted_senders row at journey start (migration 046's grandfathering
// backfill runs once at migration time over pairs that already exist then —
// this journey's pair does not exist yet). Without the explicit TrustSender
// call, alice's send below would be gated exactly like a stranger's first
// message: bob would get a dm_request instead of chat_message, and this
// fixture would silently start recording a different journey. Trusting the
// pair here keeps the recorded frames byte-identical to before B5-6 — see
// the spec's own warning that a green dm-send.json never proved anything
// about the gate.
func journeyDMSend(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	dmChannel, _, err := r.db.GetOrCreateDMChannel(context.Background(), aliceID, bobID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if err := r.db.TrustSender(context.Background(), bobID, aliceID, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}

	a, b := r.recordedPair(t, aliceTok, bobTok)
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-dm-send-1",
		"payload": map[string]any{"channel_id": dmChannel.ID, "content": "hello over dm"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
	b.expect("chat_message")
	a.barrier()
	b.barrier()
}

// journeyDMRequest records alice, a stranger to bob, sending the first
// message of a fresh one-to-one DM (B5-6): alice's side is byte-identical to
// journeyDMSend (chat_send_ok, chat_message — decision 5), and bob, who does
// not yet trust alice, gets exactly one dm_request instead of the message
// itself.
func journeyDMRequest(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	dmChannel, _, err := r.db.GetOrCreateDMChannel(context.Background(), aliceID, bobID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	a, b := r.recordedPair(t, aliceTok, bobTok)
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-dm-request-1",
		"payload": map[string]any{"channel_id": dmChannel.ID, "content": "hi, stranger"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
	b.expect("dm_request")
	a.barrier()
	b.barrier()
}

// journeyDMRequestIgnored records a resend after the recipient ignored the
// first request (decision 5's silence property, and the "resend creates
// nothing" rule): bob ignores alice's first message (drained, not part of
// this journey — the request gate itself is service/message_request_test.go's
// job), then alice sends again. Alice's side records the same two frame
// types as any other send; bob records nothing at all — no second
// dm_request, no chat_message.
func journeyDMRequestIgnored(t *testing.T, r *epochRig) {
	aliceID, bobID, aliceTok, bobTok := r.seedBaseline(t)
	dmChannel, _, err := r.db.GetOrCreateDMChannel(context.Background(), aliceID, bobID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	a, b := r.connectPair(t, aliceTok, bobTok)

	// Setup, not recorded: alice's first message stages the request and bob
	// drains the resulting dm_request, then the request is marked ignored
	// directly — there is no REST/WS decision route wired into this harness;
	// the transition itself is service/message_request_test.go's and
	// api/dm_request_handler_test.go's job.
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-dm-request-ignored-setup",
		"payload": map[string]any{"channel_id": dmChannel.ID, "content": "hi, stranger"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
	b.drain("dm_request")

	ctx := context.Background()
	if _, err := r.db.ExecContext(ctx,
		`UPDATE message_requests SET state = 'ignored', decided_at = datetime('now') WHERE sender_id = ? AND recipient_id = ?`,
		aliceID, bobID); err != nil {
		t.Fatalf("marking the request ignored: %v", err)
	}

	a.record, b.record = true, true
	a.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-dm-request-ignored-1",
		"payload": map[string]any{"channel_id": dmChannel.ID, "content": "hello again"},
	})
	a.expect("chat_send_ok")
	a.expect("chat_message")
	a.barrier()
	b.barrier()
}

// journeyResumeReplay records the reconnect handshake: the actor drops, misses
// two sequenced events, and resumes with last_seq — earning auth_ok with
// replay_source "buffer" followed by the replay burst, then its own live
// come-back-online presence.
func journeyResumeReplay(t *testing.T, r *epochRig) {
	_, _, aliceTok, bobTok := r.seedBaseline(t)

	a, b := r.connectPair(t, aliceTok, bobTok)
	b.focus(textChannelID, true)

	lastSeq := a.lastSeq
	if lastSeq == 0 {
		t.Fatal("conn \"a\" saw no sequenced frame during the handshake; a resume needs one")
	}

	// Drop the actor. Reading b's offline presence is the barrier: it proves
	// the disconnect broadcast has been sequenced before b posts, so the two
	// replayed events always land in the same order.
	b.record = true
	if err := a.conn.Close(websocket.StatusNormalClosure, "resume"); err != nil {
		t.Fatalf("closing conn \"a\": %v", err)
	}
	b.expect("presence_batch")

	b.send(map[string]any{
		"type":    "chat_send",
		"id":      "req-resume-1",
		"payload": map[string]any{"channel_id": textChannelID, "content": "sent while away"},
	})
	b.expect("chat_send_ok")
	b.expect("chat_message")
	// b's barrier closes ITS recorded list here rather than at the end of the
	// journey — the second of the file header's two barrier exceptions.
	// Everything b has to say about the away window is said, and the only frame
	// the server can still send it is alice's back-online presence from the
	// resume below, whose shape is already recorded on a2 as the last frame of
	// the replay burst. Moving the barrier past the resume is NOT the fix it
	// looks like: b's ping would then race the tail of the hub's fan-out loop
	// for that presence, and pong could win — a flake that -race and -tags
	// deadlock surface on a loaded runner, in a file whose whole job is to fail
	// only for real drift.
	b.barrier()
	b.record = false

	a2 := r.dial(t, "a")
	a2.record = true
	a2.send(map[string]any{
		"type": "auth",
		"id":   "req-auth-resume",
		"payload": map[string]any{
			"token":             aliceTok,
			"last_seq":          lastSeq,
			"active_channel_id": textChannelID,
		},
	})
	authOK := a2.expect("auth_ok")
	payload, _ := authOK["payload"].(map[string]any)
	if src := payload["replay_source"]; src != "buffer" {
		t.Fatalf("resume served from %q, want \"buffer\" — the replay tier under test", src)
	}
	a2.expect("presence_batch") // replayed: the actor's own disconnect
	a2.expect("chat_message")   // replayed: what it missed
	a2.expect("presence_batch") // live: back online
	a2.barrier()
}
