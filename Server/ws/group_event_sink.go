package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/service"
)

// GroupEventRows delivers group DM system rows (group_add, group_remove,
// group_leave, group_rename, group_icon) as sequenced chat_message frames. The
// REST handler calls it after commit and after the refreshed dm_channel_open, so
// an added user never gets a row for a DM they do not know yet.
// It holds no lock itself (sendSequencedToUsers takes the sequence lock). Rows
// are replayed, persisted, and raise no mention count or push.
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

// newGroupEventBlock builds a row's group_event object: add/remove name the
// target, rename carries the new name ("" = removed), icon says whether it was
// removed, leave is empty.
func newGroupEventBlock(r *service.GroupEventRow) *groupEventBlock {
	switch r.Kind {
	case string(MessageKindGroupAdd), string(MessageKindGroupRemove):
		return &groupEventBlock{TargetUserID: r.TargetUserID}
	case string(MessageKindGroupIcon):
		removed := r.IconRemoved
		return &groupEventBlock{IconRemoved: &removed}
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
