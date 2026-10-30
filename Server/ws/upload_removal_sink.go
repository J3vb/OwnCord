package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/service"
)

// chatAttachmentsChangedPayload is the chat_edited frame an author's file removal
// sends: the edit payload plus the message's full remaining file list. Unlike
// chatEditedPayload, edited_at is null when the message was never edited (removing
// a file does not edit its text) and attachments is always present, an empty
// array once the last file is gone, so a client replaces its copy outright.
type chatAttachmentsChangedPayload struct {
	MessageID        int64                    `json:"message_id"`
	ChannelID        int64                    `json:"channel_id"`
	Content          string                   `json:"content"`
	EditedAt         *string                  `json:"edited_at"`
	Attachments      []service.AttachmentInfo `json:"attachments"`
	Mentions         []int64                  `json:"mentions"`
	MentionsEveryone bool                     `json:"mentions_everyone"`
	MentionRoles     []int64                  `json:"mention_roles"`
	MentionsHere     bool                     `json:"mentions_here"`
}

func buildChatAttachmentsChanged(res *service.AttachmentsChangedResult) []byte {
	mentions, roles, files := res.Mentions, res.MentionRoles, res.Attachments
	if mentions == nil {
		mentions = []int64{}
	}
	if roles == nil {
		roles = []int64{}
	}
	if files == nil {
		files = []service.AttachmentInfo{}
	}
	return buildJSON(wsMsg{
		Type: MsgTypeChatEdited,
		Payload: chatAttachmentsChangedPayload{
			MessageID:        res.MessageID,
			ChannelID:        res.ChannelID,
			Content:          res.Content,
			EditedAt:         res.EditedAt,
			Attachments:      files,
			Mentions:         mentions,
			MentionsEveryone: res.MentionsEveryone,
			MentionRoles:     roles,
			MentionsHere:     res.MentionsHere,
		},
	})
}

// AttachmentsChanged delivers a message whose file list shrank as a sequenced
// chat_edited carrying the remaining files, to the channel's readers or a DM's
// participants. The REST handler calls it after the removal committed. It holds
// no lock of its own: EmitEvents takes the sequence lock itself.
func (h *Hub) AttachmentsChanged(ctx context.Context, res *service.AttachmentsChangedResult) {
	if res == nil {
		return
	}
	h.EmitEvents(ctx, editedFrameEvents(buildChatAttachmentsChanged(res), res.ChannelID, res.IsDM, res.ParticipantIDs, res.PostOpening))
}

// MessageDeletedByUpload delivers the delete of a message whose last file its
// author removed, through the same chat_deleted fan-out as a delete from chat.
func (h *Hub) MessageDeletedByUpload(ctx context.Context, res *service.DeleteMessageResult) {
	if res == nil {
		return
	}
	h.EmitEvents(ctx, chatDeletedEvents(res))
}
