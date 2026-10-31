package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/google/uuid"
)

type forwardHarness struct {
	svc                *service.Services
	hub                *ws.Hub
	database           *db.DB
	alice, bob         *db.User
	srcChan, dstChan   int64
	dmChan             int64
	srcID              int64
	aliceCl, bobCl     *ws.Client
	aliceFrames, bobFr chan []byte
}

// newForwardHarness builds a fully migrated server with alice (owner) and bob
// (member) connected, a source message holding an @mention and a file, a
// target channel and a trusted DM between them.
func newForwardHarness(t *testing.T) *forwardHarness {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	files, err := storage.New(t.TempDir(), 10)
	if err != nil {
		t.Fatal(err)
	}
	svc.Uploads.SetFileCloner(files)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	t.Cleanup(hub.Stop)

	h := &forwardHarness{svc: svc, hub: hub, database: database}
	h.alice = seedOwnerUser(t, database, "fwd-alice")
	h.bob = seedMemberUser(t, database, "fwd-bob")
	h.srcChan = seedTestChannel(t, database, "fwd-source")
	h.dstChan = seedTestChannel(t, database, "fwd-target")
	h.dmChan = seedDMChannel(t, database, h.alice.ID, h.bob.ID)

	fileID := uuid.NewString()
	if _, err := files.Save(fileID, strings.NewReader("PNGDATA-forwarded")); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateAttachment(context.Background(), fileID, h.alice.ID, "pic.png", fileID, "image/png", 17, nil, nil); err != nil {
		t.Fatal(err)
	}
	res, err := svc.Messages.SendMessage(context.Background(), service.SendMessageParams{
		ChannelID: h.srcChan, UserID: h.alice.ID, Username: h.alice.Username,
		Content: "hello @fwd-bob", AttachmentIDs: []string{fileID},
	})
	if err != nil {
		t.Fatal(err)
	}
	h.srcID = res.MessageID

	h.aliceFrames, h.bobFr = make(chan []byte, 128), make(chan []byte, 128)
	h.aliceCl = ws.NewTestClientWithUser(hub, h.alice, h.srcChan, h.aliceFrames)
	h.bobCl = ws.NewTestClientWithUser(hub, h.bob, h.dstChan, h.bobFr)
	hub.Register(h.aliceCl)
	hub.Register(h.bobCl)
	waitRegistered(t, hub, h.bobCl)
	return h
}

func (h *forwardHarness) send(cmid, reqID string, channelID, messageID int64) {
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_forward", "id": reqID,
		"payload": map[string]any{"client_message_id": cmid, "channel_id": channelID, "message_id": messageID},
	})
	h.hub.HandleMessageForTest(h.aliceCl, raw)
}

// replayHas reports whether one frame in the replay buffer contains every part.
func replayHas(hub *ws.Hub, parts ...string) bool {
	for _, f := range hub.ReplayBuffer().AllFramesForTest() {
		all := true
		for _, p := range parts {
			all = all && strings.Contains(string(f), p)
		}
		if all {
			return true
		}
	}
	return false
}

func forwardCMID() string { return fmt.Sprintf("%d:%s", time.Now().UnixMilli(), uuid.NewString()) }

type forwardFrame struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Seq     int64  `json:"seq"`
	Payload struct {
		ID              int64                 `json:"id"`
		MessageID       int64                 `json:"message_id"`
		ChannelID       int64                 `json:"channel_id"`
		ClientMessageID string                `json:"client_message_id"`
		Deduplicated    bool                  `json:"deduplicated"`
		Content         string                `json:"content"`
		Mentions        []int64               `json:"mentions"`
		MentionsAll     bool                  `json:"mentions_everyone"`
		Attachments     []struct{ ID string } `json:"attachments"`
		Forward         *struct {
			SourceChannelID int64  `json:"source_channel_id"`
			SourceMessageID *int64 `json:"source_message_id"`
			SourceTimestamp string `json:"source_timestamp"`
		} `json:"forward"`
		Code string `json:"code"`
	} `json:"payload"`
}

func collectForwardFrames(ch <-chan []byte, d time.Duration) []forwardFrame {
	var out []forwardFrame
	for _, raw := range drainChanTimeout(ch, d) {
		var f forwardFrame
		if json.Unmarshal(raw, &f) == nil {
			out = append(out, f)
		}
	}
	return out
}

func firstOfType(frames []forwardFrame, typ string) *forwardFrame {
	for i := range frames {
		if frames[i].Type == typ {
			return &frames[i]
		}
	}
	return nil
}

func TestChatForward_ChannelAndDMFanout(t *testing.T) {
	t.Parallel()
	h := newForwardHarness(t)
	ctx := context.Background()

	// Channel target: bob, who has it focused, gets one sequenced chat_message.
	cmid := forwardCMID()
	h.send(cmid, "req-chan", h.dstChan, h.srcID)
	aliceFrames := collectForwardFrames(h.aliceFrames, 200*time.Millisecond)
	ok := firstOfType(aliceFrames, "chat_forward_ok")
	if ok == nil || ok.ID != "req-chan" || ok.Payload.ChannelID != h.dstChan || ok.Payload.ClientMessageID != cmid ||
		ok.Payload.Deduplicated || ok.Payload.MessageID <= 0 {
		t.Fatalf("chat_forward_ok = %+v", ok)
	}
	bobFrames := collectForwardFrames(h.bobFr, 100*time.Millisecond)
	msg := firstOfType(bobFrames, "chat_message")
	if msg == nil || msg.Seq == 0 || msg.Payload.ID != ok.Payload.MessageID {
		t.Fatalf("channel chat_message = %+v (all: %+v)", msg, bobFrames)
	}
	if msg.Payload.Content != "hello @fwd-bob" || len(msg.Payload.Attachments) != 1 {
		t.Errorf("snapshot not delivered: %+v", msg.Payload)
	}
	if msg.Payload.Mentions == nil || len(msg.Payload.Mentions) != 0 || msg.Payload.MentionsAll {
		t.Errorf("mentions = %v (everyone=%v), want an empty list", msg.Payload.Mentions, msg.Payload.MentionsAll)
	}
	if msg.Payload.Forward == nil || msg.Payload.Forward.SourceChannelID != h.srcChan ||
		msg.Payload.Forward.SourceMessageID == nil || *msg.Payload.Forward.SourceMessageID != h.srcID {
		t.Errorf("forward block = %+v", msg.Payload.Forward)
	}
	if n, err := h.database.GetMentionCount(ctx, h.bob.ID, h.dstChan); err != nil || n != 0 {
		t.Errorf("bob's mention count = %d, %v", n, err)
	}
	// The frame replays as is, forward block included.
	if !replayHas(h.hub, `"forward":{"source_channel_id"`, `"mentions":[]`, fmt.Sprintf(`"channel_id":%d`, h.dstChan)) {
		t.Error("the channel forward frame is not in the replay buffer with its block")
	}

	// A lost ack: the retry is answered from the receipt, nothing is re-sent.
	h.send(cmid, "req-retry", h.dstChan, h.srcID)
	retryFrames := collectForwardFrames(h.aliceFrames, 200*time.Millisecond)
	dup := firstOfType(retryFrames, "chat_forward_ok")
	if dup == nil || dup.ID != "req-retry" || !dup.Payload.Deduplicated || dup.Payload.MessageID != ok.Payload.MessageID {
		t.Fatalf("retry ack = %+v", dup)
	}
	if firstOfType(retryFrames, "chat_message") != nil || firstOfType(collectForwardFrames(h.bobFr, 100*time.Millisecond), "chat_message") != nil {
		t.Error("a retried forward was broadcast again")
	}

	// DM target: addressed to the participants, sequenced and replayed.
	h.send(forwardCMID(), "req-dm", h.dmChan, h.srcID)
	dmOK := firstOfType(collectForwardFrames(h.aliceFrames, 200*time.Millisecond), "chat_forward_ok")
	if dmOK == nil || dmOK.Payload.ChannelID != h.dmChan {
		t.Fatalf("DM chat_forward_ok = %+v", dmOK)
	}
	dm := firstOfType(collectForwardFrames(h.bobFr, 200*time.Millisecond), "chat_message")
	if dm == nil || dm.Seq == 0 || dm.Payload.Forward == nil || dm.Payload.Mentions == nil || len(dm.Payload.Mentions) != 0 {
		t.Fatalf("DM chat_message = %+v", dm)
	}
	if !replayHas(h.hub, `"forward":{"source_channel_id"`, fmt.Sprintf(`"channel_id":%d`, h.dmChan)) {
		t.Error("the DM forward is not in the replay buffer with its block")
	}
}

func TestChatForward_RefusalsAnswerErrorFrames(t *testing.T) {
	h := newForwardHarness(t)
	h.send(forwardCMID(), "req-missing", h.dstChan, 999999)
	f := collectForwardFrames(h.aliceFrames, 200*time.Millisecond)
	e := firstOfType(f, "error")
	if e == nil || e.ID != "req-missing" || e.Payload.Code != ws.ErrCodeNotFound {
		t.Fatalf("missing source: %+v", f)
	}
	// A frame without client_message_id never reaches the service.
	raw, _ := json.Marshal(map[string]any{"type": "chat_forward", "id": "req-nokey",
		"payload": map[string]any{"channel_id": h.dstChan, "message_id": h.srcID}})
	h.hub.HandleMessageForTest(h.aliceCl, raw)
	if firstOfType(collectForwardFrames(h.aliceFrames, 200*time.Millisecond), "chat_forward_ok") != nil {
		t.Error("a forward without client_message_id was accepted")
	}
	var n int
	if err := h.database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM message_forwards`).Scan(&n); err != nil || n != 0 {
		t.Errorf("refused forwards left %d side rows (%v)", n, err)
	}
}
