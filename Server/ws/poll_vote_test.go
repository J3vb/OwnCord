package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// pollWire sends one poll command as cl.
func (h *forwardHarness) pollWire(cl *ws.Client, typ, reqID string, payload map[string]any) {
	raw, _ := json.Marshal(map[string]any{"type": typ, "id": reqID, "payload": payload})
	h.hub.HandleMessageForTest(cl, raw)
}

func (h *forwardHarness) vote(cl *ws.Client, reqID string, messageID int64, ids ...int64) {
	if ids == nil {
		ids = []int64{}
	}
	h.pollWire(cl, "poll_vote", reqID, map[string]any{"message_id": messageID, "answer_ids": ids})
}

func (h *forwardHarness) endPoll(cl *ws.Client, reqID string, messageID int64) {
	h.pollWire(cl, "poll_end", reqID, map[string]any{"message_id": messageID})
}

// focus subscribes cl to a channel, as the client does on opening it.
func (h *forwardHarness) focus(cl *ws.Client, channelID int64) {
	raw, _ := json.Marshal(map[string]any{"type": "channel_focus", "payload": map[string]any{"channel_id": channelID}})
	h.hub.HandleMessageForTest(cl, raw)
}

// rawPoll writes a poll authored by alice straight to the tables, so a test can
// have as many as it likes without meeting the creation limiter.
func (h *forwardHarness) rawPoll(t *testing.T, channelID int64, multi bool) int64 {
	t.Helper()
	ctx := context.Background()
	id, err := h.database.CreateMessage(ctx, channelID, h.alice.ID, "📊 raw\n- a\n- b", nil)
	if err != nil {
		t.Fatal(err)
	}
	m := 0
	if multi {
		m = 1
	}
	if _, err := h.database.ExecContext(ctx, `INSERT INTO polls (message_id, question, allow_multiselect, expires_at) VALUES (?, 'raw', ?, '2999-01-01T00:00:00Z')`, id, m); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.ExecContext(ctx, `INSERT INTO poll_answers (message_id, answer_id, text) VALUES (?, 1, 'a'), (?, 2, 'b')`, id, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func rawFrame(t *testing.T, ch <-chan []byte, typ string, within time.Duration) map[string]any {
	t.Helper()
	f := nextFrameOfType(ch, typ, within)
	if f == nil {
		t.Fatalf("no %s frame within %v", typ, within)
	}
	return f
}

func payloadOf(f map[string]any) map[string]any {
	p, _ := f["payload"].(map[string]any)
	return p
}

// A vote answers the voter, and every subscriber gets one sequenced, replayable
// poll_update with the full counts, the version, and the voter's id and set.
func TestPollVote_UpdateCarriesVersionAndVoter(t *testing.T) {
	t.Parallel()
	h := newForwardHarness(t)
	h.focus(h.aliceCl, h.dstChan)
	poll := h.rawPoll(t, h.dstChan, false)
	drainChanTimeout(h.aliceFrames, 50*time.Millisecond)
	drainChanTimeout(h.bobFr, 50*time.Millisecond)

	h.vote(h.bobCl, "req-vote", poll, 2)
	frames := collectPollFrames(h.aliceFrames, 200*time.Millisecond)
	upd := firstPollFrame(frames, "poll_update")
	if upd == nil || upd.Seq == 0 {
		t.Fatalf("alice's frames = %+v, want a sequenced poll_update", frames)
	}
	p := upd.Payload
	if p.ChannelID != h.dstChan || p.MessageID != poll || p.Version != 1 || p.TotalVoters != 1 || p.Ended || p.EndedAt != nil ||
		p.UserID != h.bob.ID || !slices.Equal(p.AnswerIDs, []int64{2}) || len(p.Counts) != 2 || p.Counts[0].Count != 0 || p.Counts[1].Count != 1 {
		t.Fatalf("poll_update payload = %+v", p)
	}
	if !replayHas(h.hub, `"type":"poll_update"`, fmt.Sprintf(`"message_id":%d`, poll), `"user_id":`) {
		t.Error("the poll_update is not in the replay buffer")
	}

	// The reply carries the version and the stored selection.
	h.vote(h.bobCl, "req-vote-2", poll, 1)
	bobFrames := collectPollFrames(h.bobFr, 200*time.Millisecond)
	var vok *pollFrame
	for i := range bobFrames {
		if bobFrames[i].Type == "poll_vote_ok" && bobFrames[i].ID == "req-vote-2" {
			vok = &bobFrames[i]
		}
	}
	if vok == nil || vok.ID != "req-vote-2" || vok.Payload.MessageID != poll || vok.Payload.Version != 2 || !slices.Equal(vok.Payload.AnswerIDs, []int64{1}) {
		t.Fatalf("poll_vote_ok = %+v (frames %+v)", vok, bobFrames)
	}
	if firstPollFrame(bobFrames, "poll_update") == nil {
		t.Error("the voter did not receive the poll_update too")
	}
	drainChanTimeout(h.aliceFrames, 50*time.Millisecond)

	// A retry of the same selection is acknowledged with the current version and
	// emits nothing.
	h.vote(h.bobCl, "req-vote-retry", poll, 1)
	retry := collectPollFrames(h.bobFr, 200*time.Millisecond)
	rok := firstPollFrame(retry, "poll_vote_ok")
	if rok == nil || rok.Payload.Version != 2 || firstPollFrame(retry, "poll_update") != nil {
		t.Fatalf("retry frames = %+v, want a bare poll_vote_ok at version 2", retry)
	}
	if firstPollFrame(collectPollFrames(h.aliceFrames, 100*time.Millisecond), "poll_update") != nil {
		t.Error("a no-op vote was broadcast")
	}

	// An empty selection removes the vote, and the frame says so with an empty set.
	h.vote(h.bobCl, "req-remove", poll)
	raw := rawFrame(t, h.aliceFrames, "poll_update", time.Second)
	pl := payloadOf(raw)
	ids, present := pl["answer_ids"].([]any)
	if !present || len(ids) != 0 || pl["user_id"] == nil || pl["total_voters"].(float64) != 0 || pl["version"].(float64) != 3 {
		t.Errorf("removal payload = %+v, want answer_ids [] present, user_id, total_voters 0, version 3", pl)
	}
}

func TestPollVote_DMUpdateIsAddressedToParticipants(t *testing.T) {
	h := newForwardHarness(t)
	poll := h.rawPoll(t, h.dmChan, false)
	h.vote(h.bobCl, "req-dm-vote", poll, 1)
	frames := collectPollFrames(h.aliceFrames, 300*time.Millisecond)
	upd := firstPollFrame(frames, "poll_update")
	if upd == nil || upd.Seq == 0 || upd.Payload.ChannelID != h.dmChan || upd.Payload.UserID != h.bob.ID {
		t.Fatalf("alice's frames = %+v, want the DM poll_update", frames)
	}
	if !replayHas(h.hub, `"type":"poll_update"`, fmt.Sprintf(`"channel_id":%d`, h.dmChan)) {
		t.Error("the DM poll_update is not in the replay buffer")
	}
}

func TestPollEnd_UpdateAndRefusals(t *testing.T) {
	t.Parallel()
	h := newForwardHarness(t)
	h.focus(h.aliceCl, h.dstChan)
	poll := h.rawPoll(t, h.dstChan, false)
	h.vote(h.bobCl, "req-v", poll, 2)
	drainChanTimeout(h.aliceFrames, 100*time.Millisecond)
	drainChanTimeout(h.bobFr, 100*time.Millisecond)

	// bob did not post it and cannot manage messages: refused, nothing changes.
	h.endPoll(h.bobCl, "req-bob-end", poll)
	e := firstPollFrame(collectPollFrames(h.bobFr, 200*time.Millisecond), "error")
	if e == nil || e.ID != "req-bob-end" || e.Payload.Code != ws.ErrCodeForbidden {
		t.Fatalf("a stranger ending a poll: %+v, want FORBIDDEN", e)
	}

	h.endPoll(h.aliceCl, "req-end", poll)
	aliceFrames := collectPollFrames(h.aliceFrames, 300*time.Millisecond)
	eok := firstPollFrame(aliceFrames, "poll_end_ok")
	if eok == nil || eok.ID != "req-end" || eok.Payload.MessageID != poll {
		t.Fatalf("poll_end_ok = %+v", eok)
	}
	upd := firstPollFrame(aliceFrames, "poll_update")
	if upd == nil || !upd.Payload.Ended || upd.Payload.EndedAt == nil || upd.Payload.Version != 2 || upd.Payload.TotalVoters != 1 || upd.Payload.Counts[1].Count != 1 {
		t.Fatalf("end poll_update = %+v", upd)
	}
	raw := rawFrameFromBytes(t, drainChanTimeout(h.bobFr, 200*time.Millisecond), "poll_update")
	pl := payloadOf(raw)
	if _, has := pl["user_id"]; has {
		t.Error("an end names a voter")
	}
	if _, has := pl["answer_ids"]; has {
		t.Error("an end carries a selection")
	}

	// Now the poll is over for votes and for a second end alike.
	for _, tc := range []struct{ typ, id string }{{"poll_vote", "req-late-vote"}, {"poll_end", "req-late-end"}} {
		if tc.typ == "poll_vote" {
			h.vote(h.bobCl, tc.id, poll, 1)
		} else {
			h.endPoll(h.aliceCl, tc.id, poll)
		}
		cl := h.bobFr
		if tc.typ == "poll_end" {
			cl = h.aliceFrames
		}
		er := firstPollFrame(collectPollFrames(cl, 200*time.Millisecond), "error")
		if er == nil || er.ID != tc.id || er.Payload.Code != "POLL_ENDED" {
			t.Errorf("%s after the end: %+v, want POLL_ENDED", tc.typ, er)
		}
	}
	if n := countPollRows(t, h, `SELECT COUNT(*) FROM poll_votes`); n != 1 {
		t.Errorf("vote rows = %d, want the one counted before the end", n)
	}
}

func rawFrameFromBytes(t *testing.T, frames [][]byte, typ string) map[string]any {
	t.Helper()
	for _, b := range frames {
		var env map[string]any
		if json.Unmarshal(b, &env) == nil && env["type"] == typ {
			return env
		}
	}
	t.Fatalf("no %s frame among %d", typ, len(frames))
	return nil
}

func countPollRows(t *testing.T, h *forwardHarness, q string) int {
	t.Helper()
	var n int
	if err := h.database.QueryRowContext(context.Background(), q).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPollCommands_RefusalsAnswerErrorFrames(t *testing.T) {
	t.Parallel()
	h := newForwardHarness(t)
	poll := h.rawPoll(t, h.dstChan, false)
	for _, tc := range []struct {
		name string
		send func()
		code string
	}{
		{"unknown poll", func() { h.vote(h.bobCl, "r-unknown", 999999, 1) }, ws.ErrCodeNotFound},
		{"two answers on a single-choice poll", func() { h.vote(h.bobCl, "r-two", poll, 1, 2) }, ws.ErrCodeBadRequest},
		{"unknown answer", func() { h.vote(h.bobCl, "r-bad", poll, 9) }, ws.ErrCodeBadRequest},
		{"end an unknown poll", func() { h.endPoll(h.aliceCl, "r-end-unknown", 999999) }, ws.ErrCodeNotFound},
		{"vote without answer_ids", func() {
			h.pollWire(h.bobCl, "poll_vote", "r-noids", map[string]any{"message_id": poll})
		}, ""},
		{"vote with a string message_id", func() {
			h.pollWire(h.bobCl, "poll_vote", "r-str", map[string]any{"message_id": "x", "answer_ids": []int{1}})
		}, ""},
		{"vote with a zero message_id", func() {
			h.pollWire(h.bobCl, "poll_vote", "r-zero", map[string]any{"message_id": 0, "answer_ids": []int{1}})
		}, ""},
		{"vote with too many answers", func() {
			ids := make([]int, 200)
			h.pollWire(h.bobCl, "poll_vote", "r-many", map[string]any{"message_id": poll, "answer_ids": ids})
		}, ""},
		{"end with no message_id", func() { h.pollWire(h.aliceCl, "poll_end", "r-end-none", map[string]any{}) }, ""},
	} {
		drainChanTimeout(h.bobFr, 10*time.Millisecond)
		drainChanTimeout(h.aliceFrames, 10*time.Millisecond)
		tc.send()
		frames := append(collectPollFrames(h.bobFr, 100*time.Millisecond), collectPollFrames(h.aliceFrames, 50*time.Millisecond)...)
		e := firstPollFrame(frames, "error")
		if e == nil {
			t.Errorf("%s: frames = %+v, want an error", tc.name, frames)
			continue
		}
		if tc.code != "" && e.Payload.Code != tc.code {
			t.Errorf("%s: code = %s, want %s", tc.name, e.Payload.Code, tc.code)
		}
		if firstPollFrame(frames, "poll_vote_ok") != nil || firstPollFrame(frames, "poll_end_ok") != nil || firstPollFrame(frames, "poll_update") != nil {
			t.Errorf("%s: a refused command was acknowledged or broadcast", tc.name)
		}
	}
}

// A poll_update names a message and carries its tallies, so an unacknowledged
// member of a labelled channel never receives it.
func TestPollUpdate_NSFWGated(t *testing.T) {
	t.Parallel()
	h := newForwardHarness(t)
	if _, err := h.database.ExecContext(context.Background(), `UPDATE channels SET nsfw = 1 WHERE id = ?`, h.dstChan); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.AcknowledgeNSFW(context.Background(), h.alice.ID, h.dstChan); err != nil {
		t.Fatal(err)
	}
	h.focus(h.aliceCl, h.dstChan)
	poll := h.rawPoll(t, h.dstChan, false)
	drainChanTimeout(h.aliceFrames, 50*time.Millisecond)
	drainChanTimeout(h.bobFr, 50*time.Millisecond)

	h.vote(h.aliceCl, "req-nsfw-vote", poll, 1)
	if firstPollFrame(collectPollFrames(h.aliceFrames, 200*time.Millisecond), "poll_update") == nil {
		t.Error("the acknowledged voter did not get the poll_update")
	}
	for _, f := range collectPollFrames(h.bobFr, 200*time.Millisecond) {
		if f.Type == "poll_update" {
			t.Errorf("an unacknowledged member received %+v", f)
		}
	}
	// And bob cannot vote on it either: the answer is the one for an unknown id.
	h.vote(h.bobCl, "req-nsfw-bob", poll, 1)
	e := firstPollFrame(collectPollFrames(h.bobFr, 200*time.Millisecond), "error")
	if e == nil || e.Payload.Code != ws.ErrCodeNotFound {
		t.Errorf("an unacknowledged voter: %+v, want NOT_FOUND", e)
	}
}

// Two voters race: both commits are applied and every subscriber sees a
// distinct version per change, so the highest version is the complete state.
func TestPollVote_RaceTwoVoters(t *testing.T) {
	h := newForwardHarness(t)
	h.focus(h.aliceCl, h.dstChan)
	poll := h.rawPoll(t, h.dstChan, false)
	drainChanTimeout(h.aliceFrames, 50*time.Millisecond)
	drainChanTimeout(h.bobFr, 50*time.Millisecond)

	const rounds = 8 // under the per-user vote limit
	start := make(chan struct{})
	var wg sync.WaitGroup
	for _, v := range []struct {
		cl     *ws.Client
		answer int64
		req    string
	}{{h.aliceCl, 1, "a"}, {h.bobCl, 2, "b"}} {
		wg.Go(func() {
			<-start
			for i := range rounds {
				// Alternate with the other answer so every call changes the vote.
				h.vote(v.cl, fmt.Sprintf("%s-%d", v.req, i), poll, (v.answer-1+int64(i))%2+1)
			}
		})
	}
	close(start)
	wg.Wait()

	versions := map[int64]bool{}
	var last *pollFrame
	for _, ch := range []chan []byte{h.aliceFrames} {
		for _, f := range collectPollFrames(ch, 500*time.Millisecond) {
			if f.Type != "poll_update" {
				continue
			}
			if versions[f.Payload.Version] {
				t.Fatalf("version %d was issued twice", f.Payload.Version)
			}
			versions[f.Payload.Version] = true
			if last == nil || f.Payload.Version > last.Payload.Version {
				c := f
				last = &c
			}
		}
	}
	if len(versions) != 2*rounds || last == nil || last.Payload.Version != 2*rounds {
		t.Fatalf("versions seen = %v, want 1..%d each once", versions, 2*rounds)
	}
	info, err := h.database.GetPollInfo(context.Background(), poll, 0)
	if err != nil || info.Results.TotalVoters != 2 || info.Results.Version != 2*rounds {
		t.Fatalf("stored = %+v, %v", info, err)
	}
	// The highest-version frame is exactly the stored state.
	for i, c := range info.Results.Counts {
		if last.Payload.Counts[i].Count != c.Count || last.Payload.TotalVoters != info.Results.TotalVoters {
			t.Errorf("highest frame %+v disagrees with the stored counts %+v", last.Payload, info.Results)
		}
	}
}

// A vote racing the end is counted or refused, never both: when bob's vote was
// acknowledged the end's counts include it, and when it was refused they do not.
func TestPollVote_RaceEnd(t *testing.T) {
	h := newForwardHarness(t)
	h.focus(h.aliceCl, h.dstChan)
	counted, refused := 0, 0
	for i := range 8 { // under the per-user limits
		poll := h.rawPoll(t, h.dstChan, false)
		drainChanTimeout(h.aliceFrames, 20*time.Millisecond)
		drainChanTimeout(h.bobFr, 20*time.Millisecond)
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); <-start; h.vote(h.bobCl, fmt.Sprintf("v-%d", i), poll, 1) }()
		go func() { defer wg.Done(); <-start; h.endPoll(h.aliceCl, fmt.Sprintf("e-%d", i), poll) }()
		close(start)
		wg.Wait()

		bobFrames := collectPollFrames(h.bobFr, 300*time.Millisecond)
		aliceFrames := collectPollFrames(h.aliceFrames, 100*time.Millisecond)
		var end *pollFrame
		for _, f := range append(aliceFrames, bobFrames...) {
			if f.Type == "poll_update" && f.Payload.Ended && f.Payload.MessageID == poll {
				c := f
				end = &c
			}
		}
		if end == nil {
			t.Fatalf("round %d: no end update among %+v", i, aliceFrames)
		}
		rows := countPollRows(t, h, fmt.Sprintf(`SELECT COUNT(*) FROM poll_votes WHERE message_id = %d`, poll))
		switch {
		case firstPollFrame(bobFrames, "poll_vote_ok") != nil:
			counted++
			if rows != 1 || end.Payload.TotalVoters != 1 || end.Payload.Counts[0].Count != 1 {
				t.Fatalf("round %d: vote acknowledged but rows=%d end=%+v", i, rows, end.Payload)
			}
		case func() bool {
			e := firstPollFrame(bobFrames, "error")
			return e != nil && e.Payload.Code == "POLL_ENDED"
		}():
			refused++
			if rows != 0 || end.Payload.TotalVoters != 0 {
				t.Fatalf("round %d: vote refused but rows=%d end=%+v", i, rows, end.Payload)
			}
		default:
			t.Fatalf("round %d: bob's frames = %+v, want poll_vote_ok or POLL_ENDED", i, bobFrames)
		}
	}
	t.Logf("vote racing end: %d counted, %d refused", counted, refused)
}

// The expirer's notifier is the hub: a poll that ran out is announced as a
// sequenced, replayable update, and a DM poll goes to its participants.
func TestPollExpirer_AnnouncesThroughTheHub(t *testing.T) {
	t.Parallel()
	h := newForwardHarness(t)
	h.focus(h.aliceCl, h.dstChan)
	chanPoll := h.rawPoll(t, h.dstChan, false)
	dmPoll := h.rawPoll(t, h.dmChan, false)
	h.vote(h.bobCl, "req-pre", chanPoll, 1)
	drainChanTimeout(h.aliceFrames, 100*time.Millisecond)
	drainChanTimeout(h.bobFr, 100*time.Millisecond)
	if _, err := h.database.ExecContext(context.Background(),
		`UPDATE polls SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 second')`); err != nil {
		t.Fatal(err)
	}

	e := service.NewPollExpirer(h.database, h.svc.Messages)
	e.SetNotifier(h.hub)
	if err := e.Sweep(context.Background()); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	var seen = map[int64]pollFrame{}
	for _, f := range collectPollFrames(h.bobFr, 300*time.Millisecond) {
		if f.Type == "poll_update" {
			seen[f.Payload.MessageID] = f
		}
	}
	ch, ok := seen[chanPoll]
	if !ok || !ch.Payload.Ended || ch.Payload.EndedAt == nil || ch.Seq == 0 || ch.Payload.TotalVoters != 1 || ch.Payload.Version != 2 {
		t.Fatalf("channel poll end = %+v (seen %+v)", ch, seen)
	}
	dm, ok := seen[dmPoll]
	if !ok || !dm.Payload.Ended || dm.Payload.ChannelID != h.dmChan || dm.Seq == 0 {
		t.Fatalf("DM poll end = %+v", dm)
	}
	if !replayHas(h.hub, `"type":"poll_update"`, `"ended":true`, fmt.Sprintf(`"message_id":%d`, chanPoll)) {
		t.Error("the end is not in the replay buffer")
	}
}

// The whole poll life as a client that was away sees it: after a gap the
// replayed frames carry full counts and versions, so replay order is
// irrelevant and the highest version is the state.
func TestPollUpdate_ReplayAfterGap(t *testing.T) {
	h := newForwardHarness(t)
	h.focus(h.aliceCl, h.dstChan)
	poll := h.rawPoll(t, h.dstChan, true)
	// Two control frames first: the ring serves nothing from its oldest slot.
	control, _ := json.Marshal(map[string]any{"type": "typing", "payload": map[string]any{"channel_id": h.dstChan, "user_id": h.bob.ID}})
	h.hub.BroadcastToChannel(h.dstChan, control)
	h.hub.BroadcastToChannel(h.dstChan, control)
	waitFor(t, waitTimeout, func() bool { return h.hub.CurrentSeqForTest() >= 2 }, "the control frames to be sequenced")
	before := h.hub.CurrentSeqForTest()
	h.vote(h.bobCl, "g1", poll, 1)
	h.vote(h.bobCl, "g2", poll, 1, 2)
	h.endPoll(h.aliceCl, "g3", poll)
	waitFor(t, waitTimeout, func() bool { return h.hub.CurrentSeqForTest() >= before+3 }, "the three updates to be sequenced")

	frames := h.hub.ReplayBuffer().EventsSince(before)
	var versions []int64
	for _, raw := range frames {
		var f pollFrame
		if json.Unmarshal(raw, &f) == nil && f.Type == "poll_update" && f.Payload.MessageID == poll {
			versions = append(versions, f.Payload.Version)
			if f.Payload.Version == 3 && (!f.Payload.Ended || f.Payload.TotalVoters != 1 || f.Payload.Counts[0].Count != 1 || f.Payload.Counts[1].Count != 1) {
				t.Errorf("the final replayed frame is not a complete state: %+v", f.Payload)
			}
		}
	}
	if !slices.Equal(versions, []int64{1, 2, 3}) {
		t.Errorf("replayed versions = %v, want [1 2 3]", versions)
	}
}

// A poll_update names a message, so retention and the tombstone drop it with
// the message: the ring-buffer rule and its SQL twin agree on it.
func TestEventNamesMessage_PollUpdateParity(t *testing.T) {
	h := newForwardHarness(t)
	frame := buildPollUpdateFrameForTest(41, 7)
	for _, tc := range []struct {
		ids  []int64
		want bool
	}{{[]int64{41}, true}, {[]int64{42}, false}, {[]int64{1, 41}, true}} {
		encoded, _ := json.Marshal(tc.ids)
		var n int
		if err := h.database.QueryRowContext(context.Background(),
			`SELECT COUNT(*) FROM (SELECT ?2 AS payload) WHERE `+db.EventNamesMessagePredicate, string(encoded), string(frame)).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if sqlHit := n == 1; sqlHit != tc.want {
			t.Errorf("SQL predicate for %v = %v, want %v", tc.ids, sqlHit, tc.want)
		}
		if ringHit := ws.EventNamesMessageForTest(frame, setOf(tc.ids...)); ringHit != tc.want {
			t.Errorf("ring predicate for %v = %v, want %v", tc.ids, ringHit, tc.want)
		}
	}
}

func buildPollUpdateFrameForTest(messageID, userID int64) []byte {
	b, _ := json.Marshal(map[string]any{"type": "poll_update", "seq": 9, "payload": map[string]any{
		"channel_id": 3, "message_id": messageID, "version": 1, "user_id": userID, "answer_ids": []int{1},
	}})
	return b
}
