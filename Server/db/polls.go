package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// PollAnswerInput is one answer of a poll being created.
type PollAnswerInput struct {
	Text  string
	Emoji *string
}

// PollInput is the validated poll of a send, input to CreateMessageDelivery; no json
// tags (wire shape is PollInfo).
type PollInput struct {
	Question         string
	Answers          []PollAnswerInput
	DurationHours    int
	AllowMultiselect bool
}

// PollMeta is a poll's own row.
type PollMeta struct {
	MessageID        int64
	Question         string
	AllowMultiselect bool
	ExpiresAt        string
	EndedAt          *string
	Version          int64
}

// PollAnswer is one answer of the poll block.
type PollAnswer struct {
	AnswerID int64   `json:"answer_id"`
	Text     string  `json:"text"`
	Emoji    *string `json:"emoji"`
}

// PollCount is the number of votes one answer holds.
type PollCount struct {
	AnswerID int64 `json:"answer_id"`
	Count    int64 `json:"count"`
}

// PollResults are the tallies of a poll, read from the vote rows each time so they
// cannot drift. Version orders out-of-sequence updates. Me is the viewer's own answer
// ids, never nil, empty for a non-voter or the shared live frame.
type PollResults struct {
	Version     int64       `json:"version"`
	TotalVoters int64       `json:"total_voters"`
	Counts      []PollCount `json:"counts"`
	Me          []int64     `json:"me"`
}

// PollInfo is the poll block of a history row and live frame; Ended is true when ended
// or expired by the database clock.
type PollInfo struct {
	Question         string       `json:"question"`
	Answers          []PollAnswer `json:"answers"`
	AllowMultiselect bool         `json:"allow_multiselect"`
	ExpiresAt        string       `json:"expires_at"`
	Ended            bool         `json:"ended"`
	EndedAt          *string      `json:"ended_at"`
	Results          PollResults  `json:"results"`
}

// GetPollMeta returns the poll row of messageID, or nil when it is not a poll.
func (d *DB) GetPollMeta(ctx context.Context, messageID int64) (*PollMeta, error) {
	r, err := d.q.GetPollMeta(ctx, messageID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetPollMeta: %w", err)
	}
	return &PollMeta{
		MessageID: r.MessageID, Question: r.Question, AllowMultiselect: r.AllowMultiselect != 0,
		ExpiresAt: r.ExpiresAt, EndedAt: r.EndedAt, Version: r.Version,
	}, nil
}

// GetPollInfo returns the poll block as viewerID sees it, or nil; viewer 0 matches nobody.
func (d *DB) GetPollInfo(ctx context.Context, messageID, viewerID int64) (*PollInfo, error) {
	infos, err := d.pollInfos(ctx, []int64{messageID}, viewerID)
	if err != nil {
		return nil, fmt.Errorf("GetPollInfo: %w", err)
	}
	return infos[messageID], nil
}

// insertPollRows is the poll step of CreateMessageDelivery: poll row and answers after
// the message; expires_at comes from the message timestamp.
func insertPollRows(ctx context.Context, q *dbgen.Queries, messageID int64, p *PollInput) error {
	if err := q.InsertPoll(ctx, dbgen.InsertPollParams{
		Question: p.Question, AllowMultiselect: b2i64(p.AllowMultiselect),
		DurationModifier: fmt.Sprintf("+%d hours", p.DurationHours), MessageID: messageID,
	}); err != nil {
		return fmt.Errorf("poll row insert: %w", err)
	}
	for i := range p.Answers {
		if err := q.InsertPollAnswer(ctx, dbgen.InsertPollAnswerParams{
			MessageID: messageID, AnswerID: int64(i + 1), Text: p.Answers[i].Text, Emoji: p.Answers[i].Emoji,
		}); err != nil {
			return fmt.Errorf("poll answer insert: %w", err)
		}
	}
	return nil
}

// attachPolls fills Poll on every live ordinary poll row in msgs with batched reads,
// computed at read time.
func (d *DB) attachPolls(ctx context.Context, msgs []MessageAPIResponse, viewerID int64) error {
	var ids []int64
	for i := range msgs {
		if msgs[i].Kind == "" && !msgs[i].Deleted {
			ids = append(ids, msgs[i].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	infos, err := d.pollInfos(ctx, ids, viewerID)
	if err != nil {
		return err
	}
	if len(infos) == 0 {
		return nil
	}
	for i := range msgs {
		if msgs[i].Kind == "" && !msgs[i].Deleted {
			msgs[i].Poll = infos[msgs[i].ID]
		}
	}
	return nil
}

// pollInfos builds the poll block of each id that is a poll; others are absent.
func (d *DB) pollInfos(ctx context.Context, ids []int64, viewerID int64) (map[int64]*PollInfo, error) {
	polls, err := d.q.GetPollsByMessageIDs(ctx, padIDs(ids))
	if err != nil {
		return nil, fmt.Errorf("polls: %w", err)
	}
	out := make(map[int64]*PollInfo, len(polls))
	if len(polls) == 0 {
		return out, nil
	}
	pollIDs := make([]int64, 0, len(polls))
	for i := range polls {
		r := polls[i]
		pollIDs = append(pollIDs, r.MessageID)
		out[r.MessageID] = &PollInfo{
			Question: r.Question, Answers: []PollAnswer{}, AllowMultiselect: r.AllowMultiselect != 0,
			ExpiresAt: r.ExpiresAt, Ended: r.Ended != 0, EndedAt: r.EndedAt,
			Results: PollResults{Version: r.Version, Counts: []PollCount{}, Me: []int64{}},
		}
	}
	answers, err := d.q.GetPollAnswersByMessageIDs(ctx, padIDs(pollIDs))
	if err != nil {
		return nil, fmt.Errorf("poll answers: %w", err)
	}
	for i := range answers {
		a := answers[i]
		info := out[a.MessageID]
		info.Answers = append(info.Answers, PollAnswer{AnswerID: a.AnswerID, Text: a.Text, Emoji: a.Emoji})
		info.Results.Counts = append(info.Results.Counts, PollCount{AnswerID: a.AnswerID})
	}
	if err := d.fillPollTallies(ctx, out, pollIDs, viewerID); err != nil {
		return nil, err
	}
	return out, nil
}

// fillPollTallies adds counts, distinct voters and the viewer's selection to blocks
// whose answers are in place.
func (d *DB) fillPollTallies(ctx context.Context, out map[int64]*PollInfo, pollIDs []int64, viewerID int64) error {
	counts, err := d.q.GetPollAnswerCountsByMessageIDs(ctx, padIDs(pollIDs))
	if err != nil {
		return fmt.Errorf("poll counts: %w", err)
	}
	for i := range counts {
		c := counts[i]
		res := &out[c.MessageID].Results
		for j := range res.Counts {
			if res.Counts[j].AnswerID == c.AnswerID {
				res.Counts[j].Count = c.Votes
			}
		}
	}
	voters, err := d.q.GetPollVoterCountsByMessageIDs(ctx, padIDs(pollIDs))
	if err != nil {
		return fmt.Errorf("poll voters: %w", err)
	}
	for i := range voters {
		out[voters[i].MessageID].Results.TotalVoters = voters[i].Voters
	}
	if viewerID == 0 {
		return nil
	}
	mine, err := d.q.GetPollVotesByUser(ctx, dbgen.GetPollVotesByUserParams{UserID: viewerID, Ids: padIDs(pollIDs)})
	if err != nil {
		return fmt.Errorf("poll own votes: %w", err)
	}
	for i := range mine {
		res := &out[mine[i].MessageID].Results
		res.Me = append(res.Me, mine[i].AnswerID)
	}
	return nil
}
