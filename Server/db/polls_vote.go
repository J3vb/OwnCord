package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// Poll vote and end refusals. Use errors.Is.
var (
	// ErrPollNotFound means the message is not a poll, or it was deleted.
	ErrPollNotFound = errors.New("poll not found")
	// ErrPollEnded means the poll was ended, or its expiry has passed, so it
	// takes no more votes and cannot be ended again.
	ErrPollEnded = errors.New("poll ended")
	// ErrPollAnswerInvalid means a vote named an answer the poll does not have,
	// named one twice, or named more than one on a single-choice poll.
	ErrPollAnswerInvalid = errors.New("poll answer invalid")
)

// PollTally is the full, absolute state of a poll after one change: its
// version, the distinct voters and the count of every answer, in answer order.
// It is what a poll_update carries, so any tally with a higher version is a
// complete state and no update needs the ones before it.
type PollTally struct {
	MessageID   int64
	ChannelID   int64
	Version     int64
	TotalVoters int64
	Counts      []PollCount
	Ended       bool
	EndedAt     *string
}

// PollVoteResult is the outcome of SetPollVote. Changed is false when the
// selection was already the voter's, in which case nothing was written and
// Version is the poll's current one. AnswerIDs is the voter's selection after
// the call, sorted and never nil.
type PollVoteResult struct {
	PollTally
	Changed   bool
	AnswerIDs []int64
}

// PollEndResult is the outcome of EndPoll. Deleted is true when the poll's
// message was deleted: the poll is ended all the same, so it leaves the set the
// expirer watches, but nobody needs telling.
type PollEndResult struct {
	PollTally
	AuthorID int64
	Deleted  bool
}

// DuePoll is a poll whose expiry has passed and that is not yet ended.
type DuePoll struct {
	MessageID int64
	ChannelID int64
	AuthorID  int64
	Deleted   bool
}

// SetPollVote replaces userID's whole selection on a poll with answerIDs. An
// empty selection removes the vote. It is one writer transaction, so the vote
// and a racing end or expiry are strictly ordered: the version bump is a
// conditional write that only lands while the poll is open by the database
// clock, which makes a vote either counted (and then in the counts of
// whatever ends the poll next) or refused with ErrPollEnded, never both.
// The counts it returns are read in the same transaction.
//
// A missing, purged or deleted poll gives ErrPollNotFound. An ended or expired
// poll gives ErrPollEnded, even for a selection the voter already holds. Unknown
// or repeated ids, or more than one on a single-choice poll, give
// ErrPollAnswerInvalid. A selection equal to the voter's current one writes
// nothing and reports Changed false, so a retry after a lost acknowledgement is
// harmless.
func (d *DB) SetPollVote(ctx context.Context, messageID, userID int64, answerIDs []int64) (*PollVoteResult, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("SetPollVote begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	if err := refuseWhileErasing(ctx, tx, userID); err != nil {
		return nil, fmt.Errorf("SetPollVote: %w", err)
	}
	q := d.q.WithTx(tx)
	poll, err := readPollForVote(ctx, q, messageID)
	if err != nil {
		return nil, err
	}
	if poll.Ended != 0 {
		return nil, fmt.Errorf("SetPollVote: %w", ErrPollEnded)
	}
	known, err := q.ListPollAnswerIDs(ctx, messageID)
	if err != nil {
		return nil, fmt.Errorf("SetPollVote answers: %w", err)
	}
	selection, err := normalizeSelection(answerIDs, known, poll.AllowMultiselect != 0)
	if err != nil {
		return nil, err
	}
	current, err := q.ListPollUserAnswerIDs(ctx, dbgen.ListPollUserAnswerIDsParams{MessageID: messageID, UserID: userID})
	if err != nil {
		return nil, fmt.Errorf("SetPollVote current: %w", err)
	}
	version, changed := poll.Version, !slices.Equal(current, selection)
	if changed {
		if version, err = writeVote(ctx, q, messageID, userID, selection); err != nil {
			return nil, err
		}
	}
	tally, err := pollTally(ctx, q, messageID, known)
	if err != nil {
		return nil, err
	}
	tally.ChannelID, tally.Version = poll.ChannelID, version
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("SetPollVote commit: %w", err)
	}
	return &PollVoteResult{PollTally: tally, Changed: changed, AnswerIDs: selection}, nil
}

// readPollForVote reads a poll with its message, mapping a missing row or a
// deleted message to ErrPollNotFound.
func readPollForVote(ctx context.Context, q *dbgen.Queries, messageID int64) (dbgen.GetPollForVoteRow, error) {
	poll, err := q.GetPollForVote(ctx, messageID)
	if errors.Is(err, sql.ErrNoRows) {
		return poll, fmt.Errorf("poll %d: %w", messageID, ErrPollNotFound)
	}
	if err != nil {
		return poll, fmt.Errorf("poll read: %w", err)
	}
	if poll.Deleted != 0 {
		return poll, fmt.Errorf("poll %d: %w", messageID, ErrPollNotFound)
	}
	return poll, nil
}

// normalizeSelection validates a selection against the poll's answers and
// returns it sorted and never nil.
func normalizeSelection(answerIDs, known []int64, multi bool) ([]int64, error) {
	if len(answerIDs) > 1 && !multi {
		return nil, fmt.Errorf("a single-choice poll takes one answer: %w", ErrPollAnswerInvalid)
	}
	out := slices.Clone(answerIDs)
	if out == nil {
		out = []int64{}
	}
	slices.Sort(out)
	for i, id := range out {
		if !slices.Contains(known, id) {
			return nil, fmt.Errorf("answer %d is not in the poll: %w", id, ErrPollAnswerInvalid)
		}
		if i > 0 && out[i-1] == id {
			return nil, fmt.Errorf("answer %d is named twice: %w", id, ErrPollAnswerInvalid)
		}
	}
	return out, nil
}

// writeVote is the write half of a changed vote: the conditional version bump
// first, so a poll that closed is refused before any vote row is touched, then
// the replacement of the voter's rows.
func writeVote(ctx context.Context, q *dbgen.Queries, messageID, userID int64, selection []int64) (int64, error) {
	version, err := q.BumpPollVersionIfOpen(ctx, messageID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("SetPollVote: %w", ErrPollEnded)
	}
	if err != nil {
		return 0, fmt.Errorf("SetPollVote version: %w", err)
	}
	if err := q.DeletePollUserVotes(ctx, dbgen.DeletePollUserVotesParams{MessageID: messageID, UserID: userID}); err != nil {
		return 0, fmt.Errorf("SetPollVote clear: %w", err)
	}
	for _, id := range selection {
		if err := q.InsertPollVote(ctx, dbgen.InsertPollVoteParams{MessageID: messageID, AnswerID: id, UserID: userID}); err != nil {
			return 0, fmt.Errorf("SetPollVote insert: %w", err)
		}
	}
	return version, nil
}

// EndPoll ends an open poll now, by the owner's button or by the expirer, and
// returns the final tally read in the same transaction. The write is
// conditional on the poll still being open, so an end and a racing end or vote
// are strictly ordered: a vote that committed first is in the counts. A poll
// that was already ended gives ErrPollEnded, a missing one ErrPollNotFound. An
// expired poll that no sweep has marked yet can still be ended, which is how
// the expirer marks it. A deleted poll is ended too, and reported as Deleted.
func (d *DB) EndPoll(ctx context.Context, messageID int64) (*PollEndResult, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("EndPoll begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := d.q.WithTx(tx)
	poll, err := q.GetPollForVote(ctx, messageID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("poll %d: %w", messageID, ErrPollNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("EndPoll read: %w", err)
	}
	ended, err := q.EndPollIfOpen(ctx, messageID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("EndPoll: %w", ErrPollEnded)
	}
	if err != nil {
		return nil, fmt.Errorf("EndPoll write: %w", err)
	}
	known, err := q.ListPollAnswerIDs(ctx, messageID)
	if err != nil {
		return nil, fmt.Errorf("EndPoll answers: %w", err)
	}
	tally, err := pollTally(ctx, q, messageID, known)
	if err != nil {
		return nil, err
	}
	tally.ChannelID, tally.Version, tally.Ended, tally.EndedAt = poll.ChannelID, ended.Version, true, ended.EndedAt
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("EndPoll commit: %w", err)
	}
	return &PollEndResult{PollTally: tally, AuthorID: poll.AuthorID, Deleted: poll.Deleted != 0}, nil
}

// pollTally reads the counts of every answer and the distinct voters, on q's
// connection, so inside a transaction it sees that transaction's writes.
func pollTally(ctx context.Context, q *dbgen.Queries, messageID int64, answerIDs []int64) (PollTally, error) {
	t := PollTally{MessageID: messageID, Counts: make([]PollCount, 0, len(answerIDs))}
	for _, id := range answerIDs {
		t.Counts = append(t.Counts, PollCount{AnswerID: id})
	}
	ids := []int64{messageID}
	counts, err := q.GetPollAnswerCountsByMessageIDs(ctx, ids)
	if err != nil {
		return t, fmt.Errorf("poll counts: %w", err)
	}
	for i := range counts {
		for j := range t.Counts {
			if t.Counts[j].AnswerID == counts[i].AnswerID {
				t.Counts[j].Count = counts[i].Votes
			}
		}
	}
	voters, err := q.GetPollVoterCountsByMessageIDs(ctx, ids)
	if err != nil {
		return t, fmt.Errorf("poll voters: %w", err)
	}
	if len(voters) > 0 {
		t.TotalVoters = voters[0].Voters
	}
	return t, nil
}

// NextPollExpiry returns the soonest expiry among polls that are not ended, in
// dbtime.ISOLayout text, or ok=false when none is pending.
func (d *DB) NextPollExpiry(ctx context.Context) (next string, ok bool, err error) {
	v, err := d.q.NextPollExpiry(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("NextPollExpiry: %w", err)
	}
	return v, true, nil
}

// ListDuePolls returns up to limit polls that are not ended and whose expiry is
// at or before now (dbtime.ISOLayout text), oldest first.
func (d *DB) ListDuePolls(ctx context.Context, now string, limit int) ([]DuePoll, error) {
	rows, err := d.q.ListDuePolls(ctx, dbgen.ListDuePollsParams{Now: now, MaxRows: int64(limit)})
	if err != nil {
		return nil, fmt.Errorf("ListDuePolls: %w", err)
	}
	out := make([]DuePoll, 0, len(rows))
	for i := range rows {
		r := rows[i]
		out = append(out, DuePoll{MessageID: r.MessageID, ChannelID: r.ChannelID, AuthorID: r.AuthorID, Deleted: r.Deleted != 0})
	}
	return out, nil
}
