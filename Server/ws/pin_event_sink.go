package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/service"
)

// PinEventRow delivers the pin row a pin wrote (kind pin_add) as a sequenced
// chat_message: to the participants of a DM, or to the readers of a channel
// with a channel_activity note so readers elsewhere get an unread hint. The REST
// handler calls it after the pin committed. reply_to names the pinned message;
// referenced_message stays null because the client needs only the id.
//
// It holds no lock of its own: EmitEvents takes the sequence lock itself, so the
// lock order does not change. The row is persisted and replayed on reconnect like
// any message, and carries no mention, so it raises no mention count and sends no
// push (push runs only on the send path).
func (h *Hub) PinEventRow(ctx context.Context, res *service.PinEventResult) {
	if res == nil || res.Row == nil || res.Author == nil {
		return
	}
	row := res.Row
	pinned := row.PinnedMessageID
	payload := buildChatMessage(chatMessageArgs{
		MsgID:       row.MessageID,
		ChannelID:   row.ChannelID,
		UserID:      res.Author.ID,
		Username:    res.Author.Username,
		Avatar:      res.Author.Avatar,
		DisplayName: res.Author.DisplayName,
		RoleName:    res.AuthorRole,
		Content:     row.Content,
		Timestamp:   row.Timestamp,
		ReplyTo:     &pinned,
		Kind:        string(MessageKindPinAdd),
	})
	events := []Event{dmEventOrFallback(
		dmEvt{evType: MsgTypeChatMessage, channelID: row.ChannelID, participantIDs: res.ParticipantIDs, payload: payload},
		channelEvt{evType: MsgTypeChatMessage, channelID: row.ChannelID, payload: payload},
		res.ParticipantIDs)}
	if !res.IsDM {
		events = append(events, channelActivityEvt{
			channelID: row.ChannelID, msgID: row.MessageID, authorID: res.Author.ID,
		})
	}
	h.EmitEvents(ctx, events)
}
