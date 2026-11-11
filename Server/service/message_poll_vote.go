package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// pollVoteLimit/pollVoteWindow cap votes and ends together, per user: a vote fans out to
// every reader like a reaction, and changing one's mind a few times a minute is the worst honest case.
const (
	pollVoteLimit  = 10
	pollVoteWindow = 10 * time.Second
)

// PollUpdate is the full state of a poll after a change, for poll_update. Counts are
// absolute, never deltas, so any update with a higher Version is complete. UserID and
// AnswerIDs are set only on a vote (AnswerIDs may be empty: a removal).
type PollUpdate struct {
	ChannelID   int64
	MessageID   int64
	Version     int64
	TotalVoters int64
	Counts      []db.PollCount
	Ended       bool
	EndedAt     *string
	UserID      int64
	AnswerIDs   []int64
	// IsDM and ParticipantIDs address a DM poll's update, resolved before the write as for a reaction.
	IsDM           bool
	ParticipantIDs []int64
}

// PollVoteResult is the outcome of VotePoll. Update is nil when the selection was already
// the voter's: acknowledged with the current Version, nothing emitted. AnswerIDs is the
// voter's selection after the call.
type PollVoteResult struct {
	MessageID int64
	Version   int64
	AnswerIDs []int64
	Update    *PollUpdate
}

// PollNotifier is told when the expirer ended a poll, so live clients learn the final counts (the hub).
type PollNotifier interface {
	PollUpdated(ctx context.Context, u PollUpdate)
}

func errPollNotFound() error {
	return fmt.Errorf("%w: poll not found", ErrNotFound)
}

func pollWriteError(err error, op string) error {
	switch {
	case errors.Is(err, db.ErrPollNotFound):
		return errPollNotFound()
	case errors.Is(err, db.ErrPollEnded):
		return fmt.Errorf("%w: %w: the poll has ended", ErrBadRequest, ErrPollEnded)
	case errors.Is(err, db.ErrPollAnswerInvalid):
		return fmt.Errorf("%w: %s", ErrBadRequest, "answer_ids must be distinct answers of the poll, one for a single-choice poll")
	case errors.Is(err, db.ErrAccountErasing):
		return fmt.Errorf("%w: account is being deleted", ErrForbidden)
	default:
		slog.Warn("poll write failed", "op", op, "err", err)
		return fmt.Errorf("%w: %s failed", ErrInternal, op)
	}
}

// pollTarget is the shared front half of a vote and an end: the rate limit, then the
// message, which the caller must be able to read. Every refusal before that is the same
// NOT_FOUND an unknown id gets, so nothing leaks about an unreadable poll.
func (s *MessageService) pollTarget(ctx context.Context, userID, msgID int64) (*db.Message, error) {
	if s.poll.store == nil {
		return nil, fmt.Errorf("%w: polls are not available", ErrInternal)
	}
	if s.limiter != nil && !s.limiter.Allow(auth.Key("poll_vote", userID), pollVoteLimit, pollVoteWindow) {
		return nil, ErrRateLimited
	}
	if msgID <= 0 {
		return nil, fmt.Errorf("%w: message_id must be positive", ErrBadRequest)
	}
	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil {
		return nil, errPollNotFound()
	}
	if err := s.requireChannelRead(ctx, userID, msg.ChannelID); err != nil {
		return nil, errPollNotFound()
	}
	if msg.Deleted || msg.Kind != db.MessageKindUser {
		return nil, errPollNotFound()
	}
	return msg, nil
}

// VotePoll sets userID's whole selection, replacing any earlier one; an empty selection
// removes the vote. Voting is reacting: the caller must be able to read the message
// (refusal is NOT_FOUND) and the reaction gates apply unchanged (archive, ADD_REACTIONS,
// timeout, DM membership and block), with a DM's audience resolved before the write.
// Whether the poll is open is decided inside the write by the database clock, so a vote
// racing the end is counted or refused with ErrPollEnded, never both. Idempotent: the
// same selection answers with the current version and no Update.
func (s *MessageService) VotePoll(ctx context.Context, userID, msgID int64, answerIDs []int64) (*PollVoteResult, error) {
	msg, err := s.pollTarget(ctx, userID, msgID)
	if err != nil {
		return nil, err
	}
	if len(answerIDs) > maxPollAnswers {
		return nil, fmt.Errorf("%w: a poll has at most %d answers", ErrBadRequest, maxPollAnswers)
	}
	participantIDs, isDM, err := s.reactionAudience(ctx, userID, msg.ChannelID)
	if err != nil {
		return nil, err
	}
	res, err := s.poll.store.SetPollVote(ctx, msgID, userID, answerIDs)
	if err != nil {
		return nil, pollWriteError(err, "poll vote")
	}
	out := &PollVoteResult{MessageID: msgID, Version: res.Version, AnswerIDs: res.AnswerIDs}
	if !res.Changed {
		return out, nil
	}
	out.Update = &PollUpdate{
		ChannelID: msg.ChannelID, MessageID: msgID, Version: res.Version,
		TotalVoters: res.TotalVoters, Counts: res.Counts, Ended: res.Ended, EndedAt: res.EndedAt,
		UserID: userID, AnswerIDs: res.AnswerIDs, IsDM: isDM, ParticipantIDs: participantIDs,
	}
	return out, nil
}

// EndPoll ends a poll now, following the delete rule: the caller can read the message
// (refusal is NOT_FOUND), the channel is not archived, and the caller may delete the
// message (author, or MANAGE_MESSAGES). A timed-out author can still end their own poll,
// as they can still delete it. In a DM only the author may. No audit row. Ended gives ErrPollEnded.
func (s *MessageService) EndPoll(ctx context.Context, userID, msgID int64) (*PollUpdate, error) {
	msg, err := s.pollTarget(ctx, userID, msgID)
	if err != nil {
		return nil, err
	}
	ch, err := s.st.GetChannel(ctx, msg.ChannelID)
	if err != nil || ch == nil {
		return nil, errPollNotFound()
	}
	if err := requireChannelWritable(ch); err != nil {
		return nil, err
	}
	isAuthor := msg.UserID == userID
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, false)
	if err != nil {
		return nil, fmt.Errorf("%w: cannot end this poll", ErrForbidden)
	}
	if _, verdict := permissions.CanDeleteMessage(sub, isAuthor); verdict != nil || (ch.Type == "dm" && !isAuthor) {
		return nil, fmt.Errorf("%w: cannot end this poll", ErrForbidden)
	}
	return s.endPoll(ctx, ch, msgID, msg.UserID)
}

// ExpirePoll is the expirer's entry: it ends a due poll without a user gate and returns the
// update to announce, nil when there is nothing (the poll is gone, was ended meanwhile, or
// its message was deleted, which still ends it so it leaves the set the expirer watches).
func (s *MessageService) ExpirePoll(ctx context.Context, msgID int64) (*PollUpdate, error) {
	if s.poll.store == nil {
		return nil, fmt.Errorf("%w: polls are not available", ErrInternal)
	}
	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil {
		return nil, fmt.Errorf("%w: read poll message: %w", ErrInternal, err)
	}
	var ch *db.Channel
	var authorID int64
	if msg != nil {
		authorID = msg.UserID
		if ch, err = s.st.GetChannel(ctx, msg.ChannelID); err != nil {
			return nil, fmt.Errorf("%w: read poll channel: %w", ErrInternal, err)
		}
	}
	u, err := s.endPoll(ctx, ch, msgID, authorID)
	switch {
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrPollEnded):
		return nil, nil
	case err != nil:
		return nil, err
	}
	return u, nil
}

// endPoll resolves a DM's audience before the write, ends the poll and builds the update.
// A deleted poll is ended but reported as not found, so nothing is announced about it.
func (s *MessageService) endPoll(ctx context.Context, ch *db.Channel, msgID, authorID int64) (*PollUpdate, error) {
	var participantIDs []int64
	isDM := ch != nil && ch.Type == "dm"
	if isDM {
		ids, err := s.DMAudience(ctx, ch.ID, authorID)
		if err != nil {
			slog.Error("poll end: resolve DM participants failed", "err", err, "channel_id", ch.ID)
			return nil, fmt.Errorf("%w: failed to resolve DM participants", ErrInternal)
		}
		participantIDs = ids
	}
	res, err := s.poll.store.EndPoll(ctx, msgID)
	if err != nil {
		return nil, pollWriteError(err, "poll end")
	}
	if res.Deleted {
		return nil, errPollNotFound()
	}
	return &PollUpdate{
		ChannelID: res.ChannelID, MessageID: msgID, Version: res.Version,
		TotalVoters: res.TotalVoters, Counts: res.Counts, Ended: true, EndedAt: res.EndedAt,
		IsDM: isDM, ParticipantIDs: participantIDs,
	}, nil
}
