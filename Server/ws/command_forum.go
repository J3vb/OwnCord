package ws

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/J3vb/OwnCord/Server/service"
)

// ForumPostCreateCmd represents a forum_post_create message: a post
// titled Name with its opening message, in forum ChannelID.
type ForumPostCreateCmd struct {
	userID          int64
	ReqID           string
	ClientMessageID string
	ChannelID       int64
	Name            string
	Content         string
	TagIDs          []int64
	attachments     []string
}

func (c ForumPostCreateCmd) Type() string          { return MsgTypeForumPostCreate }
func (c ForumPostCreateCmd) UserID() int64         { return c.userID }
func (c ForumPostCreateCmd) Attachments() []string { return slices.Clone(c.attachments) }

// maxForumPostTagIDs bounds the tag list a frame may carry before the service
// applies the real limit (db.MaxPostTags), so a hostile list costs nothing.
const maxForumPostTagIDs = 32

// parseForumPostCreate is the forum_post_create entry of commandConstructors.
// The attachment ids follow chat_send's rules: upload ids, at most 10, each
// bounded in length. client_message_id is required; the service validates its
// shape.
func parseForumPostCreate(userID int64, reqID string, raw json.RawMessage) (Command, error) {
	var p struct {
		ClientMessageID string      `json:"client_message_id"`
		ChannelID       json.Number `json:"channel_id"`
		Name            string      `json:"name"`
		Content         string      `json:"content"`
		Attachments     []string    `json:"attachments"`
		TagIDs          []int64     `json:"tag_ids"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid forum_post_create payload: %w", err)
	}
	chID, err := positiveID(p.ChannelID, "channel_id")
	if err != nil {
		return nil, err
	}
	if p.ClientMessageID == "" {
		return nil, fmt.Errorf("client_message_id is required")
	}
	if len(p.Attachments) > 10 {
		return nil, fmt.Errorf("too many attachments (max 10)")
	}
	for i, id := range p.Attachments {
		if len(id) > 2048 {
			return nil, fmt.Errorf("attachment[%d] id too long (max 2048)", i)
		}
	}
	if len(p.TagIDs) > maxForumPostTagIDs {
		return nil, fmt.Errorf("too many tag_ids")
	}
	return ForumPostCreateCmd{
		userID: userID, ReqID: reqID, ClientMessageID: p.ClientMessageID, ChannelID: chID,
		Name: p.Name, Content: p.Content, TagIDs: slices.Clone(p.TagIDs), attachments: slices.Clone(p.Attachments),
	}, nil
}

type forumPostCreateOKPayload struct {
	// Thread is absent on a retry answered for a caller who can no longer see
	// the forum.
	Thread          *service.ThreadInfo `json:"thread,omitempty"`
	MessageID       int64               `json:"message_id"`
	ClientMessageID string              `json:"client_message_id"`
	Deduplicated    bool                `json:"deduplicated"`
	// SkippedAttachmentIDs are requested uploads the post did not attach, as in
	// chat_send_ok; absent when every one was attached.
	SkippedAttachmentIDs []string `json:"skipped_attachment_ids,omitempty"`
}

// buildForumPostCreateOK answers a forum_post_create to its sender with the
// post as it stands. deduplicated is true when a retry was answered from the
// receipt and nothing new was posted.
func buildForumPostCreateOK(requestID string, t *service.ThreadInfo, msgID int64, clientMessageID string, duplicate bool, skipped []string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeForumPostCreateOK,
		ID:   requestID,
		Payload: forumPostCreateOKPayload{
			Thread: t, MessageID: msgID, ClientMessageID: clientMessageID, Deduplicated: duplicate,
			SkippedAttachmentIDs: skipped,
		},
	})
}
