package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/ws"
)

type pollFrame struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Seq     int64  `json:"seq"`
	Payload struct {
		ID              int64    `json:"id"`
		MessageID       int64    `json:"message_id"`
		ChannelID       int64    `json:"channel_id"`
		ClientMessageID string   `json:"client_message_id"`
		Deduplicated    bool     `json:"deduplicated"`
		Content         string   `json:"content"`
		Mentions        []int64  `json:"mentions"`
		MentionsAll     bool     `json:"mentions_everyone"`
		Forward         any      `json:"forward"`
		Code            string   `json:"code"`
		Poll            *pollObj `json:"poll"`
		Version         int64    `json:"version"`
		TotalVoters     int64    `json:"total_voters"`
		Counts          []struct {
			AnswerID int64 `json:"answer_id"`
			Count    int64 `json:"count"`
		} `json:"counts"`
		Ended     bool    `json:"ended"`
		EndedAt   *string `json:"ended_at"`
		UserID    int64   `json:"user_id"`
		AnswerIDs []int64 `json:"answer_ids"`
	} `json:"payload"`
}

type pollObj struct {
	Question string `json:"question"`
	Answers  []struct {
		AnswerID int64   `json:"answer_id"`
		Text     string  `json:"text"`
		Emoji    *string `json:"emoji"`
	} `json:"answers"`
	AllowMultiselect bool    `json:"allow_multiselect"`
	ExpiresAt        string  `json:"expires_at"`
	Ended            bool    `json:"ended"`
	EndedAt          *string `json:"ended_at"`
	Results          struct {
		Version     int64 `json:"version"`
		TotalVoters int64 `json:"total_voters"`
		Counts      []struct {
			AnswerID int64 `json:"answer_id"`
			Count    int64 `json:"count"`
		} `json:"counts"`
		Me []int64 `json:"me"`
	} `json:"results"`
}

func collectPollFrames(ch <-chan []byte, d time.Duration) []pollFrame {
	var out []pollFrame
	for _, raw := range drainChanTimeout(ch, d) {
		var f pollFrame
		if json.Unmarshal(raw, &f) == nil {
			out = append(out, f)
		}
	}
	return out
}

func firstPollFrame(frames []pollFrame, typ string) *pollFrame {
	for i := range frames {
		if frames[i].Type == typ {
			return &frames[i]
		}
	}
	return nil
}

func (h *forwardHarness) sendPoll(cmid, reqID string, channelID int64, mutate func(map[string]any)) {
	payload := map[string]any{
		"client_message_id": cmid, "channel_id": channelID, "question": "Lunch?",
		"answers":        []map[string]any{{"text": "Pizza"}, {"text": "Sushi", "emoji": "🍣"}},
		"duration_hours": 24, "allow_multiselect": false,
	}
	if mutate != nil {
		mutate(payload)
	}
	raw, _ := json.Marshal(map[string]any{"type": "poll_create", "id": reqID, "payload": payload})
	h.hub.HandleMessageForTest(h.aliceCl, raw)
}

func TestPollCreate_ChannelAndDMFanout(t *testing.T) {
	t.Parallel()
	h := newForwardHarness(t)

	// Channel target: bob, who has it focused, gets one sequenced chat_message
	// with the poll block, and an empty mention set whatever the text holds.
	cmid := forwardCMID()
	h.sendPoll(cmid, "req-chan", h.dstChan, func(p map[string]any) { p["question"] = "Lunch @fwd-bob?" })
	ok := firstPollFrame(collectPollFrames(h.aliceFrames, 200*time.Millisecond), "poll_create_ok")
	if ok == nil || ok.ID != "req-chan" || ok.Payload.ChannelID != h.dstChan || ok.Payload.ClientMessageID != cmid ||
		ok.Payload.Deduplicated || ok.Payload.MessageID <= 0 {
		t.Fatalf("poll_create_ok = %+v", ok)
	}
	msg := firstPollFrame(collectPollFrames(h.bobFr, 100*time.Millisecond), "chat_message")
	if msg == nil || msg.Seq == 0 || msg.Payload.ID != ok.Payload.MessageID {
		t.Fatalf("channel chat_message = %+v", msg)
	}
	if want := "📊 Lunch @fwd-bob?\n- Pizza\n- 🍣 Sushi"; msg.Payload.Content != want {
		t.Errorf("fallback content = %q, want %q", msg.Payload.Content, want)
	}
	if msg.Payload.Mentions == nil || len(msg.Payload.Mentions) != 0 || msg.Payload.MentionsAll {
		t.Errorf("mentions = %v (everyone=%v), want an empty list", msg.Payload.Mentions, msg.Payload.MentionsAll)
	}
	p := msg.Payload.Poll
	if p == nil || p.Question != "Lunch @fwd-bob?" || p.Ended || p.EndedAt != nil || p.AllowMultiselect || p.ExpiresAt == "" ||
		len(p.Answers) != 2 || p.Answers[1].AnswerID != 2 || p.Answers[1].Emoji == nil || *p.Answers[1].Emoji != "🍣" {
		t.Fatalf("poll block = %+v", p)
	}
	if r := p.Results; r.Version != 0 || r.TotalVoters != 0 || len(r.Counts) != 2 || r.Me == nil || len(r.Me) != 0 {
		t.Errorf("results = %+v, want zero counts and an empty me", r)
	}
	if n, err := h.database.GetMentionCount(context.Background(), h.bob.ID, h.dstChan); err != nil || n != 0 {
		t.Errorf("bob's mention count = %d, %v", n, err)
	}
	// The frame replays as is, poll block included.
	if !replayHas(h.hub, `"poll":{"question"`, `"mentions":[]`, fmt.Sprintf(`"channel_id":%d`, h.dstChan)) {
		t.Error("the channel poll frame is not in the replay buffer with its block")
	}

	// A lost ack: the retry is answered from the receipt, nothing is re-sent.
	h.sendPoll(cmid, "req-retry", h.dstChan, func(p map[string]any) { p["question"] = "Lunch @fwd-bob?" })
	retry := collectPollFrames(h.aliceFrames, 200*time.Millisecond)
	dup := firstPollFrame(retry, "poll_create_ok")
	if dup == nil || dup.ID != "req-retry" || !dup.Payload.Deduplicated || dup.Payload.MessageID != ok.Payload.MessageID {
		t.Fatalf("retry ack = %+v", dup)
	}
	if firstPollFrame(retry, "chat_message") != nil || firstPollFrame(collectPollFrames(h.bobFr, 100*time.Millisecond), "chat_message") != nil {
		t.Error("a retried poll was broadcast again")
	}

	// DM target: addressed to the participants, sequenced and replayed.
	h.sendPoll(forwardCMID(), "req-dm", h.dmChan, nil)
	dmOK := firstPollFrame(collectPollFrames(h.aliceFrames, 200*time.Millisecond), "poll_create_ok")
	if dmOK == nil || dmOK.Payload.ChannelID != h.dmChan {
		t.Fatalf("DM poll_create_ok = %+v", dmOK)
	}
	dm := firstPollFrame(collectPollFrames(h.bobFr, 200*time.Millisecond), "chat_message")
	if dm == nil || dm.Seq == 0 || dm.Payload.Poll == nil || dm.Payload.Mentions == nil || len(dm.Payload.Mentions) != 0 {
		t.Fatalf("DM chat_message = %+v", dm)
	}
	if !replayHas(h.hub, `"poll":{"question"`, fmt.Sprintf(`"channel_id":%d`, h.dmChan)) {
		t.Error("the DM poll is not in the replay buffer with its block")
	}
}

func TestPollCreate_HistoryCarriesTheBlock(t *testing.T) {
	h := newForwardHarness(t)
	h.sendPoll(forwardCMID(), "req-hist", h.dstChan, nil)
	ok := firstPollFrame(collectPollFrames(h.aliceFrames, 200*time.Millisecond), "poll_create_ok")
	if ok == nil {
		t.Fatal("no poll_create_ok")
	}
	msgs, err := h.database.GetMessagesForAPI(context.Background(), h.dstChan, 0, 10, h.bob.ID)
	if err != nil || len(msgs) != 1 || msgs[0].Poll == nil || msgs[0].ID != ok.Payload.MessageID {
		t.Fatalf("history = %+v, %v", msgs, err)
	}
}

func TestPollCreate_RefusalsAnswerErrorFrames(t *testing.T) {
	h := newForwardHarness(t)
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
		code   string
	}{
		{"one answer", func(p map[string]any) { p["answers"] = []map[string]any{{"text": "only"}} }, ws.ErrCodeBadRequest},
		{"bad duration", func(p map[string]any) { p["duration_hours"] = 5 }, ws.ErrCodeBadRequest},
		{"empty question", func(p map[string]any) { p["question"] = "" }, ws.ErrCodeBadRequest},
		{"bad emoji", func(p map[string]any) { p["answers"] = []map[string]any{{"text": "a", "emoji": "<b>"}, {"text": "b"}} }, ws.ErrCodeBadRequest},
		{"unknown channel", func(p map[string]any) { p["channel_id"] = 999999 }, ws.ErrCodeNotFound},
	} {
		h.sendPoll(forwardCMID(), "req-"+tc.name, h.dstChan, tc.mutate)
		frames := collectPollFrames(h.aliceFrames, 200*time.Millisecond)
		e := firstPollFrame(frames, "error")
		if e == nil || e.ID != "req-"+tc.name || e.Payload.Code != tc.code {
			t.Errorf("%s: frames = %+v, want a %s error", tc.name, frames, tc.code)
		}
		if firstPollFrame(frames, "poll_create_ok") != nil {
			t.Errorf("%s: a refused poll was acknowledged", tc.name)
		}
	}
	// A frame without client_message_id never reaches the service.
	raw, _ := json.Marshal(map[string]any{"type": "poll_create", "id": "req-nokey",
		"payload": map[string]any{"channel_id": h.dstChan, "question": "q", "answers": []map[string]any{{"text": "a"}, {"text": "b"}}, "duration_hours": 24}})
	h.hub.HandleMessageForTest(h.aliceCl, raw)
	if firstPollFrame(collectPollFrames(h.aliceFrames, 200*time.Millisecond), "poll_create_ok") != nil {
		t.Error("a poll without client_message_id was accepted")
	}
	var n int
	if err := h.database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM polls`).Scan(&n); err != nil || n != 0 {
		t.Errorf("refused polls left %d poll rows (%v)", n, err)
	}
	if strings.Contains(fmt.Sprint(h.hub.ReplayBuffer().AllFramesForTest()), `"poll":`) {
		t.Error("a refused poll reached the replay buffer")
	}
}
