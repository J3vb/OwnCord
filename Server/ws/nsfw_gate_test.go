package ws

// nsfw_gate_test.go is B5-7's cross-path proof: one labelled channel, one
// member without an acknowledgement row and one with, exercised against
// every content path decision 13 names — REST reads (via the service layer
// directly; the exact HTTP status/code mapping is api/nsfw_handler_test.go's
// and api/upload_handler_test.go's job), search, live socket delivery,
// reconnect-replay filtering, attachment access, and the plugin-sink gate.
//
// The fixture harness (protocol_epoch1_contract_test.go) records frames that
// DO arrive; it has no "assert nothing arrived" primitive, so the spec's
// optional nsfw-gate fixture journey was not added there — this file is the
// "if the harness cannot" fallback the spec names.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
)

// nsfwGateFixture is the shared setup every test in this file starts from:
// one labelled channel, one unlabelled control channel, an author (Owner
// role, so setup actions like pin/react need no permission wrangling), a
// message with a pin/reaction/attachment in the labelled channel, and a
// control message in the unlabelled one for the global-search assertion.
type nsfwGateFixture struct {
	db                       *db.DB
	svc                      *service.Services
	hub                      *Hub
	labelledID, controlID    int64
	authorID, bobID, aliceID int64
	msgID, controlMsgID      int64
	attachmentID             string
}

func newNSFWGateFixture(t *testing.T) *nsfwGateFixture {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHub(t, database, limiter, svc)

	ctx := context.Background()
	labelledID, err := database.CreateChannel(ctx, "labelled", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(labelled): %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, labelledID); err != nil {
		t.Fatalf("label channel: %v", err)
	}
	controlID, err := database.CreateChannel(ctx, "control", "text", "", "", 1)
	if err != nil {
		t.Fatalf("CreateChannel(control): %v", err)
	}

	authorID, err := database.CreateUser(ctx, "author", "hash", 1) // Owner
	if err != nil {
		t.Fatalf("CreateUser(author): %v", err)
	}
	bobID, err := database.CreateUser(ctx, "bob", "hash", 4) // Member, no row
	if err != nil {
		t.Fatalf("CreateUser(bob): %v", err)
	}
	aliceID, err := database.CreateUser(ctx, "alice", "hash", 4) // Member, acknowledges
	if err != nil {
		t.Fatalf("CreateUser(alice): %v", err)
	}
	if _, err := database.AcknowledgeNSFW(ctx, aliceID, labelledID); err != nil {
		t.Fatalf("AcknowledgeNSFW(alice): %v", err)
	}

	sent, err := svc.Messages.SendMessage(ctx, service.SendMessageParams{
		ChannelID: labelledID, UserID: authorID, Username: "author", RoleName: "owner",
		Content: "secret needleword",
	})
	if err != nil {
		t.Fatalf("SendMessage(labelled): %v", err)
	}
	if err := svc.Messages.SetMessagePinned(ctx, authorID, labelledID, sent.MessageID, true); err != nil {
		t.Fatalf("SetMessagePinned: %v", err)
	}
	if _, err := svc.Messages.AddReaction(ctx, authorID, sent.MessageID, "👍"); err != nil {
		t.Fatalf("AddReaction: %v", err)
	}
	const attID = "nsfw-gate-attachment"
	if err := database.CreateAttachment(ctx, attID, authorID, "secret.png", "stored-secret.png", "image/png", 3, nil, nil); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	if _, err := database.LinkAttachmentsToMessage(ctx, sent.MessageID, authorID, []string{attID}); err != nil {
		t.Fatalf("LinkAttachmentsToMessage: %v", err)
	}

	control, err := svc.Messages.SendMessage(ctx, service.SendMessageParams{
		ChannelID: controlID, UserID: authorID, Username: "author", RoleName: "owner",
		Content: "control needleword",
	})
	if err != nil {
		t.Fatalf("SendMessage(control): %v", err)
	}

	return &nsfwGateFixture{
		db: database, svc: svc, hub: hub,
		labelledID: labelledID, controlID: controlID,
		authorID: authorID, bobID: bobID, aliceID: aliceID,
		msgID: sent.MessageID, controlMsgID: control.MessageID,
		attachmentID: attID,
	}
}

// isNSFWForbidden reports whether err is the service layer's
// ErrForbidden-wrapped ErrNSFWUnacknowledged — requireChannelRead's family
// (message_perms.go's readContentDenial).
func isNSFWForbidden(err error) bool {
	return errors.Is(err, service.ErrForbidden) && errors.Is(err, permissions.ErrNSFWUnacknowledged)
}

// TestNSFW_UnacknowledgedGetsNoContentOnAnyPath is decision 13's line, proved
// on all four paths at once: history, around, pins, reaction users and
// single-channel search 403 (ErrForbidden + ErrNSFWUnacknowledged);
// global search silently omits the labelled hit while a control hit from an
// unlabelled channel is returned; the attachment is refused; live delivery
// reaches nobody without a row; reconnect replay delivers nothing with
// content. The same member WITH a row gets everything.
func TestNSFW_UnacknowledgedGetsNoContentOnAnyPath(t *testing.T) {
	f := newNSFWGateFixture(t)
	ctx := context.Background()

	// ── bob: no row ──────────────────────────────────────────────────────
	if _, _, err := f.svc.Messages.GetMessages(ctx, f.bobID, f.labelledID, 0, 50); !isNSFWForbidden(err) {
		t.Errorf("GetMessages(bob) = %v, want ErrForbidden+ErrNSFWUnacknowledged", err)
	}
	if _, err := f.svc.Messages.GetMessagesAround(ctx, f.bobID, f.labelledID, f.msgID, 10); !isNSFWForbidden(err) {
		t.Errorf("GetMessagesAround(bob) = %v, want ErrForbidden+ErrNSFWUnacknowledged", err)
	}
	if _, err := f.svc.Messages.GetPinnedMessages(ctx, f.bobID, f.labelledID); !isNSFWForbidden(err) {
		t.Errorf("GetPinnedMessages(bob) = %v, want ErrForbidden+ErrNSFWUnacknowledged", err)
	}
	if _, err := f.svc.Messages.GetReactionUsers(ctx, f.bobID, f.labelledID, f.msgID, "👍"); !isNSFWForbidden(err) {
		t.Errorf("GetReactionUsers(bob) = %v, want ErrForbidden+ErrNSFWUnacknowledged", err)
	}
	if _, err := f.svc.Messages.SearchMessages(ctx, f.bobID, "needleword", &f.labelledID, 10); !isNSFWForbidden(err) {
		t.Errorf("SearchMessages(bob, single-channel) = %v, want ErrForbidden+ErrNSFWUnacknowledged", err)
	}
	globalHits, err := f.svc.Messages.SearchMessages(ctx, f.bobID, "needleword", nil, 10)
	if err != nil {
		t.Fatalf("SearchMessages(bob, global): %v", err)
	}
	var sawControl, sawLabelled bool
	for _, hit := range globalHits {
		if hit.ChannelID == f.controlID {
			sawControl = true
		}
		if hit.ChannelID == f.labelledID {
			sawLabelled = true
		}
	}
	if !sawControl {
		t.Error("global search dropped the control hit from the unlabelled channel")
	}
	if sawLabelled {
		t.Error("global search leaked a hit from the labelled channel to an unacknowledged member")
	}

	bobUser, err := f.db.GetUserByID(ctx, f.bobID)
	if err != nil || bobUser == nil {
		t.Fatalf("GetUserByID(bob): %v", err)
	}
	bobRole, err := f.db.GetRoleForUser(ctx, f.bobID)
	if err != nil {
		t.Fatalf("GetRoleForUser(bob): %v", err)
	}
	aa, err := f.svc.Uploads.Resolve(ctx, f.attachmentID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if err := f.svc.Uploads.Authorize(ctx, aa, bobUser, bobRole); !errors.Is(err, permissions.ErrNSFWUnacknowledged) {
		t.Errorf("Authorize(bob) = %v, want ErrNSFWUnacknowledged", err)
	}

	// ── live delivery: bob focused/subscribed, gets nothing with content ──
	sendBob := make(chan []byte, 32)
	cBob := NewTestClientWithUser(f.hub, bobUser, f.labelledID, sendBob)
	f.hub.clients[f.bobID] = cBob
	f.hub.pubsub.Subscribe(cBob, ChannelTopic(f.labelledID))

	aliceUser, err := f.db.GetUserByID(ctx, f.aliceID)
	if err != nil || aliceUser == nil {
		t.Fatalf("GetUserByID(alice): %v", err)
	}
	sendAlice := make(chan []byte, 32)
	cAlice := NewTestClientWithUser(f.hub, aliceUser, f.labelledID, sendAlice)
	f.hub.clients[f.aliceID] = cAlice
	f.hub.pubsub.Subscribe(cAlice, ChannelTopic(f.labelledID))

	go f.hub.Run()
	t.Cleanup(f.hub.Stop)
	waitUntilRunning(t, f.hub)

	// Seed two throwaway global broadcasts and wait for them to be fully
	// dispatched (sequenced and buffered) before capturing beforeSeq: asking
	// EventsSinceFilteredContent for a seq at or before the ring's OLDEST
	// entry is, by design, out of its coverage window and always returns nil
	// (EventsSince's doc), so beforeSeq must be strictly newer than the
	// buffer's very first entry, not merely "before the live message" — one
	// seed broadcast alone would make beforeSeq equal the oldest entry's own
	// seq and trip that same rule.
	f.hub.BroadcastToAll([]byte(`{"type":"ping","payload":{}}`))
	f.hub.BroadcastToAll([]byte(`{"type":"ping","payload":{}}`))
	if err := f.hub.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch (seed): %v", err)
	}
	beforeSeq := f.hub.SeqForTest()

	live, err := f.svc.Messages.SendMessage(ctx, service.SendMessageParams{
		ChannelID: f.labelledID, UserID: f.authorID, Username: "author", RoleName: "owner",
		Content: "live secret",
	})
	if err != nil {
		t.Fatalf("SendMessage(live): %v", err)
	}
	payload, err := json.Marshal(map[string]any{
		"type": MsgTypeChatMessage,
		"payload": map[string]any{
			"id": live.MessageID, "channel_id": f.labelledID, "content": "live secret",
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	f.hub.EmitEvents(ctx, []Event{MessageSentChannelEvent{channelID: f.labelledID, payload: payload}})

	msgsBob := drainChan(sendBob, 150*time.Millisecond)
	for _, m := range msgsBob {
		if extractEventType(m) == MsgTypeChatMessage {
			t.Errorf("bob (no row) received a chat_message live: %s", m)
		}
	}
	msgsAlice := drainChan(sendAlice, 150*time.Millisecond)
	var aliceSawIt bool
	for _, m := range msgsAlice {
		if extractEventType(m) == MsgTypeChatMessage {
			aliceSawIt = true
		}
	}
	if !aliceSawIt {
		t.Error("alice (acknowledged) did not receive the live chat_message")
	}

	// ── reconnect replay: bob's readable set excludes the labelled channel,
	// so a buffered content-bearing frame for it must not replay to him ──
	allowedBob, err := f.hub.computeAllowedChannels(ctx, f.hub.readers.Visibility, bobUser)
	if err != nil {
		t.Fatalf("computeAllowedChannels(bob): %v", err)
	}
	readableBob, err := f.hub.computeReadableChannels(ctx, f.hub.readers.Visibility, bobUser, allowedBob)
	if err != nil {
		t.Fatalf("computeReadableChannels(bob): %v", err)
	}
	if readableBob[f.labelledID] {
		t.Fatalf("bob's readable set includes the labelled channel he has not acknowledged")
	}
	replayed := f.hub.ReplayBuffer().EventsSinceFilteredContent(beforeSeq, allowedBob, readableBob)
	for _, m := range replayed {
		if channelIDOf(m) == f.labelledID && contentBearingKinds[extractEventType(m)] {
			t.Errorf("replay handed bob content from the labelled channel: %s", m)
		}
	}

	// alice's readable set includes it, and replay carries the content.
	allowedAlice, err := f.hub.computeAllowedChannels(ctx, f.hub.readers.Visibility, aliceUser)
	if err != nil {
		t.Fatalf("computeAllowedChannels(alice): %v", err)
	}
	readableAlice, err := f.hub.computeReadableChannels(ctx, f.hub.readers.Visibility, aliceUser, allowedAlice)
	if err != nil {
		t.Fatalf("computeReadableChannels(alice): %v", err)
	}
	if !readableAlice[f.labelledID] {
		t.Fatalf("alice's readable set excludes the labelled channel she acknowledged")
	}
	replayedAlice := f.hub.ReplayBuffer().EventsSinceFilteredContent(beforeSeq, allowedAlice, readableAlice)
	var aliceReplaySawIt bool
	for _, m := range replayedAlice {
		if channelIDOf(m) == f.labelledID && extractEventType(m) == MsgTypeChatMessage {
			aliceReplaySawIt = true
		}
	}
	if !aliceReplaySawIt {
		t.Error("alice's replay dropped the labelled channel's content even though she acknowledged")
	}

	// ── alice (has a row): everything above succeeds ──────────────────────
	if _, _, err := f.svc.Messages.GetMessages(ctx, f.aliceID, f.labelledID, 0, 50); err != nil {
		t.Errorf("GetMessages(alice) = %v, want nil", err)
	}
	if _, err := f.svc.Messages.GetPinnedMessages(ctx, f.aliceID, f.labelledID); err != nil {
		t.Errorf("GetPinnedMessages(alice) = %v, want nil", err)
	}
	if _, err := f.svc.Messages.GetReactionUsers(ctx, f.aliceID, f.labelledID, f.msgID, "👍"); err != nil {
		t.Errorf("GetReactionUsers(alice) = %v, want nil", err)
	}
	if _, err := f.svc.Messages.SearchMessages(ctx, f.aliceID, "needleword", &f.labelledID, 10); err != nil {
		t.Errorf("SearchMessages(alice, single-channel) = %v, want nil", err)
	}
	aliceRole, err := f.db.GetRoleForUser(ctx, f.aliceID)
	if err != nil {
		t.Fatalf("GetRoleForUser(alice): %v", err)
	}
	if err := f.svc.Uploads.Authorize(ctx, aa, aliceUser, aliceRole); err != nil {
		t.Errorf("Authorize(alice) = %v, want nil", err)
	}
}

// TestReconnect_ReplaySkipsUnacknowledgedLabelledContent is the genuine,
// full-handshake counterpart to the reconnect-replay half of
// TestNSFW_UnacknowledgedGetsNoContentOnAnyPath above, which calls
// computeReadableChannels directly and so never exercises reconnectPrecheck's
// own wiring of it. Modelled on reconnect_active_channel_test.go's pattern:
// buffered frames bracketing last_seq, a real auth-frame resume over an
// actual websocket, and a check of what actually replays.
//
// Acknowledged and unacknowledged are separate sub-tests, each with its own
// hub: a single hub reused for two sequential resumes lets the first resume's
// own broadcasts (member_join, presence) advance the ring buffer far enough
// to evict the seeded seq 98-100 window before the second dial, which would
// make the control fail for a reason that has nothing to do with the gate.
func TestReconnect_ReplaySkipsUnacknowledgedLabelledContent(t *testing.T) {
	setup := func(t *testing.T, acknowledge bool) (hub *Hub, token string, chID int64) {
		t.Helper()
		database := newTeardownTestDB(t)
		ctx := context.Background()

		userID, err := database.CreateUser(ctx, "resume-nsfw-user", "hash", 4) // Member
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		user, err := database.GetUserByID(ctx, userID)
		if err != nil || user == nil {
			t.Fatalf("GetUserByID: %v", err)
		}
		chID, err = database.CreateChannel(ctx, "resume-labelled", "text", "", "", 0)
		if err != nil {
			t.Fatalf("CreateChannel: %v", err)
		}
		if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, chID); err != nil {
			t.Fatalf("label channel: %v", err)
		}
		if acknowledge {
			if _, err := database.AcknowledgeNSFW(ctx, userID, chID); err != nil {
				t.Fatalf("AcknowledgeNSFW: %v", err)
			}
		}

		token, err = auth.GenerateToken()
		if err != nil {
			t.Fatalf("GenerateToken: %v", err)
		}
		if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}

		hub = newTestHub(t, database, auth.NewRateLimiter(), nil)
		go hub.Run()
		t.Cleanup(hub.Stop)

		// Precondition: the channel is VISIBLE (role has READ_MESSAGES)
		// regardless of acknowledgement — this test is about the READABLE
		// narrowing, not visibility, which
		// channel_visibility_agreement_test.go already covers.
		allowed, err := hub.computeAllowedChannels(ctx, database, user)
		if err != nil {
			t.Fatalf("computeAllowedChannels: %v", err)
		}
		if !allowed[chID] {
			t.Fatalf("precondition: channel %d should be READ-visible", chID)
		}

		rb := hub.ReplayBuffer()
		rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"pre-existing"}}`))
		rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"anchor"}}`))
		rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"THE-SECRET-CONTENT"}}`))
		return hub, token, chID
	}

	t.Run("unacknowledged member sees nothing replayed", func(t *testing.T) {
		hub, token, _ := setup(t, false)
		for _, evt := range dialAndResume(t, hub, token, 99) {
			if strings.Contains(string(evt), "THE-SECRET-CONTENT") {
				t.Fatalf("reconnect replayed a labelled channel's content to an unacknowledged member: %s", evt)
			}
		}
	})

	t.Run("control: acknowledged member's resume replays it", func(t *testing.T) {
		hub, token, _ := setup(t, true)
		var sawSecret bool
		for _, evt := range dialAndResume(t, hub, token, 99) {
			if strings.Contains(string(evt), "THE-SECRET-CONTENT") {
				sawSecret = true
			}
		}
		if !sawSecret {
			t.Fatal("an acknowledged member's resume did not replay the labelled channel's content")
		}
	})
}

// TestReconnect_RevokeBetweenTwoFramesOfTheSameReplayDropsOnlyTheLaterOnes is
// Codex round 2, P1: a single snapshot — whether taken once per reconnect
// (the original P1-1 fix) or once per channel within a batch — still trusts
// that one moment for every later frame of the SAME replay. A revoke landing
// AFTER the first content-bearing frame's readability check but BEFORE a
// later one's must drop everything from that point on, while the frame
// already written before the revoke stays delivered — proving the check is
// live per frame, not a batch-wide recheck with a wider window than before.
// reconnectFrameReadableRaceHook pins the interleaving deterministically.
func TestReconnect_RevokeBetweenTwoFramesOfTheSameReplayDropsOnlyTheLaterOnes(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "interleave-nsfw-user", "hash", 4) // Member
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "interleave-labelled", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, chID); err != nil {
		t.Fatalf("label channel: %v", err)
	}
	// Starts ACKNOWLEDGED: every frame's live check must pass until the hook
	// revokes mid-batch, or the test would prove nothing about the recheck.
	if _, err := database.AcknowledgeNSFW(ctx, userID, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW: %v", err)
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	t.Cleanup(hub.Stop)

	// Three content-bearing frames for the SAME channel, all in one replay
	// batch (last_seq below anchors the resume before all three). seq 96 is
	// an older entry purely so the ring buffer's oldest-seq guard doesn't
	// read last_seq=97 as "too old to trust" (EventsSince requires afterSeq
	// to be strictly newer than the buffer's oldest entry).
	rb := hub.ReplayBuffer()
	rb.Push(96, chID, []byte(`{"seq":96,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"pre-existing"}}`))
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"FIRST-frame"}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"SECOND-frame"}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"THIRD-frame"}}`))

	t.Cleanup(func() { reconnectFrameReadableRaceHook = nil })
	frameChecks := 0
	reconnectFrameReadableRaceHook = func(uid, cid int64) {
		if uid != userID || cid != chID {
			return
		}
		frameChecks++
		// Revoke strictly BETWEEN the first frame's check (already passed,
		// written) and the second's (about to be checked) — after the
		// snapshot/first frame, before a later frame, exactly as required.
		if frameChecks == 2 {
			if err := database.RevokeNSFW(context.Background(), userID, chID); err != nil {
				t.Errorf("RevokeNSFW (in race hook): %v", err)
			}
		}
	}

	events := dialAndResume(t, hub, token, 97)
	var sawFirst, sawSecond, sawThird bool
	for _, evt := range events {
		switch {
		case strings.Contains(string(evt), "FIRST-frame"):
			sawFirst = true
		case strings.Contains(string(evt), "SECOND-frame"):
			sawSecond = true
		case strings.Contains(string(evt), "THIRD-frame"):
			sawThird = true
		}
	}
	if !sawFirst {
		t.Error("the first frame, checked and written before the revoke, was dropped — the per-frame check must not be more aggressive than live")
	}
	if sawSecond || sawThird {
		t.Fatalf("a revoke landing between two frames of the SAME replay batch still let a later frame "+
			"(second=%v, third=%v) through — the recheck is not truly per-frame", sawSecond, sawThird)
	}
	if frameChecks < 3 {
		t.Fatalf("race hook fired %d times, want 3 (one per content-bearing frame) — the test didn't exercise what it claims", frameChecks)
	}
}

// erroringNSFWVisibilityReader wraps a real VisibilityReader and makes every
// HasNSFWAcknowledgement call fail, standing in for a transient DB hiccup on
// computeReadableChannels' one extra read. Every other method passes through.
type erroringNSFWVisibilityReader struct {
	VisibilityReader
}

func (r *erroringNSFWVisibilityReader) HasNSFWAcknowledgement(context.Context, int64, int64) (bool, error) {
	return false, errors.New("simulated transient lookup failure")
}

// erroringGetChannelReader wraps a real VisibilityReader and makes every
// GetChannel call fail — standing in for a transient DB hiccup on
// channelNSFWFilter's own lookup (Codex round 2, P1). Every other method
// passes through.
type erroringGetChannelReader struct {
	VisibilityReader
}

func (r *erroringGetChannelReader) GetChannel(context.Context, int64) (*db.Channel, error) {
	return nil, errors.New("simulated transient lookup failure")
}

// TestNSFW_ChannelLookupFailureDeniesEverySocketRecipient is Codex round 2,
// P1: when channelNSFWFilter cannot even confirm the label (a failed
// GetChannel), the label is UNKNOWN — not "not labelled". A nil filter means
// "deliver unfiltered" to deliverBroadcast, which would leak the frame to
// every topic subscriber regardless of acknowledgement, the exact disclosure
// decision 13 exists to prevent. This proves the socket path fails closed
// (deny-all), not just the plugin sink (already covered by
// TestNSFW_PluginSinkGetsNoLabelledContent).
func TestNSFW_ChannelLookupFailureDeniesEverySocketRecipient(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	subscriberID, err := database.CreateUser(ctx, "lookup-fail-subscriber", "hash", 4) // Member, unacknowledged
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "lookup-fail-channel", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	hub := newTestHubWith(t, HubOptions{
		DB:      database,
		Limiter: auth.NewRateLimiter(),
		Readers: HubReaders{
			Visibility: &erroringGetChannelReader{VisibilityReader: database},
			Ready:      database,
			Members:    database,
			Dispatch:   database,
		},
	})
	go hub.Run()
	t.Cleanup(hub.Stop)
	waitUntilRunning(t, hub)

	send := make(chan []byte, 8)
	c := NewTestClient(hub, subscriberID, send)
	hub.mu.Lock()
	hub.clients[subscriberID] = c
	hub.mu.Unlock()
	hub.pubsub.Subscribe(c, ChannelTopic(chID))

	payload, _ := json.Marshal(map[string]any{
		"type":    MsgTypeChatMessage,
		"payload": map[string]any{"channel_id": chID, "content": "should never arrive"},
	})
	hub.EmitEvents(ctx, []Event{MessageSentChannelEvent{channelID: chID, payload: payload}})
	if err := hub.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}

	select {
	case msg := <-send:
		t.Fatalf("subscriber received a frame despite the label lookup failing: %s", msg)
	default:
	}
}

// TestReconnectPrecheck_ComputeReadableChannelsErrorFallsBackToFullReady pins
// the fail-closed posture of reconnectPrecheck's new B5-7 read: a transient
// failure resolving the readable set must fall through to a full ready
// (never a panic, and never a resume that silently treats the failure as
// "everything is readable").
func TestReconnectPrecheck_ComputeReadableChannelsErrorFallsBackToFullReady(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "precheck-nsfw-err-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "precheck-nsfw-err-chan", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, chID); err != nil {
		t.Fatalf("label channel: %v", err)
	}

	hub := newTestHubWith(t, HubOptions{
		DB:      database,
		Limiter: auth.NewRateLimiter(),
		Readers: HubReaders{
			Visibility: &erroringNSFWVisibilityReader{VisibilityReader: database},
			Ready:      database,
			Members:    database,
			Dispatch:   database,
		},
	})

	c := NewTestClient(hub, userID, make(chan []byte, 8))
	c.user = &db.User{ID: userID}
	c.lastSeq = 1

	_, _, ok := hub.reconnectPrecheck(ctx, c, 1)
	if ok {
		t.Fatal("reconnectPrecheck succeeded despite computeReadableChannels failing; want a fall-through to full ready")
	}
}

// dialAndResume performs one auth-frame resume (last_seq set) over a fresh
// websocket connection and returns every frame the server sends after
// auth_ok, up to a short idle timeout.
func dialAndResume(t *testing.T, hub *Hub, token string, lastSeq uint64) [][]byte {
	t.Helper()
	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	defer srv.Close()

	dialCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, dialResp, dialErr := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if dialResp != nil && dialResp.Body != nil {
		_ = dialResp.Body.Close()
	}
	if dialErr != nil {
		t.Fatalf("websocket.Dial: %v", dialErr)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	raw, _ := json.Marshal(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": token, "last_seq": lastSeq},
	})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	var frames [][]byte
	for {
		readCtx, readCancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		_, msg, err := conn.Read(readCtx)
		readCancel()
		if err != nil {
			break
		}
		frames = append(frames, msg)
	}
	if len(frames) == 0 {
		t.Fatal("no frames received from the resume handshake")
	}
	return frames
}

func itoaTest(n int64) string {
	return strconv.FormatInt(n, 10)
}

// TestNSFW_AdministratorAcknowledgesLikeAnyoneElse pins decision 13: an
// administrator without a row is refused exactly like a member; with a row,
// admitted.
func TestNSFW_AdministratorAcknowledgesLikeAnyoneElse(t *testing.T) {
	f := newNSFWGateFixture(t)
	ctx := context.Background()

	adminID, err := f.db.CreateUser(ctx, "admin-no-row", "hash", 1) // Owner = admin bit
	if err != nil {
		t.Fatalf("CreateUser(admin): %v", err)
	}
	if _, _, err := f.svc.Messages.GetMessages(ctx, adminID, f.labelledID, 0, 50); !isNSFWForbidden(err) {
		t.Errorf("GetMessages(admin without a row) = %v, want ErrForbidden+ErrNSFWUnacknowledged", err)
	}
	adminUser, err := f.db.GetUserByID(ctx, adminID)
	if err != nil || adminUser == nil {
		t.Fatalf("GetUserByID(admin): %v", err)
	}
	adminRole, err := f.db.GetRoleForUser(ctx, adminID)
	if err != nil {
		t.Fatalf("GetRoleForUser(admin): %v", err)
	}
	aa, err := f.svc.Uploads.Resolve(ctx, f.attachmentID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if err := f.svc.Uploads.Authorize(ctx, aa, adminUser, adminRole); !errors.Is(err, permissions.ErrNSFWUnacknowledged) {
		t.Errorf("Authorize(admin without a row) = %v, want ErrNSFWUnacknowledged", err)
	}

	if _, err := f.db.AcknowledgeNSFW(ctx, adminID, f.labelledID); err != nil {
		t.Fatalf("AcknowledgeNSFW(admin): %v", err)
	}
	if _, _, err := f.svc.Messages.GetMessages(ctx, adminID, f.labelledID, 0, 50); err != nil {
		t.Errorf("GetMessages(admin with a row) = %v, want nil", err)
	}
	if err := f.svc.Uploads.Authorize(ctx, aa, adminUser, adminRole); err != nil {
		t.Errorf("Authorize(admin with a row) = %v, want nil", err)
	}
}

// TestNSFW_PluginSinkGetsNoLabelledContent asserts on the sink itself (P2-7),
// not merely the gate's verdict: EventSink.Dispatch's own doc records that no
// production code calls Subscribe today, so its subscriber loop never
// iterates in either build — DispatchCount is what proves the hub withheld
// the CALL, which is the actual decision 13 guarantee (a plugin sees nothing
// of a labelled channel, not just "nothing forwarded to a subscriber list
// that's empty anyway"). A control publish to the unlabelled channel proves
// the sink is wired at all, so a suppression bug can't hide behind "nothing
// ever reaches Dispatch".
func TestNSFW_PluginSinkGetsNoLabelledContent(t *testing.T) {
	f := newNSFWGateFixture(t)
	ctx := context.Background()

	sink := plugin.NewEventSink()
	f.hub.SetPluginEventSink(sink)
	go f.hub.Run()
	t.Cleanup(f.hub.Stop)

	waitUntilRunning(t, f.hub)

	labelledPayload, _ := json.Marshal(map[string]any{
		"type":    MsgTypeChatMessage,
		"payload": map[string]any{"channel_id": f.labelledID, "content": "labelled live"},
	})
	f.hub.EmitEvents(ctx, []Event{MessageSentChannelEvent{channelID: f.labelledID, payload: labelledPayload}})
	if err := f.hub.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}
	if got := sink.DispatchCount.Load(); got != 0 {
		t.Errorf("plugin sink received %d call(s) for the labelled channel's content, want 0", got)
	}

	controlPayload, _ := json.Marshal(map[string]any{
		"type":    MsgTypeChatMessage,
		"payload": map[string]any{"channel_id": f.controlID, "content": "control live"},
	})
	f.hub.EmitEvents(ctx, []Event{MessageSentChannelEvent{channelID: f.controlID, payload: controlPayload}})
	if err := f.hub.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}
	if got := sink.DispatchCount.Load(); got != 1 {
		t.Fatalf("plugin sink received %d call(s) for the unlabelled control channel, want exactly 1 (sink not wired?)", got)
	}
}

// TestNSFW_UnlabellingDeletesAcknowledgementsAndRelabellingReprompts proves
// the label-lifecycle rule end to end through the service layer.
func TestNSFW_UnlabellingDeletesAcknowledgementsAndRelabellingReprompts(t *testing.T) {
	f := newNSFWGateFixture(t)
	ctx := context.Background()

	existing, err := f.db.GetChannel(ctx, f.labelledID)
	if err != nil || existing == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if _, err := f.svc.Channels.AdminUpdateChannel(ctx, f.authorID, existing, service.AdminChannelUpdate{
		Name: existing.Name, NSFW: false,
	}, nil); err != nil {
		t.Fatalf("AdminUpdateChannel (unlabel): %v", err)
	}
	if ok, err := f.db.HasNSFWAcknowledgement(ctx, f.aliceID, f.labelledID); err != nil || ok {
		t.Fatalf("HasNSFWAcknowledgement after unlabel = (%v, %v), want (false, nil)", ok, err)
	}

	existing, err = f.db.GetChannel(ctx, f.labelledID)
	if err != nil || existing == nil {
		t.Fatalf("GetChannel (re-read): %v", err)
	}
	if _, err := f.svc.Channels.AdminUpdateChannel(ctx, f.authorID, existing, service.AdminChannelUpdate{
		Name: existing.Name, NSFW: true,
	}, nil); err != nil {
		t.Fatalf("AdminUpdateChannel (relabel): %v", err)
	}
	// alice must re-acknowledge — her old row is gone and re-labelling wrote
	// nothing new.
	if _, _, err := f.svc.Messages.GetMessages(ctx, f.aliceID, f.labelledID, 0, 50); !isNSFWForbidden(err) {
		t.Errorf("GetMessages(alice) after relabel = %v, want ErrForbidden+ErrNSFWUnacknowledged (reprompt)", err)
	}
}

// TestNSFW_RevokeWhileDisconnectedForcesFullReadyOnResume is P2-8: nsfw_ack
// is unsequenced and not replayed, so a revoke landing while the client is
// disconnected can never reach it through the ordinary seq-replay path. The
// handler bumps the visibility watermark (ws.Hub.MarkVisibilityChanged, the
// same call dm_channel_open uses) on every acknowledge/revoke — this proves
// a warm resume past that bump is forced onto the full-ready path and comes
// back with the authoritative (revoked) nsfw_acknowledged state, with no
// nsfw_ack frame involved at all.
func TestNSFW_RevokeWhileDisconnectedForcesFullReadyOnResume(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "resume-nsfw-revoke-user", "hash", 4) // Member
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "resume-revoke-labelled", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, chID); err != nil {
		t.Fatalf("label channel: %v", err)
	}
	if _, err := database.AcknowledgeNSFW(ctx, userID, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW: %v", err)
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHub(t, database, limiter, svc)
	go hub.Run()
	t.Cleanup(hub.Stop)

	// The client is not connected right now — anchor a last_seq the ring
	// buffer can otherwise replay just fine (98..100 bracket 99 with room on
	// both sides), so the full ready below is provably forced by the
	// watermark bump, not by an unrelated "seq too old" ring-buffer miss.
	rb := hub.ReplayBuffer()
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"pre-existing"}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"anchor"}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"unrelated"}}`))
	// The ring buffer's contents don't move the hub's own seq counter (Push
	// is a direct test seam) — align it, or bumpVisibilityWatermark below
	// would ratchet the watermark to 0 (nothing broadcast yet) and never
	// exceed last_seq=99, silently defeating the fix under test.
	hub.SeedSeq(100)

	// Revoke "while disconnected": the service call plus the exact watermark
	// bump handleNSFWRevoke now performs — no socket ever sees an nsfw_ack
	// frame for this.
	if err := svc.NSFW.Revoke(ctx, userID, chID); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	hub.MarkVisibilityChanged()

	var sawReady bool
	var ackAfterResume *bool
	for _, evt := range dialAndResume(t, hub, token, 99) {
		var frame struct {
			Type    string `json:"type"`
			Payload struct {
				Channels []struct {
					ID               int64 `json:"id"`
					NSFWAcknowledged bool  `json:"nsfw_acknowledged"`
				} `json:"channels"`
			} `json:"payload"`
		}
		if json.Unmarshal(evt, &frame) != nil || frame.Type != MsgTypeReady {
			continue
		}
		sawReady = true
		for _, ch := range frame.Payload.Channels {
			if ch.ID == chID {
				v := ch.NSFWAcknowledged
				ackAfterResume = &v
			}
		}
	}
	if !sawReady {
		t.Fatal("resume past a revoke's watermark bump did not send a full ready — a missed nsfw_ack is unrecoverable")
	}
	if ackAfterResume == nil {
		t.Fatalf("ready did not carry channel %d at all", chID)
	}
	if *ackAfterResume {
		t.Fatal("ready's nsfw_acknowledged is still true after a revoke that happened while disconnected")
	}
}

// waitUntilRunning blocks until the hub's dispatch loop (started via `go
// hub.Run()`) has set its running flag, so a broadcast enqueued right after
// is not silently skipped by awaitDispatch's "not running yet" fast path.
func waitUntilRunning(t *testing.T, h *Hub) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !h.RunningForTest() {
		if time.Now().After(deadline) {
			t.Fatal("hub did not start running in time")
		}
		time.Sleep(time.Millisecond)
	}
}

// channelIDOf extracts payload.channel_id from a wrapped wire frame, or 0 if
// absent/unparseable — the id chat_message and reaction_update carry
// directly (unlike chat_edited/chat_deleted, which this test does not need).
func channelIDOf(data []byte) int64 {
	var frame struct {
		Payload struct {
			ChannelID int64 `json:"channel_id"`
		} `json:"payload"`
	}
	if json.Unmarshal(data, &frame) != nil {
		return 0
	}
	return frame.Payload.ChannelID
}
