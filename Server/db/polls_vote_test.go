package db_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func (f pollFixture) voter(t *testing.T, name string) int64 {
	t.Helper()
	return seedUser(t, f.database, name)
}

func countOf(t *testing.T, tally db.PollTally, answerID int64) int64 {
	t.Helper()
	for _, c := range tally.Counts {
		if c.AnswerID == answerID {
			return c.Count
		}
	}
	t.Fatalf("answer %d is not in %+v", answerID, tally.Counts)
	return 0
}

func TestSetPollVote_ReplaceSetAndRemove(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()
	id := f.create(t, pizzaPoll())

	r, err := f.database.SetPollVote(ctx, id, f.viewer, []int64{1})
	if err != nil || !r.Changed || r.Version != 1 || r.TotalVoters != 1 || countOf(t, r.PollTally, 1) != 1 || countOf(t, r.PollTally, 2) != 0 {
		t.Fatalf("first vote = %+v, %v", r, err)
	}
	if r.ChannelID != f.channel || r.MessageID != id || r.Ended || r.EndedAt != nil {
		t.Errorf("vote tally identity = %+v", r.PollTally)
	}
	if !slices.Equal(r.AnswerIDs, []int64{1}) {
		t.Errorf("answer ids = %v", r.AnswerIDs)
	}

	// A re-vote replaces the selection, it does not add to it.
	r, err = f.database.SetPollVote(ctx, id, f.viewer, []int64{2})
	if err != nil || !r.Changed || r.Version != 2 || r.TotalVoters != 1 || countOf(t, r.PollTally, 1) != 0 || countOf(t, r.PollTally, 2) != 1 {
		t.Fatalf("re-vote = %+v, %v", r, err)
	}
	if mine := f.history(t, f.viewer)[0].Poll.Results.Me; !slices.Equal(mine, []int64{2}) {
		t.Errorf("history me = %v, want [2]", mine)
	}

	// An empty selection removes the vote.
	r, err = f.database.SetPollVote(ctx, id, f.viewer, []int64{})
	if err != nil || !r.Changed || r.Version != 3 || r.TotalVoters != 0 || countOf(t, r.PollTally, 2) != 0 {
		t.Fatalf("remove = %+v, %v", r, err)
	}
	if len(r.AnswerIDs) != 0 || r.AnswerIDs == nil {
		t.Errorf("answer ids after removal = %#v, want an empty list", r.AnswerIDs)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM poll_votes WHERE message_id = ?`, id); n != 0 {
		t.Errorf("vote rows = %d after removal", n)
	}
	// Removing when there is nothing to remove changes nothing.
	r, err = f.database.SetPollVote(ctx, id, f.viewer, nil)
	if err != nil || r.Changed || r.Version != 3 {
		t.Errorf("remove of nothing = %+v, %v", r, err)
	}
}

func TestSetPollVote_MultiVersusSingleChoice(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()
	single := f.create(t, pizzaPoll())
	multi := pizzaPoll()
	multi.AllowMultiselect = true
	multiID := f.create(t, multi)

	if _, err := f.database.SetPollVote(ctx, single, f.viewer, []int64{1, 2}); !errors.Is(err, db.ErrPollAnswerInvalid) {
		t.Fatalf("two answers on a single-choice poll: err = %v, want ErrPollAnswerInvalid", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM poll_votes WHERE message_id = ?`, single); n != 0 {
		t.Errorf("a refused vote left %d rows", n)
	}
	if v := f.version(t, single); v != 0 {
		t.Errorf("a refused vote moved the version to %d", v)
	}

	r, err := f.database.SetPollVote(ctx, multiID, f.viewer, []int64{2, 1})
	if err != nil || !r.Changed || r.TotalVoters != 1 || countOf(t, r.PollTally, 1) != 1 || countOf(t, r.PollTally, 2) != 1 {
		t.Fatalf("multi vote = %+v, %v", r, err)
	}
	if !slices.Equal(r.AnswerIDs, []int64{1, 2}) {
		t.Errorf("answer ids = %v, want them sorted", r.AnswerIDs)
	}
	// The same set in another order is no change.
	if again, err := f.database.SetPollVote(ctx, multiID, f.viewer, []int64{1, 2}); err != nil || again.Changed || again.Version != r.Version {
		t.Errorf("same set = %+v, %v", again, err)
	}
	// Total voters counts people, not rows.
	other := f.voter(t, "second-voter")
	r, err = f.database.SetPollVote(ctx, multiID, other, []int64{1})
	if err != nil || r.TotalVoters != 2 || countOf(t, r.PollTally, 1) != 2 {
		t.Errorf("second voter = %+v, %v", r, err)
	}
}

func (f pollFixture) version(t *testing.T, id int64) int64 {
	t.Helper()
	return int64(f.count(t, `SELECT version FROM polls WHERE message_id = ?`, id))
}

func TestSetPollVote_RefusesBadAnswerIDs(t *testing.T) {
	f := newPollFixture(t)
	multi := pizzaPoll()
	multi.AllowMultiselect = true
	id := f.create(t, multi)
	for name, ids := range map[string][]int64{
		"unknown answer": {3},
		"zero":           {0},
		"negative":       {-1},
		"duplicate":      {1, 1},
		"one unknown":    {1, 9},
	} {
		if _, err := f.database.SetPollVote(context.Background(), id, f.viewer, ids); !errors.Is(err, db.ErrPollAnswerInvalid) {
			t.Errorf("%s: err = %v, want ErrPollAnswerInvalid", name, err)
		}
	}
	if n := f.count(t, `SELECT COUNT(*) FROM poll_votes`); n != 0 || f.version(t, id) != 0 {
		t.Errorf("refused votes left rows (%d) or moved the version", n)
	}
}

func TestSetPollVote_UnchangedIsNoop(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()
	id := f.create(t, pizzaPoll())
	first, err := f.database.SetPollVote(ctx, id, f.viewer, []int64{2})
	if err != nil || !first.Changed {
		t.Fatalf("first = %+v, %v", first, err)
	}
	again, err := f.database.SetPollVote(ctx, id, f.viewer, []int64{2})
	if err != nil || again.Changed || again.Version != first.Version || again.TotalVoters != 1 || countOf(t, again.PollTally, 2) != 1 {
		t.Fatalf("retry = %+v, %v", again, err)
	}
	if v := f.version(t, id); v != first.Version {
		t.Errorf("a retry moved the version to %d", v)
	}
}

func TestSetPollVote_RefusedAfterExpiryBeforeSweep(t *testing.T) {
	f := newPollFixture(t)
	id := f.create(t, pizzaPoll())
	// Expired by the clock, though nothing has marked it ended.
	f.exec(t, `UPDATE polls SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 second') WHERE message_id = ?`, id)
	if _, err := f.database.SetPollVote(context.Background(), id, f.viewer, []int64{1}); !errors.Is(err, db.ErrPollEnded) {
		t.Fatalf("err = %v, want ErrPollEnded", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM poll_votes`); n != 0 {
		t.Errorf("a vote after expiry wrote %d rows", n)
	}
	// An unchanged selection on an ended poll is refused too, not acknowledged.
	f.exec(t, `UPDATE polls SET expires_at = '2999-01-01T00:00:00Z' WHERE message_id = ?`, id)
	if _, err := f.database.SetPollVote(context.Background(), id, f.viewer, []int64{1}); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `UPDATE polls SET ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE message_id = ?`, id)
	if _, err := f.database.SetPollVote(context.Background(), id, f.viewer, []int64{1}); !errors.Is(err, db.ErrPollEnded) {
		t.Errorf("same set on an ended poll: err = %v, want ErrPollEnded", err)
	}
}

func TestSetPollVote_DeletedPoll(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()
	id := f.create(t, pizzaPoll())
	if err := f.database.DeleteMessage(ctx, id, f.author, false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.SetPollVote(ctx, id, f.viewer, []int64{1}); !errors.Is(err, db.ErrPollNotFound) {
		t.Errorf("soft-deleted poll: err = %v, want ErrPollNotFound", err)
	}
	// A hard purge cascades the rows away, which gives the same answer.
	f.exec(t, `DELETE FROM messages WHERE id = ?`, id)
	if _, err := f.database.SetPollVote(ctx, id, f.viewer, []int64{1}); !errors.Is(err, db.ErrPollNotFound) {
		t.Errorf("purged poll: err = %v, want ErrPollNotFound", err)
	}
	// A message that is not a poll at all.
	plain, err := f.database.CreateMessage(ctx, f.channel, f.author, "hello", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.SetPollVote(ctx, plain, f.viewer, []int64{1}); !errors.Is(err, db.ErrPollNotFound) {
		t.Errorf("plain message: err = %v, want ErrPollNotFound", err)
	}
}

func TestSetPollVote_RefusedWhileErasing(t *testing.T) {
	f := newPollFixture(t)
	id := f.create(t, pizzaPoll())
	f.exec(t, `INSERT INTO erasure_jobs (user_id, state) VALUES (?, 'queued')`, f.viewer)
	if _, err := f.database.SetPollVote(context.Background(), id, f.viewer, []int64{1}); !errors.Is(err, db.ErrAccountErasing) {
		t.Fatalf("err = %v, want ErrAccountErasing", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM poll_votes`); n != 0 {
		t.Errorf("an erasing user wrote %d vote rows", n)
	}
}

func TestEndPoll_OnceOnly(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()
	id := f.create(t, pizzaPoll())
	r, err := f.database.EndPoll(ctx, id)
	if err != nil || !r.Ended || r.EndedAt == nil || r.Version != 1 || r.Deleted || r.AuthorID != f.author || r.ChannelID != f.channel {
		t.Fatalf("EndPoll = %+v, %v", r, err)
	}
	if _, err := f.database.EndPoll(ctx, id); !errors.Is(err, db.ErrPollEnded) {
		t.Errorf("second end: err = %v, want ErrPollEnded", err)
	}
	if v := f.version(t, id); v != 1 {
		t.Errorf("version = %d after a refused second end, want 1", v)
	}
	if _, err := f.database.EndPoll(ctx, id+1000); !errors.Is(err, db.ErrPollNotFound) {
		t.Errorf("unknown poll: err = %v, want ErrPollNotFound", err)
	}
	if _, err := f.database.SetPollVote(ctx, id, f.viewer, []int64{1}); !errors.Is(err, db.ErrPollEnded) {
		t.Errorf("vote after end: err = %v, want ErrPollEnded", err)
	}
	if p := f.history(t, f.viewer)[0].Poll; !p.Ended || p.EndedAt == nil || p.Results.Version != 1 {
		t.Errorf("history after end = %+v", p)
	}
}

func TestEndPoll_CountsIncludeEarlierVote(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()
	id := f.create(t, pizzaPoll())
	other := f.voter(t, "other-voter")
	for _, u := range []int64{f.viewer, other} {
		if _, err := f.database.SetPollVote(ctx, id, u, []int64{2}); err != nil {
			t.Fatal(err)
		}
	}
	r, err := f.database.EndPoll(ctx, id)
	if err != nil || r.TotalVoters != 2 || countOf(t, r.PollTally, 2) != 2 || countOf(t, r.PollTally, 1) != 0 || r.Version != 3 {
		t.Fatalf("EndPoll = %+v, %v", r, err)
	}
}

func TestEndPoll_ReportsDeletedPoll(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()
	id := f.create(t, pizzaPoll())
	if err := f.database.DeleteMessage(ctx, id, f.author, false); err != nil {
		t.Fatal(err)
	}
	r, err := f.database.EndPoll(ctx, id)
	if err != nil || !r.Deleted {
		t.Fatalf("EndPoll(deleted) = %+v, %v", r, err)
	}
}

func TestEndPoll_ExpiredButNotSweptStillEnds(t *testing.T) {
	f := newPollFixture(t)
	id := f.create(t, pizzaPoll())
	f.exec(t, `UPDATE polls SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 seconds') WHERE message_id = ?`, id)
	if r, err := f.database.EndPoll(context.Background(), id); err != nil || !r.Ended {
		t.Fatalf("EndPoll(expired) = %+v, %v", r, err)
	}
}

// Two voters race: the single writer serialises them, so each commit gets its
// own version and the final counts are exact.
func TestSetPollVote_RaceTwoVoters(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()
	multi := pizzaPoll()
	multi.AllowMultiselect = true
	id := f.create(t, multi)
	const voters = 12
	users := make([]int64, voters)
	for i := range users {
		users[i] = f.voter(t, fmt.Sprintf("racer-%d", i))
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	versions := make([]int64, voters)
	errs := make([]error, voters)
	for i := range users {
		wg.Go(func() {
			<-start
			r, err := f.database.SetPollVote(ctx, id, users[i], []int64{int64(i%2) + 1})
			if err == nil {
				versions[i] = r.Version
			}
			errs[i] = err
		})
	}
	close(start)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("voter %d: %v", i, err)
		}
	}
	slices.Sort(versions)
	for i, v := range versions {
		if v != int64(i+1) {
			t.Fatalf("versions = %v, want 1..%d each once", versions, voters)
		}
	}
	info, err := f.database.GetPollInfo(ctx, id, 0)
	if err != nil || info.Results.TotalVoters != voters || info.Results.Counts[0].Count != voters/2 || info.Results.Counts[1].Count != voters/2 {
		t.Fatalf("final results = %+v, %v", info, err)
	}
}

// A vote racing the end is counted or refused, never both. When the vote
// returned a tally the end committed after it, so the end's counts include
// it. When it was refused no row exists.
func TestSetPollVote_RaceEnd(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()
	counted, refused := 0, 0
	for i := range 60 {
		id := f.create(t, pizzaPoll())
		voter := f.voter(t, fmt.Sprintf("end-racer-%d", i))
		start := make(chan struct{})
		var wg sync.WaitGroup
		var vote *db.PollVoteResult
		var voteErr, endErr error
		var end *db.PollEndResult
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			vote, voteErr = f.database.SetPollVote(ctx, id, voter, []int64{1})
		}()
		go func() {
			defer wg.Done()
			<-start
			end, endErr = f.database.EndPoll(ctx, id)
		}()
		close(start)
		wg.Wait()
		if endErr != nil {
			t.Fatalf("round %d: EndPoll: %v", i, endErr)
		}
		rows := f.count(t, `SELECT COUNT(*) FROM poll_votes WHERE message_id = ?`, id)
		switch {
		case voteErr == nil:
			counted++
			if rows != 1 || vote.Version >= end.Version || countOf(t, end.PollTally, 1) != 1 || end.TotalVoters != 1 {
				t.Fatalf("round %d: vote counted but vote=%+v end=%+v rows=%d", i, vote, end, rows)
			}
		case errors.Is(voteErr, db.ErrPollEnded):
			refused++
			if rows != 0 || end.TotalVoters != 0 || end.Version != 1 {
				t.Fatalf("round %d: vote refused but rows=%d end=%+v", i, rows, end)
			}
		default:
			t.Fatalf("round %d: vote err = %v", i, voteErr)
		}
	}
	t.Logf("vote racing end: %d counted, %d refused", counted, refused)
}

func TestNextPollExpiryAndListDuePolls(t *testing.T) {
	f := newPollFixture(t)
	ctx := context.Background()
	if _, ok, err := f.database.NextPollExpiry(ctx); err != nil || ok {
		t.Fatalf("empty: ok=%v err=%v", ok, err)
	}
	soon, later, ended, deleted := f.create(t, pizzaPoll()), f.create(t, pizzaPoll()), f.create(t, pizzaPoll()), f.create(t, pizzaPoll())
	f.exec(t, `UPDATE polls SET expires_at = '2026-01-01T00:00:10Z' WHERE message_id = ?`, soon)
	f.exec(t, `UPDATE polls SET expires_at = '2026-01-01T00:00:20Z' WHERE message_id = ?`, later)
	f.exec(t, `UPDATE polls SET expires_at = '2026-01-01T00:00:05Z', ended_at = '2026-01-01T00:00:06Z' WHERE message_id = ?`, ended)
	f.exec(t, `UPDATE polls SET expires_at = '2026-01-01T00:00:15Z' WHERE message_id = ?`, deleted)
	if err := f.database.DeleteMessage(ctx, deleted, f.author, false); err != nil {
		t.Fatal(err)
	}

	next, ok, err := f.database.NextPollExpiry(ctx)
	if err != nil || !ok || next != "2026-01-01T00:00:10Z" {
		t.Fatalf("NextPollExpiry = %q, %v, %v (an ended poll must not count)", next, ok, err)
	}
	due, err := f.database.ListDuePolls(ctx, "2026-01-01T00:00:16Z", 10)
	if err != nil || len(due) != 2 {
		t.Fatalf("due = %+v, %v", due, err)
	}
	if due[0].MessageID != soon || due[0].Deleted || due[0].ChannelID != f.channel || due[0].AuthorID != f.author {
		t.Errorf("due[0] = %+v", due[0])
	}
	if due[1].MessageID != deleted || !due[1].Deleted {
		t.Errorf("due[1] = %+v, want the deleted poll", due[1])
	}
	if limited, err := f.database.ListDuePolls(ctx, "2026-01-01T00:00:16Z", 1); err != nil || len(limited) != 1 {
		t.Errorf("limit 1 = %+v, %v", limited, err)
	}
	if none, err := f.database.ListDuePolls(ctx, "2026-01-01T00:00:09Z", 10); err != nil || len(none) != 0 {
		t.Errorf("before any expiry = %+v, %v", none, err)
	}
}
