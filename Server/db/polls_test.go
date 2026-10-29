package db_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

var pollSeq int

type pollFixture struct {
	database *db.DB
	author   int64
	viewer   int64
	channel  int64
}

func newPollFixture(t *testing.T) pollFixture {
	t.Helper()
	database := openMigratedMemory(t)
	return pollFixture{
		database: database,
		author:   seedUser(t, database, "poll-author"),
		viewer:   seedUser(t, database, "poll-viewer"),
		channel:  seedChannel(t, database, "polls"),
	}
}

func pizzaPoll() *db.PollInput {
	sushi := "🍣"
	return &db.PollInput{
		Question:      "Lunch?",
		DurationHours: 24,
		Answers:       []db.PollAnswerInput{{Text: "Pizza"}, {Text: "Sushi", Emoji: &sushi}},
	}
}

func (f pollFixture) params(poll *db.PollInput) db.MessageDeliveryParams {
	pollSeq++
	hash := sha256.Sum256([]byte(fmt.Sprintf("poll %d", pollSeq)))
	return db.MessageDeliveryParams{
		UserID: f.author, ChannelID: f.channel, ClientMessageID: fmt.Sprintf("poll-%d", pollSeq),
		PayloadHash: hash[:], Content: "📊 Lunch?\n- Pizza\n- 🍣 Sushi",
		ExpiresAtMS: time.Now().Add(time.Hour).UnixMilli(),
		Poll:        poll,
	}
}

func (f pollFixture) create(t *testing.T, poll *db.PollInput) int64 {
	t.Helper()
	saved, err := f.database.CreateMessageDelivery(context.Background(), f.params(poll))
	if err != nil {
		t.Fatalf("CreateMessageDelivery: %v", err)
	}
	return saved.Message.ID
}

func (f pollFixture) count(t *testing.T, q string, args ...any) int {
	t.Helper()
	var n int
	if err := f.database.QueryRowContext(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return n
}

func (f pollFixture) exec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := f.database.ExecContext(context.Background(), q, args...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

func (f pollFixture) history(t *testing.T, viewer int64) []db.MessageAPIResponse {
	t.Helper()
	msgs, err := f.database.GetMessagesForAPI(context.Background(), f.channel, 0, 50, viewer)
	if err != nil {
		t.Fatalf("GetMessagesForAPI: %v", err)
	}
	return msgs
}

func TestCreateMessageDelivery_PollAtomic(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()

	// An injected failure on the last write rolls back the message, the poll
	// rows and the receipt together.
	f.exec(t, `CREATE TRIGGER inject_poll_failure BEFORE INSERT ON poll_answers
	           WHEN NEW.answer_id = 2 BEGIN SELECT RAISE(ABORT, 'injected'); END`)
	if _, err := f.database.CreateMessageDelivery(ctx, f.params(pizzaPoll())); err == nil {
		t.Fatal("injected failure did not fail the create")
	}
	for _, q := range []string{
		`SELECT COUNT(*) FROM messages`,
		`SELECT COUNT(*) FROM polls`,
		`SELECT COUNT(*) FROM poll_answers`,
		`SELECT COUNT(*) FROM message_delivery_receipts`,
	} {
		if n := f.count(t, q); n != 0 {
			t.Errorf("%s = %d after a failed create, want 0", q, n)
		}
	}
	f.exec(t, `DROP TRIGGER inject_poll_failure`)

	p := f.params(pizzaPoll())
	saved, err := f.database.CreateMessageDelivery(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	id := saved.Message.ID
	meta, err := f.database.GetPollMeta(ctx, id)
	if err != nil || meta == nil {
		t.Fatalf("GetPollMeta = %v, %v", meta, err)
	}
	if meta.Question != "Lunch?" || meta.AllowMultiselect || meta.EndedAt != nil || meta.Version != 0 {
		t.Errorf("meta = %+v", meta)
	}
	// expires_at is the message's own timestamp plus the duration, written in
	// the layout the lazy expiry rule compares against.
	created, err := time.Parse("2006-01-02 15:04:05", saved.Message.Timestamp)
	if err != nil {
		t.Fatalf("message timestamp %q: %v", saved.Message.Timestamp, err)
	}
	want := created.Add(24 * time.Hour).Format(dbtime.ISOLayout)
	if meta.ExpiresAt != want {
		t.Errorf("expires_at = %q, want %q", meta.ExpiresAt, want)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM poll_answers WHERE message_id = ?`, id); n != 2 {
		t.Errorf("poll_answers = %d, want 2", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_mentions WHERE message_id = ?`, id); n != 0 {
		t.Errorf("a poll wrote %d mention rows", n)
	}
	// A retry is answered from the receipt: no second poll.
	retry, err := f.database.CreateMessageDelivery(ctx, p)
	if err != nil || !retry.Duplicate || retry.Message.ID != id {
		t.Fatalf("retry = %+v, %v", retry, err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM polls`); n != 1 {
		t.Errorf("polls = %d, want 1", n)
	}
	if other, err := f.database.GetPollMeta(ctx, id+1000); err != nil || other != nil {
		t.Errorf("GetPollMeta(unknown) = %v, %v, want nil, nil", other, err)
	}
}

func TestCreateMessageDelivery_PollRefusedWhileErasing(t *testing.T) {
	f := newPollFixture(t)
	f.exec(t, `INSERT INTO erasure_jobs (user_id, state) VALUES (?, 'queued')`, f.author)
	if _, err := f.database.CreateMessageDelivery(context.Background(), f.params(pizzaPoll())); !errors.Is(err, db.ErrAccountErasing) {
		t.Fatalf("err = %v, want ErrAccountErasing", err)
	}
}

func TestAttachPolls_HistoryBlockAndMe(t *testing.T) {
	f := newPollFixture(t)
	input := pizzaPoll()
	input.AllowMultiselect = true
	id := f.create(t, input)
	// Votes are written by 6.9b-b. The history read must already report them.
	f.exec(t, `INSERT INTO poll_votes (message_id, answer_id, user_id) VALUES (?, 1, ?), (?, 2, ?), (?, 2, ?)`,
		id, f.viewer, id, f.viewer, id, f.author)

	for _, tc := range []struct {
		name   string
		viewer int64
		me     []int64
	}{{"viewer", f.viewer, []int64{1, 2}}, {"author", f.author, []int64{2}}, {"nobody", 0, []int64{}}} {
		msgs := f.history(t, tc.viewer)
		if len(msgs) != 1 || msgs[0].Poll == nil {
			t.Fatalf("%s: history = %+v", tc.name, msgs)
		}
		p := msgs[0].Poll
		if p.Question != "Lunch?" || !p.AllowMultiselect || p.Ended || p.EndedAt != nil {
			t.Errorf("%s: poll = %+v", tc.name, p)
		}
		if len(p.Answers) != 2 || p.Answers[0].AnswerID != 1 || p.Answers[0].Text != "Pizza" || p.Answers[0].Emoji != nil ||
			p.Answers[1].AnswerID != 2 || p.Answers[1].Emoji == nil || *p.Answers[1].Emoji != "🍣" {
			t.Errorf("%s: answers = %+v", tc.name, p.Answers)
		}
		r := p.Results
		if r.TotalVoters != 2 || len(r.Counts) != 2 || r.Counts[0].Count != 1 || r.Counts[1].Count != 2 {
			t.Errorf("%s: results = %+v", tc.name, r)
		}
		if fmt.Sprint(r.Me) != fmt.Sprint(tc.me) || r.Me == nil {
			t.Errorf("%s: me = %#v, want %v", tc.name, r.Me, tc.me)
		}
	}
}

func TestAttachPolls_ZeroVotesAndOrdinaryRows(t *testing.T) {
	f := newPollFixture(t)
	if _, err := f.database.CreateMessage(context.Background(), f.channel, f.author, "plain", nil); err != nil {
		t.Fatal(err)
	}
	f.create(t, pizzaPoll())
	var plain, poll *db.MessageAPIResponse
	msgs := f.history(t, f.viewer)
	for i := range msgs {
		if msgs[i].Content == "plain" {
			plain = &msgs[i]
		} else {
			poll = &msgs[i]
		}
	}
	if plain == nil || plain.Poll != nil {
		t.Errorf("ordinary message carries a poll block: %+v", plain)
	}
	if poll == nil || poll.Poll == nil {
		t.Fatal("poll message has no block")
	}
	r := poll.Poll.Results
	if r.TotalVoters != 0 || r.Version != 0 || len(r.Counts) != 2 || r.Counts[0].Count != 0 || r.Counts[1].Count != 0 || len(r.Me) != 0 {
		t.Errorf("zero-vote results = %+v", r)
	}
}

func TestAttachPolls_ExpiredReadsEnded(t *testing.T) {
	f := newPollFixture(t)
	id := f.create(t, pizzaPoll())
	// Expired by the clock, though nothing has marked it ended.
	f.exec(t, `UPDATE polls SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minute') WHERE message_id = ?`, id)
	p := f.history(t, f.viewer)[0].Poll
	if !p.Ended || p.EndedAt != nil {
		t.Errorf("expired poll: ended=%v ended_at=%v, want ended with no ended_at", p.Ended, p.EndedAt)
	}
	// Not yet expired and not ended.
	f.exec(t, `UPDATE polls SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 minute') WHERE message_id = ?`, id)
	if f.history(t, f.viewer)[0].Poll.Ended {
		t.Error("an open poll reads as ended")
	}
	// Ended explicitly.
	f.exec(t, `UPDATE polls SET ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE message_id = ?`, id)
	p = f.history(t, f.viewer)[0].Poll
	if !p.Ended || p.EndedAt == nil {
		t.Errorf("ended poll: %+v", p)
	}
}

func TestGetPollInfo_NewPollIsEmpty(t *testing.T) {
	f := newPollFixture(t)
	id := f.create(t, pizzaPoll())
	info, err := f.database.GetPollInfo(context.Background(), id, 0)
	if err != nil || info == nil {
		t.Fatalf("GetPollInfo = %v, %v", info, err)
	}
	if info.Ended || info.Results.TotalVoters != 0 || len(info.Results.Counts) != 2 || info.Results.Me == nil {
		t.Errorf("info = %+v", info)
	}
	if none, err := f.database.GetPollInfo(context.Background(), id+1000, 0); err != nil || none != nil {
		t.Errorf("GetPollInfo(unknown) = %v, %v, want nil, nil", none, err)
	}
}

func TestEditMessageContent_RefusesPoll(t *testing.T) {
	f := newPollFixture(t)
	id := f.create(t, pizzaPoll())
	if _, err := f.database.EditMessage(context.Background(), id, f.author, "changed"); err == nil {
		t.Fatal("editing a poll message succeeded")
	}
	msg, err := f.database.GetMessage(context.Background(), id)
	if err != nil || msg == nil || !strings.HasPrefix(msg.Content, "📊") || msg.EditedAt != nil {
		t.Errorf("poll message after refused edit = %+v, %v", msg, err)
	}
}

func TestPollCascade_ChannelDeleteAndPurge(t *testing.T) {
	f := newPollFixture(t)
	other := seedChannel(t, f.database, "other-polls")
	id := f.create(t, pizzaPoll())
	f.exec(t, `INSERT INTO poll_votes (message_id, answer_id, user_id) VALUES (?, 1, ?)`, id, f.viewer)

	// A hard delete of the message removes every side row.
	f.exec(t, `DELETE FROM messages WHERE id = ?`, id)
	for _, table := range []string{"polls", "poll_answers", "poll_votes"} {
		if n := f.count(t, `SELECT COUNT(*) FROM `+table); n != 0 {
			t.Errorf("%s holds %d rows after the message went", table, n)
		}
	}

	// So does deleting the channel.
	f.channel = other
	id = f.create(t, pizzaPoll())
	f.exec(t, `INSERT INTO poll_votes (message_id, answer_id, user_id) VALUES (?, 2, ?)`, id, f.viewer)
	if err := f.database.DeleteChannel(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"polls", "poll_answers", "poll_votes"} {
		if n := f.count(t, `SELECT COUNT(*) FROM `+table); n != 0 {
			t.Errorf("%s holds %d rows after the channel went", table, n)
		}
	}
}

func TestPollAnswerBounds(t *testing.T) {
	f := newPollFixture(t)
	in := pizzaPoll()
	in.Answers = nil
	for i := range 11 {
		in.Answers = append(in.Answers, db.PollAnswerInput{Text: fmt.Sprintf("a%d", i)})
	}
	if _, err := f.database.CreateMessageDelivery(context.Background(), f.params(in)); err == nil {
		t.Fatal("an eleventh answer was stored")
	}
	if n := f.count(t, `SELECT COUNT(*) FROM messages`); n != 0 {
		t.Errorf("messages = %d after a refused poll, want 0", n)
	}
}

func TestErasure_PollVotes(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()
	id := f.create(t, pizzaPoll())
	f.exec(t, `INSERT INTO poll_votes (message_id, answer_id, user_id) VALUES (?, 1, ?), (?, 2, ?)`,
		id, f.viewer, id, f.author)

	before, err := f.database.TakeInventory(ctx, f.viewer, "poll-viewer")
	if err != nil {
		t.Fatal(err)
	}
	if before["10a poll votes"] != 1 {
		t.Fatalf("inventory 10a before = %d, want 1", before["10a poll votes"])
	}
	if _, err := f.database.EraseAccount(ctx, f.viewer, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	after, err := f.database.TakeInventory(ctx, f.viewer, "poll-viewer")
	if err != nil {
		t.Fatal(err)
	}
	if after["10a poll votes"] != 0 {
		t.Errorf("inventory 10a after = %d, want 0", after["10a poll votes"])
	}
	if n := f.count(t, `SELECT COUNT(*) FROM poll_votes WHERE user_id = ?`, f.author); n != 1 {
		t.Errorf("another voter's rows = %d, want 1 kept", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM polls`); n != 1 {
		t.Errorf("the poll itself went with a voter: %d rows", n)
	}

	// Erasing the author takes the poll with its messages.
	if _, err := f.database.EraseAccount(ctx, f.author, ""); err != nil {
		t.Fatalf("EraseAccount(author): %v", err)
	}
	for _, table := range []string{"polls", "poll_answers", "poll_votes"} {
		if n := f.count(t, `SELECT COUNT(*) FROM `+table); n != 0 {
			t.Errorf("%s holds %d rows after the author was erased", table, n)
		}
	}
}
