package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/service"
)

// registerPollHandlers registers the poll V2 message handlers.
func registerPollHandlers(r *HandlerRegistry, deps ChatDeps) {
	r.RegisterV2(MsgTypePollCreate, handlePollCreateV2, deps)
}

// handlePollCreateV2 processes a poll_create command (WP 6.9b) via the
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
