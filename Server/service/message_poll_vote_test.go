package service

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

const (
	fwdDave   = int64(4)  // a moderator: MANAGE_MESSAGES
	pollModID = int64(30) // the moderator role
	fwdNews   = int64(40) // an announcement channel members can read and react in
)

func (f *forwardFixture) vote(user, msg int64, ids ...int64) (*PollVoteResult, error) {
	return f.svc.VotePoll(context.Background(), user, msg, ids)
}

func (f *forwardFixture) end(user, msg int64) (*PollUpdate, error) {
	return f.svc.EndPoll(context.Background(), user, msg)
}

// moderator makes dave a member who may also manage messages.
func (f *forwardFixture) moderator(t *testing.T) {
	t.Helper()
	seedRole(t, f.database, &db.Role{
		ID: pollModID, Name: "poll-mod", Position: 5,
		Permissions: permissions.ReadMessages | permissions.SendMessages | permissions.ManageMessages | permissions.AddReactions,
	})
	seedUser(t, f.database, &db.User{ID: fwdDave, Username: "dave"})
	seedUserRole(t, f.database, fwdDave, pollModID)
	f.perms.InvalidateAll()
}

// rawPoll writes a poll message straight to the tables, in any channel, so a
// gate can be tested in a channel the author could not post in.
func (f *forwardFixture) rawPoll(t *testing.T, channel, author int64, multi bool) int64 {
	t.Helper()
	ctx := context.Background()
	id, err := f.database.CreateMessage(ctx, channel, author, "📊 raw\n- a\n- b", nil)
	if err != nil {
		t.Fatal(err)
	}
	m := 0
	if multi {
		m = 1
	}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO polls (message_id, question, allow_multiselect, expires_at) VALUES (?, 'raw', ?, '2999-01-01T00:00:00Z')`, []any{id, m}},
		{`INSERT INTO poll_answers (message_id, answer_id, text) VALUES (?, 1, 'a'), (?, 2, 'b')`, []any{id, id}},
	} {
		if _, err := f.database.ExecContext(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func (f *forwardFixture) expire(t *testing.T, id int64) {
	t.Helper()
	if _, err := f.database.ExecContext(context.Background(),
		`UPDATE polls SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 second') WHERE message_id = ?`, id); err != nil {
		t.Fatal(err)
	}
}

func countFor(u *PollUpdate, answer int64) int64 {
	for _, c := range u.Counts {
		if c.AnswerID == answer {
			return c.Count
		}
	}
	return -1
}

func TestVotePoll_ReplaceSetAndRemove(t *testing.T) {
	f := newForwardFixture(t, nil)
	poll := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))

	r, err := f.vote(fwdCarol, poll.MessageID, 1)
	if err != nil {
		t.Fatalf("vote: %v", err)
	}
	u := r.Update
	if u == nil || u.MessageID != poll.MessageID || u.ChannelID != fwdDstChan || u.Version != 1 || r.Version != 1 ||
		u.TotalVoters != 1 || countFor(u, 1) != 1 || countFor(u, 2) != 0 || u.Ended || u.EndedAt != nil ||
		u.UserID != fwdCarol || !slices.Equal(u.AnswerIDs, []int64{1}) || u.IsDM || len(u.ParticipantIDs) != 0 {
		t.Fatalf("vote update = %+v (result %+v)", u, r)
	}
	if !slices.Equal(r.AnswerIDs, []int64{1}) || r.MessageID != poll.MessageID {
		t.Errorf("vote result = %+v", r)
	}

	// Re-vote replaces.
	r, err = f.vote(fwdCarol, poll.MessageID, 2)
	if err != nil || r.Update == nil || countFor(r.Update, 1) != 0 || countFor(r.Update, 2) != 1 || r.Version != 2 {
		t.Fatalf("re-vote = %+v, %v", r, err)
	}
	// Empty removes, and the update still names the voter and an empty set.
	r, err = f.vote(fwdCarol, poll.MessageID)
	if err != nil || r.Update == nil || r.Update.TotalVoters != 0 || r.Update.AnswerIDs == nil || len(r.Update.AnswerIDs) != 0 || r.Update.UserID != fwdCarol {
		t.Fatalf("remove = %+v, %v", r, err)
	}
	// A retry of the same set is a no-op: acknowledged with the current version, nothing to emit.
	again, err := f.vote(fwdCarol, poll.MessageID)
	if err != nil || again.Update != nil || again.Version != 3 || len(again.AnswerIDs) != 0 {
		t.Fatalf("retry = %+v, %v", again, err)
	}
}

func TestVotePoll_MultiVersusSingle(t *testing.T) {
	f := newForwardFixture(t, nil)
	single := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.vote(fwdCarol, single.MessageID, 1, 2); !errors.Is(err, ErrBadRequest) || errors.Is(err, ErrPollEnded) {
		t.Fatalf("two answers on a single-choice poll: err = %v, want a plain bad request", err)
	}
	mp := f.pollParams(fwdBob, fwdDstChan)
	mp.AllowMultiselect = true
	multi := mustCreatePoll(t, f, mp)
	r, err := f.vote(fwdCarol, multi.MessageID, 1, 2)
	if err != nil || r.Update.TotalVoters != 1 || countFor(r.Update, 1) != 1 || countFor(r.Update, 2) != 1 {
		t.Fatalf("multi vote = %+v, %v", r, err)
	}
	for name, ids := range map[string][]int64{"unknown": {3}, "zero": {0}, "negative": {-2}, "duplicate": {1, 1}} {
		if _, err := f.vote(fwdCarol, multi.MessageID, ids...); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", name, err)
		}
	}
	tooMany := make([]int64, maxPollAnswers+1)
	for i := range tooMany {
		tooMany[i] = int64(i + 1)
	}
	if _, err := f.vote(fwdCarol, multi.MessageID, tooMany...); !errors.Is(err, ErrBadRequest) {
		t.Errorf("11 ids: err = %v, want ErrBadRequest", err)
	}
}

func TestVotePoll_EndedAndExpiredAreRefused(t *testing.T) {
	f := newForwardFixture(t, nil)
	poll := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	f.expire(t, poll.MessageID)
	_, err := f.vote(fwdCarol, poll.MessageID, 1)
	if !errors.Is(err, ErrPollEnded) || !errors.Is(err, ErrBadRequest) {
		t.Fatalf("vote after expiry: err = %v, want ErrPollEnded wrapping ErrBadRequest", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM poll_votes`); n != 0 {
		t.Errorf("a vote after expiry wrote %d rows", n)
	}

	other := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.end(fwdBob, other.MessageID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.vote(fwdCarol, other.MessageID, 1); !errors.Is(err, ErrPollEnded) {
		t.Errorf("vote after end: err = %v, want ErrPollEnded", err)
	}
}

func TestVotePoll_DeletedAndUnknownAreNotFound(t *testing.T) {
	f := newForwardFixture(t, nil)
	poll := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.svc.DeleteMessage(context.Background(), fwdBob, poll.MessageID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.vote(fwdCarol, poll.MessageID, 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("vote on a deleted poll: err = %v, want ErrNotFound", err)
	}
	if _, err := f.vote(fwdCarol, 99999, 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown message: err = %v, want ErrNotFound", err)
	}
	plain, err := f.svc.SendMessage(context.Background(), SendMessageParams{ChannelID: fwdDstChan, UserID: fwdBob, Username: "bob", Content: "no poll here"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.vote(fwdCarol, plain.MessageID, 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("a message that is not a poll: err = %v, want ErrNotFound", err)
	}
	if _, err := f.vote(fwdCarol, 0, 1); !errors.Is(err, ErrBadRequest) {
		t.Errorf("message id 0: err = %v, want ErrBadRequest", err)
	}
}

func TestVotePoll_UnreadableIsNotFound(t *testing.T) {
	f := newForwardFixture(t, nil)
	locked := f.rawPoll(t, fwdLockedChan, fwdAlice, false)
	if _, err := f.vote(fwdBob, locked, 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("a channel the voter cannot read: err = %v, want ErrNotFound", err)
	}
	// An unacknowledged labelled channel holds the same answer.
	nsfw := f.rawPoll(t, fwdNSFWSrc, fwdAlice, false)
	if _, err := f.vote(fwdBob, nsfw, 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("an unacknowledged NSFW channel: err = %v, want ErrNotFound", err)
	}
	if _, err := f.database.AcknowledgeNSFW(context.Background(), fwdBob, fwdNSFWSrc); err != nil {
		t.Fatal(err)
	}
	if _, err := f.vote(fwdBob, nsfw, 1); err != nil {
		t.Errorf("after acknowledging: %v", err)
	}
	// The refusal is the answer an unknown id gets, so it leaks nothing.
	_, hidden := f.vote(fwdBob, locked, 1)
	_, unknown := f.vote(fwdBob, 99999, 1)
	if hidden == nil || unknown == nil || hidden.Error() != unknown.Error() {
		t.Errorf("hidden poll answers %q, unknown id answers %q: they must match", hidden, unknown)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM poll_votes WHERE message_id = ?`, locked); n != 0 {
		t.Errorf("an unreadable poll took %d votes", n)
	}
}

func TestVotePoll_AnnouncementMemberCanVote(t *testing.T) {
	f := newForwardFixture(t, nil)
	seedChannel(t, f.database, &db.Channel{ID: fwdNews, Name: "news", Type: "announcement"})
	id := f.rawPoll(t, fwdNews, fwdAlice, false)
	r, err := f.vote(fwdBob, id, 2)
	if err != nil || r.Update == nil || countFor(r.Update, 2) != 1 {
		t.Fatalf("a member's vote in an announcement channel = %+v, %v", r, err)
	}
}

func TestVotePoll_NoAddReactions(t *testing.T) {
	f := newForwardFixture(t, nil)
	seedChannelOverride(t, f.database, permissions.MemberRoleID, fwdDstChan, 0, permissions.AddReactions)
	f.perms.InvalidateAll()
	poll := f.rawPoll(t, fwdDstChan, fwdAlice, false)
	if _, err := f.vote(fwdBob, poll, 1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a voter without ADD_REACTIONS: err = %v, want ErrForbidden", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM poll_votes`); n != 0 {
		t.Errorf("a refused vote wrote %d rows", n)
	}
}

func TestVotePoll_ArchivedBlockedAndTimedOut(t *testing.T) {
	ctx := context.Background()
	f := newForwardFixture(t, nil)
	archived := f.rawPoll(t, fwdArchived, fwdAlice, false)
	if _, err := f.vote(fwdBob, archived, 1); !errors.Is(err, ErrForbidden) {
		t.Errorf("archived channel: err = %v, want ErrForbidden", err)
	}
	dm := f.rawPoll(t, fwdDM, fwdCarol, false)
	if _, err := f.vote(fwdAlice, dm, 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("a DM the voter is not in: err = %v, want ErrNotFound", err)
	}
	seedBlock(t, f.database, fwdCarol, fwdBob)
	if _, err := f.vote(fwdBob, dm, 1); !errors.Is(err, ErrBlocked) {
		t.Errorf("a blocked DM: err = %v, want ErrBlocked", err)
	}

	if _, err := f.database.ExecContext(ctx,
		`INSERT INTO moderation_actions (kind, target_id, expires_at) VALUES ('timeout', ?, '2999-01-01 00:00:00')`, fwdBob); err != nil {
		t.Fatal(err)
	}
	if err := f.perms.RefreshTimeouts(ctx); err != nil {
		t.Fatal(err)
	}
	open := f.rawPoll(t, fwdDstChan, fwdAlice, false)
	if _, err := f.vote(fwdBob, open, 1); !errors.Is(err, ErrTimedOut) {
		t.Errorf("a timed-out voter: err = %v, want ErrTimedOut", err)
	}
}

func TestVotePoll_DMUpdateCarriesTheAudience(t *testing.T) {
	f := newForwardFixture(t, nil)
	dm := f.rawPoll(t, fwdDM, fwdCarol, false)
	r, err := f.vote(fwdBob, dm, 1)
	if err != nil || r.Update == nil || !r.Update.IsDM {
		t.Fatalf("DM vote = %+v, %v", r, err)
	}
	got := slices.Clone(r.Update.ParticipantIDs)
	slices.Sort(got)
	if !slices.Equal(got, []int64{fwdBob, fwdCarol}) {
		t.Errorf("participants = %v, want bob and carol", got)
	}
}

func TestVotePoll_AndEndShareOneLimiter(t *testing.T) {
	f := newForwardFixture(t, auth.NewRateLimiter())
	poll := f.rawPoll(t, fwdDstChan, fwdAlice, false)
	for i := range pollVoteLimit {
		if _, err := f.vote(fwdBob, poll, int64(i%2)+1); err != nil {
			t.Fatalf("vote %d: %v", i, err)
		}
	}
	if _, err := f.vote(fwdBob, poll, 1); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("vote past the limit: err = %v, want ErrRateLimited", err)
	}
	if _, err := f.end(fwdBob, poll); !errors.Is(err, ErrRateLimited) {
		t.Errorf("end by the same user: err = %v, want ErrRateLimited (one shared budget)", err)
	}
	if _, err := f.vote(fwdCarol, poll, 1); err != nil {
		t.Errorf("another user has their own budget: %v", err)
	}
}

func TestEndPoll_AuthorModeratorStranger(t *testing.T) {
	f := newForwardFixture(t, nil)
	f.moderator(t)

	mine := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.end(fwdCarol, mine.MessageID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a stranger ending a poll: err = %v, want ErrForbidden", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM polls WHERE ended_at IS NOT NULL`); n != 0 {
		t.Fatalf("a refused end ended %d polls", n)
	}
	u, err := f.end(fwdBob, mine.MessageID)
	if err != nil || u == nil || !u.Ended || u.EndedAt == nil || u.Version != 1 || u.UserID != 0 || u.AnswerIDs != nil || u.ChannelID != fwdDstChan {
		t.Fatalf("author ends = %+v, %v", u, err)
	}
	if _, err := f.end(fwdBob, mine.MessageID); !errors.Is(err, ErrPollEnded) || !errors.Is(err, ErrBadRequest) {
		t.Errorf("a second end: err = %v, want ErrPollEnded", err)
	}

	theirs := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.end(fwdDave, theirs.MessageID); err != nil {
		t.Errorf("a moderator ending another member's poll: %v", err)
	}
	if _, err := f.end(fwdBob, 99999); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown poll: err = %v, want ErrNotFound", err)
	}
	locked := f.rawPoll(t, fwdLockedChan, fwdAlice, false)
	if _, err := f.end(fwdBob, locked); !errors.Is(err, ErrNotFound) {
		t.Errorf("an unreadable poll: err = %v, want ErrNotFound", err)
	}
	arch := f.rawPoll(t, fwdArchived, fwdBob, false)
	if _, err := f.end(fwdBob, arch); !errors.Is(err, ErrForbidden) {
		t.Errorf("ending in an archived channel: err = %v, want ErrForbidden", err)
	}
	plain, err := f.svc.SendMessage(context.Background(), SendMessageParams{ChannelID: fwdDstChan, UserID: fwdBob, Username: "bob", Content: "plain"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.end(fwdBob, plain.MessageID); !errors.Is(err, ErrNotFound) {
		t.Errorf("ending a message that is not a poll: err = %v, want ErrNotFound", err)
	}
}

func TestEndPoll_TimedOutAuthorMayEnd(t *testing.T) {
	ctx := context.Background()
	f := newForwardFixture(t, nil)
	poll := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.database.ExecContext(ctx,
		`INSERT INTO moderation_actions (kind, target_id, expires_at) VALUES ('timeout', ?, '2999-01-01 00:00:00')`, fwdBob); err != nil {
		t.Fatal(err)
	}
	if err := f.perms.RefreshTimeouts(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := f.end(fwdBob, poll.MessageID); err != nil {
		t.Errorf("a timed-out author ending their own poll, as they may delete it: %v", err)
	}
}

func TestEndPoll_DMNeedsTheAuthor(t *testing.T) {
	f := newForwardFixture(t, nil)
	dm := f.rawPoll(t, fwdDM, fwdBob, false)
	if _, err := f.end(fwdCarol, dm); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a DM member who is not the author: err = %v, want ErrForbidden", err)
	}
	u, err := f.end(fwdBob, dm)
	if err != nil || !u.IsDM {
		t.Fatalf("the author ending a DM poll = %+v, %v", u, err)
	}
	got := slices.Clone(u.ParticipantIDs)
	slices.Sort(got)
	if !slices.Equal(got, []int64{fwdBob, fwdCarol}) {
		t.Errorf("participants = %v", got)
	}
	// An outsider cannot even see it.
	other := f.rawPoll(t, fwdDM, fwdBob, false)
	if _, err := f.end(fwdAlice, other); !errors.Is(err, ErrNotFound) {
		t.Errorf("a non-member of the DM: err = %v, want ErrNotFound", err)
	}
}

func TestEndPoll_CountsIncludeEarlierVotes(t *testing.T) {
	f := newForwardFixture(t, nil)
	poll := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	for _, u := range []int64{fwdAlice, fwdCarol} {
		if _, err := f.vote(u, poll.MessageID, 2); err != nil {
			t.Fatal(err)
		}
	}
	u, err := f.end(fwdBob, poll.MessageID)
	if err != nil || u.TotalVoters != 2 || countFor(u, 2) != 2 || u.Version != 3 {
		t.Fatalf("end = %+v, %v", u, err)
	}
}

func TestExpirePoll(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	poll := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.vote(fwdCarol, poll.MessageID, 1); err != nil {
		t.Fatal(err)
	}
	f.expire(t, poll.MessageID)
	u, err := f.svc.ExpirePoll(ctx, poll.MessageID)
	if err != nil || u == nil || !u.Ended || u.TotalVoters != 1 || countFor(u, 1) != 1 || u.UserID != 0 {
		t.Fatalf("ExpirePoll = %+v, %v", u, err)
	}
	// Already ended: nothing to announce, and no error.
	if u, err := f.svc.ExpirePoll(ctx, poll.MessageID); err != nil || u != nil {
		t.Errorf("second ExpirePoll = %+v, %v, want nil, nil", u, err)
	}
	// Unknown: the same.
	if u, err := f.svc.ExpirePoll(ctx, 99999); err != nil || u != nil {
		t.Errorf("ExpirePoll(unknown) = %+v, %v, want nil, nil", u, err)
	}
	// Deleted: ended silently, so it leaves the pending set.
	gone := mustCreatePoll(t, f, f.pollParams(fwdBob, fwdDstChan))
	if _, err := f.svc.DeleteMessage(ctx, fwdBob, gone.MessageID); err != nil {
		t.Fatal(err)
	}
	if u, err := f.svc.ExpirePoll(ctx, gone.MessageID); err != nil || u != nil {
		t.Errorf("ExpirePoll(deleted) = %+v, %v, want nil, nil", u, err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM polls WHERE message_id = ? AND ended_at IS NOT NULL`, gone.MessageID); n != 1 {
		t.Errorf("the deleted poll was not marked ended")
	}
	// A DM poll names its audience.
	dm := f.rawPoll(t, fwdDM, fwdBob, false)
	f.expire(t, dm)
	du, err := f.svc.ExpirePoll(ctx, dm)
	if err != nil || du == nil || !du.IsDM || len(du.ParticipantIDs) != 2 {
		t.Errorf("ExpirePoll(DM) = %+v, %v", du, err)
	}
}

func TestCreatePoll_WakesTheExpirer(t *testing.T) {
	f := newForwardFixture(t, nil)
	var mu sync.Mutex
	wakes := 0
	f.svc.SetPollWake(func() { mu.Lock(); wakes++; mu.Unlock() })
	p := f.pollParams(fwdBob, fwdDstChan)
	mustCreatePoll(t, f, p)
	mustCreatePoll(t, f, p) // a retry creates nothing
	if _, err := f.createPoll(func() PollCreateParams { q := p; q.Question = ""; return q }()); err == nil {
		t.Fatal("a refused poll was accepted")
	}
	mu.Lock()
	defer mu.Unlock()
	if wakes != 1 {
		t.Errorf("wakes = %d, want exactly one for the one poll created", wakes)
	}
}

func TestVotePoll_ErasingVoterIsRefused(t *testing.T) {
	f := newForwardFixture(t, nil)
	poll := f.rawPoll(t, fwdDstChan, fwdAlice, false)
	if _, err := f.database.ExecContext(context.Background(), `INSERT INTO erasure_jobs (user_id, state) VALUES (?, 'queued')`, fwdBob); err != nil {
		t.Fatal(err)
	}
	if _, err := f.vote(fwdBob, poll, 1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("an erasing voter: err = %v, want ErrForbidden", err)
	}
}
