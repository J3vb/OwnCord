package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/service"
)

// callEditedPayload is the chat_edited frame that ends a call log row. Unlike
// an edit it carries edited_at null, so a client does not mark the row
// "(edited)", and it replaces the row's call block.
type callEditedPayload struct {
	MessageID        int64      `json:"message_id"`
	ChannelID        int64      `json:"channel_id"`
	Content          string     `json:"content"`
	EditedAt         *string    `json:"edited_at"`
	Mentions         []int64    `json:"mentions"`
	MentionRoles     []int64    `json:"mention_roles"`
	MentionsEveryone bool       `json:"mentions_everyone"`
	MentionsHere     bool       `json:"mentions_here"`
	Kind             string     `json:"kind"`
	Call             *callBlock `json:"call"`
}

func newCallBlock(ev service.CallLogEvent) *callBlock {
	parts := ev.Call.Participants
	if parts == nil {
		parts = []int64{}
	}
	return &callBlock{StartedAt: ev.Call.StartedAt, EndedAt: ev.Call.EndedAt, Participants: parts}
}

// CallLogCreated delivers a new call log row: a dm_channel_open for each
// recipient whose DM was closed, then the sequenced chat_message to the DM
// audience. It implements service.CallLogSink and holds no lock of its own;
// sendSequencedToUsers takes the sequence lock itself.
func (h *Hub) CallLogCreated(ctx context.Context, ev service.CallLogEvent) {
	if ev.Author == nil {
		return
	}
	events := make([]Event, 0, len(ev.Reopens)+1)
	for i := range ev.Reopens {
		events = append(events, DMChannelOpenEvent{
			targetUserID: ev.Reopens[i].UserID,
			payload:      buildJSON(wsMsg{Type: MsgTypeDMChannelOpen, Payload: ev.Reopens[i].Summary}),
		})
	}
	frame := buildChatMessage(chatMessageArgs{
		MsgID:       ev.MessageID,
		ChannelID:   ev.ChannelID,
		UserID:      ev.Author.ID,
		Username:    ev.Author.Username,
		Avatar:      ev.Author.Avatar,
		DisplayName: ev.Author.DisplayName,
		RoleName:    ev.AuthorRole,
		Content:     ev.Content,
		Timestamp:   ev.Timestamp,
		Kind:        string(MessageKindCall),
		Call:        newCallBlock(ev),
	})
	events = append(events, dmEvt{evType: MsgTypeChatMessage, channelID: ev.ChannelID, participantIDs: ev.Audience, payload: frame})
	h.EmitEvents(ctx, events)
}

// CallLogEnded delivers the end of a call log row as a sequenced chat_edited
// with edited_at null to the DM audience.
func (h *Hub) CallLogEnded(ctx context.Context, ev service.CallLogEvent) {
	frame := buildJSON(wsMsg{
		Type: MsgTypeChatEdited,
		Payload: callEditedPayload{
			MessageID:    ev.MessageID,
			ChannelID:    ev.ChannelID,
			Content:      ev.Content,
			Mentions:     []int64{},
			MentionRoles: []int64{},
			Kind:         string(MessageKindCall),
			Call:         newCallBlock(ev),
		},
	})
	h.EmitEvents(ctx, []Event{dmEvt{evType: MsgTypeChatEdited, channelID: ev.ChannelID, participantIDs: ev.Audience, payload: frame}})
}
