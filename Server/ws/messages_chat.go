package ws

import "github.com/J3vb/OwnCord/Server/db"

type chatMessagePayload struct {
	ClientMessageID string            `json:"client_message_id,omitempty"`
	ID              int64             `json:"id"`
	ChannelID       int64             `json:"channel_id"`
	User            memberUserPayload `json:"user"`
	Content         string            `json:"content"`
	ReplyTo         *int64            `json:"reply_to"`
	Timestamp       string            `json:"timestamp"`
	Attachments     []map[string]any  `json:"attachments"`
	Reactions       []any             `json:"reactions"`
	Pinned          bool              `json:"pinned"`
	// Mentions carries the server-resolved user ids; MentionsEveryone reports
	// an @everyone/@here that cleared MENTION_EVERYONE. Clients highlight from
	// these instead of re-parsing the content.
	Mentions         []int64 `json:"mentions"`
	MentionsEveryone bool    `json:"mentions_everyone"`
	// MentionsHere reports that MentionsEveryone came from @here rather than
	// @everyone (never both). Mention fan-out (service/mentions.go,
	// mentionEntries) skips the mention-count bump for an @here reader with no
	// live connection when the badge is written, so a client replaying this frame during a reconnect must not
	// raise a badge the server never counted (OC-0271).
	MentionsHere bool `json:"mentions_here"`
	// ReferencedMessage is the reply parent's snippet (null when not a reply,
	// or the parent is unavailable). A deleted parent is redacted to
	// {id, deleted: true}. An older server omits the field.
	ReferencedMessage *db.ReferencedMessage `json:"referenced_message"`
}

// chatMessageArgs is the input to buildChatMessage. It is a struct rather than
// a positional list because the payload has outgrown readable call sites.
type chatMessageArgs struct {
	ClientMessageID   string
	MsgID             int64
	ChannelID         int64
	UserID            int64
	Username          string
	Avatar            *string
	DisplayName       *string
	RoleName          string
	Content           string
	Timestamp         string
	ReplyTo           *int64
	Attachments       []map[string]any
	Mentions          []int64
	MentionsEveryone  bool
	MentionsHere      bool
	ReferencedMessage *db.ReferencedMessage
}

// buildChatMessage constructs a chat_message broadcast envelope.
// Includes role in user object and empty reactions array for consistency with REST API.
func buildChatMessage(a chatMessageArgs) []byte {
	attachments := a.Attachments
	if attachments == nil {
		attachments = []map[string]any{}
	}
	mentions := a.Mentions
	if mentions == nil {
		mentions = []int64{}
	}
	return buildJSON(wsMsg{
		Type: MsgTypeChatMessage,
		Payload: chatMessagePayload{
			ClientMessageID: a.ClientMessageID,
			ID:              a.MsgID,
			ChannelID:       a.ChannelID,
			User: memberUserPayload{
				ID:          a.UserID,
				Username:    a.Username,
				Avatar:      a.Avatar,
				Role:        a.RoleName,
				DisplayName: a.DisplayName,
			},
			Content:           a.Content,
			ReplyTo:           a.ReplyTo,
			Timestamp:         a.Timestamp,
			Attachments:       attachments,
			Reactions:         []any{},
			Pinned:            false,
			Mentions:          mentions,
			MentionsEveryone:  a.MentionsEveryone,
			MentionsHere:      a.MentionsHere,
			ReferencedMessage: a.ReferencedMessage,
		},
	})
}
