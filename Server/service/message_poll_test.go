package service

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

func (f *forwardFixture) pollParams(user int64, channel int64) PollCreateParams {
	return PollCreateParams{
		ClientMessageID: newClientMessageID(), ChannelID: channel, UserID: user, Username: seedUsername(user),
		Question: "Lunch?", Answers: []PollAnswerParam{{Text: "Pizza"}, {Text: "Sushi", Emoji: "🍣"}},
		DurationHours: 24,
	}
}

func (f *forwardFixture) createPoll(p PollCreateParams) (*SendMessageResult, error) {
	return f.svc.CreatePoll(context.Background(), p)
}

func mustCreatePoll(t *testing.T, f *forwardFixture, p PollCreateParams) *SendMessageResult {
	t.Helper()
	res, err := f.createPoll(p)
	if err != nil {
		t.Fatalf("CreatePoll: %v", err)
	}
	return res
}

func TestCreatePoll_StoresFallbackAndBlock(t *testing.T) {
	f := newForwardFixture(t, nil)
	res := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))

	wantContent := "📊 Lunch?\n- Pizza\n- 🍣 Sushi"
	if res.Duplicate || res.IsDM || res.Content != wantContent {
		t.Fatalf("result = %+v", res)
	}
	msg, err := f.database.GetMessage(context.Background(), res.MessageID)
	if err != nil || msg == nil || msg.Content != wantContent || msg.Kind != db.MessageKindUser {
		t.Fatalf("stored message = %+v, %v", msg, err)
	}
	p := res.Poll
	if p == nil || p.Question != "Lunch?" || p.AllowMultiselect || p.Ended || p.EndedAt != nil || p.ExpiresAt == "" {
		t.Fatalf("poll block = %+v", p)
	}
	if len(p.Answers) != 2 || p.Answers[1].AnswerID != 2 || p.Answers[1].Emoji == nil || *p.Answers[1].Emoji != "🍣" || p.Answers[0].Emoji != nil {
		t.Errorf("answers = %+v", p.Answers)
	}
	if p.Results.TotalVoters != 0 || len(p.Results.Counts) != 2 || p.Results.Me == nil || len(p.Results.Me) != 0 {
		t.Errorf("results = %+v", p.Results)
	}
	if len(res.Mentions) != 0 || res.MentionsEveryone {
		t.Errorf("a poll carries mentions: %+v", res)
	}
	// The author's read state moved past their own poll, as for any send.
	if n := f.count(t, `SELECT COUNT(*) FROM polls WHERE message_id = ?`, res.MessageID); n != 1 {
		t.Errorf("polls rows = %d", n)
	}
}

func TestCreatePoll_Multiselect(t *testing.T) {
	f := newForwardFixture(t, nil)
	p := f.pollParams(fwdBob, fwdDstChan)
	p.AllowMultiselect = true
	res := mustCreatePoll(t, f, p)
	if !res.Poll.AllowMultiselect {
		t.Error("allow_multiselect lost")
	}
}

func TestCreatePoll_CapsTable(t *testing.T) {
	long := func(n int) string { return strings.Repeat("x", n) }
	answers := func(n int) []PollAnswerParam {
		out := make([]PollAnswerParam, n)
		for i := range out {
			out[i] = PollAnswerParam{Text: "a"}
		}
		return out
	}
	tests := []struct {
		name   string
		mutate func(*PollCreateParams)
		ok     bool
	}{
		{"question 1", func(p *PollCreateParams) { p.Question = "?" }, true},
		{"question 300", func(p *PollCreateParams) { p.Question = long(300) }, true},
		{"question 300 multibyte runes", func(p *PollCreateParams) { p.Question = strings.Repeat("é", 300) }, true},
		{"question empty", func(p *PollCreateParams) { p.Question = "" }, false},
		{"question 301", func(p *PollCreateParams) { p.Question = long(301) }, false},
		{"question sanitised to empty", func(p *PollCreateParams) { p.Question = "<script></script>" }, false},
		{"question blank", func(p *PollCreateParams) { p.Question = "   " }, false},
		{"answer blank", func(p *PollCreateParams) { p.Answers[0].Text = " \u00a0 " }, false},
		{"answers 1", func(p *PollCreateParams) { p.Answers = answers(1) }, false},
		{"answers 0", func(p *PollCreateParams) { p.Answers = nil }, false},
		{"answers 2", func(p *PollCreateParams) { p.Answers = answers(2) }, true},
		{"answers 10", func(p *PollCreateParams) { p.Answers = answers(10) }, true},
		{"answers 11", func(p *PollCreateParams) { p.Answers = answers(11) }, false},
		{"duplicate answers allowed", func(p *PollCreateParams) { p.Answers = []PollAnswerParam{{Text: "same"}, {Text: "same"}} }, true},
		{"answer text empty", func(p *PollCreateParams) { p.Answers[0].Text = "" }, false},
		{"answer text 55", func(p *PollCreateParams) { p.Answers[0].Text = long(55) }, true},
		{"answer text 56", func(p *PollCreateParams) { p.Answers[0].Text = long(56) }, false},
		{"answer sanitised to empty", func(p *PollCreateParams) { p.Answers[0].Text = "<b></b>" }, false},
		{"emoji custom shortcode", func(p *PollCreateParams) { p.Answers[0].Emoji = ":party:" }, true},
		{"emoji too long", func(p *PollCreateParams) { p.Answers[0].Emoji = long(80) }, false},
		{"emoji control character", func(p *PollCreateParams) { p.Answers[0].Emoji = "a\x07" }, false},
		{"emoji markup", func(p *PollCreateParams) { p.Answers[0].Emoji = "<b>" }, false},
		{"question newline", func(p *PollCreateParams) { p.Question = "a\nb" }, false},
		{"question control", func(p *PollCreateParams) { p.Question = "a\x00b" }, false},
		{"question trailing newline", func(p *PollCreateParams) { p.Question = "Lunch?\n" }, false},
		{"answer trailing line separator", func(p *PollCreateParams) { p.Answers[0].Text = "a\u2028" }, false},
		{"emoji line separator", func(p *PollCreateParams) { p.Answers[0].Emoji = "\u2028" }, false},
		{"answer line separator", func(p *PollCreateParams) { p.Answers[0].Text = "a\u2028b" }, false},
		{"question paragraph separator", func(p *PollCreateParams) { p.Question = "a\u2029b" }, false},
		{"answer newline", func(p *PollCreateParams) { p.Answers[0].Text = "a\nb" }, false},
		{"answer delete char", func(p *PollCreateParams) { p.Answers[0].Text = "a\x7fb" }, false},
		{"duration 1", func(p *PollCreateParams) { p.DurationHours = 1 }, true},
		{"duration 4", func(p *PollCreateParams) { p.DurationHours = 4 }, true},
		{"duration 8", func(p *PollCreateParams) { p.DurationHours = 8 }, true},
		{"duration 72", func(p *PollCreateParams) { p.DurationHours = 72 }, true},
		{"duration 168", func(p *PollCreateParams) { p.DurationHours = 168 }, true},
		{"duration 0", func(p *PollCreateParams) { p.DurationHours = 0 }, false},
		{"duration 2", func(p *PollCreateParams) { p.DurationHours = 2 }, false},
		{"duration 169", func(p *PollCreateParams) { p.DurationHours = 169 }, false},
		{"duration negative", func(p *PollCreateParams) { p.DurationHours = -24 }, false},
		{"channel id zero", func(p *PollCreateParams) { p.ChannelID = 0 }, false},
		{"no client_message_id", func(p *PollCreateParams) { p.ClientMessageID = "" }, false},
		{"malformed client_message_id", func(p *PollCreateParams) { p.ClientMessageID = "nope" }, false},
		{"huge question is refused before sanitising", func(p *PollCreateParams) { p.Question = long(5000) }, false},
	}
	// One fixture for every case: its setup dominates the run, and each case
	// compares row counts before and after its own call.
	f := newForwardFixture(t, nil)
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := f.pollParams(fwdBob, fwdDstChan)
			tc.mutate(&p)
			pollsBefore := f.count(t, `SELECT COUNT(*) FROM polls`)
			msgsBefore := f.count(t, `SELECT COUNT(*) FROM messages WHERE user_id = ? AND channel_id = ?`, fwdBob, fwdDstChan)
			res, err := f.createPoll(p)
			if tc.ok {
				if err != nil {
					t.Fatalf("err = %v, want success", err)
				}
				return
			}
			if !errors.Is(err, ErrBadRequest) {
				t.Fatalf("res = %+v, err = %v, want ErrBadRequest", res, err)
			}
			if n := f.count(t, `SELECT COUNT(*) FROM polls`) - pollsBefore; n != 0 {
				t.Errorf("a refused poll left %d poll rows", n)
			}
			if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE user_id = ? AND channel_id = ?`, fwdBob, fwdDstChan) - msgsBefore; n != 0 {
				t.Errorf("a refused poll left %d messages", n)
			}
		})
	}
}

func TestCreatePoll_GatesAreSendGates(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		setup   func(t *testing.T, f *forwardFixture) int64
		wantIs  error
		wantReq bool
	}{
		{"no SEND_MESSAGES", func(*testing.T, *forwardFixture) int64 { return fwdNoSendChan }, ErrForbidden, false},
		{"no READ_MESSAGES", func(*testing.T, *forwardFixture) int64 { return fwdLockedChan }, ErrForbidden, false},
		{"archived", func(*testing.T, *forwardFixture) int64 { return fwdArchived }, ErrForbidden, false},
		{"announcement without MANAGE_MESSAGES", func(t *testing.T, f *forwardFixture) int64 {
			seedChannel(t, f.database, &db.Channel{ID: 40, Name: "news", Type: "announcement"})
			return 40
		}, ErrForbidden, false},
		{"no such channel", func(*testing.T, *forwardFixture) int64 { return 9999 }, ErrNotFound, false},
		{"blocked DM", func(t *testing.T, f *forwardFixture) int64 {
			seedBlock(t, f.database, fwdCarol, fwdBob)
			return fwdDM
		}, ErrBlocked, false},
		{"timed out", func(t *testing.T, f *forwardFixture) int64 {
			if _, err := f.database.ExecContext(ctx,
				`INSERT INTO moderation_actions (kind, target_id, expires_at) VALUES ('timeout', ?, '2999-01-01 00:00:00')`, fwdBob); err != nil {
				t.Fatal(err)
			}
			if err := f.perms.RefreshTimeouts(ctx); err != nil {
				t.Fatal(err)
			}
			return fwdDstChan
		}, ErrTimedOut, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newForwardFixture(t, nil)
			ch := tc.setup(t, f)
			if _, err := f.createPoll(f.pollParams(fwdBob, ch)); !errors.Is(err, tc.wantIs) {
				t.Fatalf("err = %v, want %v", err, tc.wantIs)
			}
			for _, table := range []string{"polls", "poll_answers"} {
				if n := f.count(t, `SELECT COUNT(*) FROM `+table); n != 0 {
					t.Errorf("a refused poll left %d %s rows", n, table)
				}
			}
		})
	}
}

func TestCreatePoll_AnnouncementWithManageSucceeds(t *testing.T) {
	f := newForwardFixture(t, nil)
	seedChannel(t, f.database, &db.Channel{ID: 40, Name: "news", Type: "announcement"})
	if _, err := f.database.ExecContext(context.Background(),
		`UPDATE roles SET permissions = permissions | ? WHERE id = ?`, permissions.ManageMessages, permissions.MemberRoleID); err != nil {
		t.Fatal(err)
	}
	f.perms.InvalidateAll()
	if _, err := f.createPoll(f.pollParams(fwdBob, 40)); err != nil {
		t.Fatalf("a moderator's poll in an announcement channel: %v", err)
	}
}

func TestCreatePoll_RetryNoSecondPoll(t *testing.T) {
	f := newForwardFixture(t, nil)
	p := f.pollParams(fwdBob, fwdDstChan)
	first := mustCreatePoll(t, f, p)
	retry := mustCreatePoll(t, f, p)
	if !retry.Duplicate || retry.MessageID != first.MessageID || retry.Poll != nil {
		t.Fatalf("retry = %+v, want a bare duplicate ack of message %d", retry, first.MessageID)
	}
	for _, table := range []string{"polls", "poll_answers"} {
		want := 1
		if table == "poll_answers" {
			want = 2
		}
		if n := f.count(t, `SELECT COUNT(*) FROM `+table); n != want {
			t.Errorf("%s rows = %d, want %d", table, n, want)
		}
	}
	// The same id for other poll input is a conflict, not a second poll.
	changed := p
	changed.Question = "Dinner?"
	if _, err := f.createPoll(changed); !errors.Is(err, ErrConflict) {
		t.Errorf("same id, other question: err = %v, want ErrConflict", err)
	}
	more := p
	more.Answers = append(slices.Clone(p.Answers), PollAnswerParam{Text: "Tacos"})
	if _, err := f.createPoll(more); !errors.Is(err, ErrConflict) {
		t.Errorf("same id, other answers: err = %v, want ErrConflict", err)
	}
	multi := p
	multi.AllowMultiselect = true
	if _, err := f.createPoll(multi); !errors.Is(err, ErrConflict) {
		t.Errorf("same id, other mode: err = %v, want ErrConflict", err)
	}
	// A plain send cannot reuse a poll's id either.
	if _, err := f.svc.SendMessage(context.Background(), SendMessageParams{
		ClientMessageID: p.ClientMessageID, ChannelID: fwdDstChan, UserID: fwdBob, Username: "bob", Content: first.Content,
	}); !errors.Is(err, ErrConflict) {
		t.Errorf("send reusing a poll's id: err = %v, want ErrConflict", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM polls`); n != 1 {
		t.Errorf("polls rows = %d after conflicts, want 1", n)
	}
}

func TestCreatePoll_RetryAfterPermissionLossIsAnswered(t *testing.T) {
	f := newForwardFixture(t, nil)
	p := f.pollParams(fwdBob, fwdDstChan)
	first := mustCreatePoll(t, f, p)
	seedChannelOverride(t, f.database, permissions.MemberRoleID, fwdDstChan, 0, permissions.SendMessages) // lose SEND after the accept
	f.perms.InvalidateAll()
	retry, err := f.createPoll(p)
	if err != nil || !retry.Duplicate || retry.MessageID != first.MessageID {
		t.Fatalf("retry after permission loss = %+v, %v", retry, err)
	}
}

func TestCreatePoll_NoMentionsNoChannelPush(t *testing.T) {
	f := newForwardFixture(t, nil)
	push := &countingPush{}
	f.svc.SetPushNotifier(push)
	p := f.pollParams(fwdBob, fwdDstChan)
	p.Question = "Who is @carol and @everyone?"
	res := mustCreatePoll(t, f, p)
	if len(res.Mentions) != 0 || res.MentionsEveryone || res.MentionsHere {
		t.Errorf("a poll carries mentions: %+v", res)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_mentions WHERE message_id = ?`, res.MessageID); n != 0 {
		t.Errorf("message_mentions rows = %d, want 0", n)
	}
	if _, count, _, err := f.database.GetReadState(context.Background(), fwdCarol, fwdDstChan); err != nil || count != 0 {
		t.Errorf("carol's mention badge = %d, %v", count, err)
	}
	if push.n() != 0 {
		t.Errorf("a channel poll sent %d push dispatches", push.n())
	}
	// A DM poll is pushed to its participants, as any DM message is.
	dm := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDM))
	if !dm.IsDM || push.n() != 1 || len(dm.Mentions) != 0 {
		t.Fatalf("DM poll: IsDM=%v pushes=%d mentions=%v", dm.IsDM, push.n(), dm.Mentions)
	}
}

func TestCreatePoll_UntrustedDMIsStagedAsARequest(t *testing.T) {
	f := newForwardFixture(t, nil)
	f.svc.SetMessageRequests(NewMessageRequestService(f.database, NewBlockService(f.database)))
	res := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDM))
	if len(res.RequestCreatedFor) != 1 || res.RequestCreatedFor[0].RecipientID != fwdCarol {
		t.Fatalf("RequestCreatedFor = %+v, want one request for carol", res.RequestCreatedFor)
	}
	if slices.Contains(res.ParticipantIDs, fwdCarol) {
		t.Errorf("an untrusted recipient is in the live audience: %v", res.ParticipantIDs)
	}
	if res.RequestPreview == nil || res.RequestPreview.MessageID != res.MessageID || !strings.HasPrefix(res.RequestPreview.Content, "📊 Lunch?") {
		t.Errorf("request preview = %+v, want the fallback text", res.RequestPreview)
	}
}

func TestCreatePoll_Limiter(t *testing.T) {
	f := newForwardFixture(t, auth.NewRateLimiter())
	first := f.pollParams(fwdBob, fwdDstChan)
	mustCreatePoll(t, f, first)
	for i := 1; i < pollCreateLimit; i++ {
		mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	}
	if _, err := f.createPoll(f.pollParams(fwdBob, fwdDstChan)); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("poll past the limit: err = %v, want ErrRateLimited", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM polls`); n != pollCreateLimit {
		t.Errorf("polls = %d, want %d", n, pollCreateLimit)
	}
	// A retry of an accepted poll is free: it never reaches the limiter.
	if res, err := f.createPoll(first); err != nil || !res.Duplicate {
		t.Errorf("retry while limited = %+v, %v", res, err)
	}
	// Another user has their own budget.
	if _, err := f.createPoll(f.pollParams(fwdAlice, fwdDstChan)); err != nil {
		t.Errorf("another user's poll: %v", err)
	}
}

func TestForward_PollRefused(t *testing.T) {
	f := newForwardFixture(t, nil)
	poll := mustCreatePoll(t, f, f.pollParams(fwdAlice, fwdSrcChan))
	_, err := f.forward(fwdDstChan, poll.MessageID)
	if !errors.Is(err, ErrBadRequest) || !strings.Contains(err.Error(), "poll") {
		t.Fatalf("forwarding a poll: err = %v, want a bad request naming the poll", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_forwards`); n != 0 {
		t.Errorf("a refused forward left %d side rows", n)
	}
	// The read gate comes first, so the refusal leaks nothing about a poll in
	// a channel the forwarder cannot read.
	hiddenID, err := f.database.CreateMessage(context.Background(), fwdLockedChan, fwdAlice, "secret poll", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.ExecContext(context.Background(),
		`INSERT INTO polls (message_id, question, expires_at) VALUES (?, 'q', '2999-01-01T00:00:00Z')`, hiddenID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.forward(fwdDstChan, hiddenID); !errors.Is(err, ErrNotFound) {
		t.Errorf("forwarding an unreadable poll: err = %v, want ErrNotFound", err)
	}
}

func TestEditMessage_PollRefused(t *testing.T) {
	f := newForwardFixture(t, nil)
	poll := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.svc.EditMessage(context.Background(), fwdBob, poll.MessageID, "rewritten"); err == nil {
		t.Fatal("editing a poll succeeded")
	}
	msg, _ := f.database.GetMessage(context.Background(), poll.MessageID)
	if msg.Content != poll.Content || msg.EditedAt != nil {
		t.Errorf("poll after the refused edit = %+v", msg)
	}
}
