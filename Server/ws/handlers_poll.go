package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/service"
)

// registerPollHandlers registers the poll V2 message handlers.
func registerPollHandlers(r *HandlerRegistry, deps ChatDeps) {
	r.RegisterV2(MsgTypePollCreate, handlePollCreateV2, deps)
	r.RegisterV2(MsgTypePollVote, handlePollVoteV2, deps)
	r.RegisterV2(MsgTypePollEnd, handlePollEndV2, deps)
}

// handlePollCreateV2 processes a poll_create command via the
// MessageService. The reply is poll_create_ok; the events are the send path's,
// so a poll is sequenced, replayed and counted for channel_activity exactly as
// a message is.
func handlePollCreateV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	pc := cmd.(PollCreateCmd)

	answers := make([]service.PollAnswerParam, len(pc.Answers))
	for i, a := range pc.Answers {
		answers[i] = service.PollAnswerParam{Text: a.Text, Emoji: a.Emoji}
	}
	result, err := d.MessageSvc.CreatePoll(ctx, service.PollCreateParams{
		ClientMessageID:  pc.ClientMessageID,
		ChannelID:        pc.ChannelID,
		UserID:           info.UserID,
		Username:         info.Username,
		Question:         pc.Question,
		Answers:          answers,
		DurationHours:    pc.DurationHours,
		AllowMultiselect: pc.AllowMultiselect,
	})
	if err != nil {
		return serviceErrorToResult(err)
	}
	reply := buildPollCreateOK(info.ReqID, result.MessageID, pc.ChannelID, pc.ClientMessageID, result.Duplicate)
	if result.Duplicate {
		return Result{Reply: reply}
	}
	return sendResultEvents(d, info, pc.ClientMessageID, pc.ChannelID, nil, reply, result)
}

// pollUpdatePayload is the poll_update frame: the poll's full counts and
// version. UserID and AnswerIDs are present only on a vote, and name the voter
// and their new set (which may be empty, a removal).
type pollUpdatePayload struct {
	ChannelID   int64               `json:"channel_id"`
	MessageID   int64               `json:"message_id"`
	Version     int64               `json:"version"`
	TotalVoters int64               `json:"total_voters"`
	Counts      []service.PollCount `json:"counts"`
	Ended       bool                `json:"ended"`
	EndedAt     *string             `json:"ended_at"`
	UserID      int64               `json:"user_id,omitempty"`
	AnswerIDs   *[]int64            `json:"answer_ids,omitempty"`
}

// buildPollUpdate constructs a poll_update broadcast.
func buildPollUpdate(u service.PollUpdate) []byte {
	pl := pollUpdatePayload{
		ChannelID: u.ChannelID, MessageID: u.MessageID, Version: u.Version, TotalVoters: u.TotalVoters,
		Counts: u.Counts, Ended: u.Ended, EndedAt: u.EndedAt,
	}
	if pl.Counts == nil {
		pl.Counts = []service.PollCount{}
	}
	if u.UserID != 0 {
		ids := u.AnswerIDs
		if ids == nil {
			ids = []int64{}
		}
		pl.UserID, pl.AnswerIDs = u.UserID, &ids
	}
	return buildJSON(wsMsg{Type: MsgTypePollUpdate, Payload: pl})
}

// pollUpdateEvent addresses a poll_update: to the DM's participants, or to the
// channel's topic. Both are sequenced and replayable, as reaction_update is.
func pollUpdateEvent(u service.PollUpdate) Event {
	payload := buildPollUpdate(u)
	if u.IsDM {
		return dmEvt{evType: MsgTypePollUpdate, channelID: u.ChannelID, participantIDs: u.ParticipantIDs, payload: payload}
	}
	return channelEvt{evType: MsgTypePollUpdate, channelID: u.ChannelID, payload: payload}
}

// handlePollVoteV2 processes a poll_vote command. The reply is
// poll_vote_ok with the version and the stored selection. The poll_update is
// emitted after the commit, and only when the selection changed.
func handlePollVoteV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	vc := cmd.(PollVoteCmd)
	res, err := d.MessageSvc.VotePoll(ctx, info.UserID, vc.MessageID, vc.AnswerIDs)
	if err != nil {
		return serviceErrorToResult(err)
	}
	reply := buildPollVoteOK(info.ReqID, res.MessageID, res.Version, res.AnswerIDs)
	if res.Update == nil {
		return Result{Reply: reply}
	}
	return Result{Reply: reply, Events: []Event{pollUpdateEvent(*res.Update)}}
}

// handlePollEndV2 processes a poll_end command.
func handlePollEndV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	ec := cmd.(PollEndCmd)
	u, err := d.MessageSvc.EndPoll(ctx, info.UserID, ec.MessageID)
	if err != nil {
		return serviceErrorToResult(err)
	}
	return Result{Reply: buildPollEndOK(info.ReqID, ec.MessageID), Events: []Event{pollUpdateEvent(*u)}}
}

// PollUpdated is the poll expirer's hook (service.PollNotifier): it delivers
// the update of a poll that ran out. The caller's context is the expirer's own
// loop context.
func (h *Hub) PollUpdated(ctx context.Context, u service.PollUpdate) {
	h.EmitEvents(ctx, []Event{pollUpdateEvent(u)})
}
