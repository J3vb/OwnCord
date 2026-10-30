package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/service"
)

// WelcomeRow delivers the welcome row a new member's arrival wrote (kind
// member_join) as a sequenced chat_message to the readers of its
// channel, with a channel_activity note so readers elsewhere get an unread
// hint. WelcomeService calls it after the row committed. The author is the new
// member; the row replies to nothing.
//
// It holds no lock of its own: EmitEvents takes the sequence lock itself, so the
// lock order does not change. The row is persisted and replayed on reconnect like
// any message, and carries no mention, so it raises no mention count and sends no
// push (push runs only on the send path).
func (h *Hub) WelcomeRow(ctx context.Context, res *service.WelcomeResult) {
	if res == nil || res.Row == nil || res.Author == nil {
		return
	}
	row := res.Row
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
		Kind:        string(MessageKindMemberJoin),
	})
	h.EmitEvents(ctx, []Event{
		channelEvt{evType: MsgTypeChatMessage, channelID: row.ChannelID, payload: payload},
		channelActivityEvt{channelID: row.ChannelID, msgID: row.MessageID, authorID: res.Author.ID},
	})
}

var _ service.WelcomeNotifier = (*Hub)(nil)
