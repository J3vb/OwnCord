package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/service"
)

// GroupEventRows delivers group DM system rows (group_add, group_remove,
// group_leave, group_rename) as sequenced chat_message frames to audience. The
// REST handler that wrote them calls it after commit, once the refreshed
// dm_channel_open has been sent, so on each connection the open arrives first
// and an added user never receives a row for a DM they do not know yet.
//
// It holds no lock of its own: sendSequencedToUsers takes the sequence lock
// itself, so the lock order does not change. Rows are ordinary sequenced DM
// frames: they are replayed on reconnect, persisted, and carry no mention, so
// they raise no mention count and send no push.
func (h *Hub) GroupEventRows(ctx context.Context, channelID int64, audience []int64, rows []service.GroupEventRow) {
	if len(rows) == 0 || len(audience) == 0 {
		return
	}
	events := make([]Event, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		if r.Author == nil {
			continue
		}
		events = append(events, dmEvt{
			evType:         MsgTypeChatMessage,
			channelID:      channelID,
			participantIDs: audience,
			payload: buildChatMessage(chatMessageArgs{
				MsgID:       r.MessageID,
				ChannelID:   channelID,
				UserID:      r.Author.ID,
				Username:    r.Author.Username,
				Avatar:      r.Author.Avatar,
				DisplayName: r.Author.DisplayName,
				RoleName:    r.AuthorRole,
				Content:     r.Content,
				Timestamp:   r.Timestamp,
				Kind:        r.Kind,
				GroupEvent:  newGroupEventBlock(r),
			}),
		})
	}
	h.EmitEvents(ctx, events)
}

// newGroupEventBlock is the group_event object of a row, by kind: add and
// remove name the target, rename carries the new name ("" = removed), and a
// leave is the empty object.
func newGroupEventBlock(r *service.GroupEventRow) *groupEventBlock {
	switch r.Kind {
	case string(MessageKindGroupAdd), string(MessageKindGroupRemove):
		return &groupEventBlock{TargetUserID: r.TargetUserID}
	case string(MessageKindGroupRename):
		name := ""
		if r.Name != nil {
			name = *r.Name
		}
		return &groupEventBlock{Name: &name}
	default:
		return &groupEventBlock{}
	}
}
