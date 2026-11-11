package ws

import (
	"bytes"
	"encoding/json"
	"slices"
	"strconv"

	"github.com/J3vb/OwnCord/Server/service"
)

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
	// Mentions carries the server-resolved user ids; MentionsEveryone reports an @everyone/@here
	// that cleared MENTION_EVERYONE. Clients highlight from these, not by re-parsing content.
	Mentions         []int64 `json:"mentions"`
	MentionsEveryone bool    `json:"mentions_everyone"`
	// MentionRoles lists the roles whose <@&id> token cleared the role-mention gate. Always
	// present, empty for none; a client counts a role mention only when listed here.
	MentionRoles []int64 `json:"mention_roles"`
	// MentionsHere reports that MentionsEveryone came from @here (never both). Fan-out skips
	// the mention-count bump for an @here reader with no live connection, so a client replaying
	// this frame must not raise a badge the server never counted.
	MentionsHere bool `json:"mentions_here"`
	// ReferencedMessage is the reply parent's snippet (null when not a reply or unavailable); a deleted
	// parent is redacted to {id, deleted: true}.
	ReferencedMessage *service.ReferencedMessage `json:"referenced_message"`
	// Kind and Call are set only on a call log row (see callBlock).
	Kind       string           `json:"kind,omitempty"`
	Call       *callBlock       `json:"call,omitempty"`
	GroupEvent *groupEventBlock `json:"group_event,omitempty"`
	// Forward is set only on a forwarded message; static, so it replays as is.
	Forward *service.ForwardInfo `json:"forward,omitempty"`
	// Poll is set only on a poll message. Counts are those at creation (zero), so a replayed
	// frame must not roll a newer count back (clients keep the higher results.version).
	Poll *service.PollInfo `json:"poll,omitempty"`
	// Sticker is set only on a sticker message; static, so it replays as is. History reads a deleted sticker
	// back with a null id and url.
	Sticker *service.MessageStickerInfo `json:"sticker,omitempty"`
	// Thread is the starter message's thread. A just-sent message has none (thread_changed
	// carries a thread that appears later); it gives a stored-row frame the same shape as history.
	Thread *service.ThreadInfo `json:"thread,omitempty"`
}

// groupEventBlock is the group_event object of a group DM row. Add/remove set TargetUserID,
// rename sets Name ("" means removed), icon sets IconRemoved, leave sets none ({}).
type groupEventBlock struct {
	TargetUserID int64   `json:"target_user_id,omitempty"`
	Name         *string `json:"name,omitempty"`
	IconRemoved  *bool   `json:"icon_removed,omitempty"`
}

// callBlock is the call object of a call log row, shaped like db.CallInfo. EndedAt is null while live.
type callBlock struct {
	StartedAt    string  `json:"started_at"`
	EndedAt      *string `json:"ended_at"`
	Participants []int64 `json:"participants"`
}

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
	MentionRoles      []int64
	MentionsEveryone  bool
	MentionsHere      bool
	ReferencedMessage *service.ReferencedMessage
	Kind              string
	Call              *callBlock
	GroupEvent        *groupEventBlock
	Forward           *service.ForwardInfo
	Poll              *service.PollInfo
	Sticker           *service.MessageStickerInfo
}

// buildChatMessage constructs a chat_message envelope, with the role in the user object and
// an empty reactions array to match the REST API.
func buildChatMessage(a chatMessageArgs) []byte {
	attachments := a.Attachments
	if attachments == nil {
		attachments = []map[string]any{}
	}
	mentions := a.Mentions
	if mentions == nil {
		mentions = []int64{}
	}
	mentionRoles := a.MentionRoles
	if mentionRoles == nil {
		mentionRoles = []int64{}
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
			MentionRoles:      mentionRoles,
			MentionsEveryone:  a.MentionsEveryone,
			MentionsHere:      a.MentionsHere,
			ReferencedMessage: a.ReferencedMessage,
			Kind:              a.Kind,
			Call:              a.Call,
			GroupEvent:        a.GroupEvent,
			Forward:           a.Forward,
			Poll:              a.Poll,
			Sticker:           a.Sticker,
		},
	})
}

var referencedMessageKey = []byte(`"referenced_message":{`)

// replayCopy returns the bytes kept for replay. A reply's parent snippet is live-only
// (replay can run after the parent was deleted), so the stored copy carries
// referenced_message null. Frames without a snippet are returned as is.
func replayCopy(frame []byte) []byte {
	if !bytes.Contains(frame, referencedMessageKey) {
		return frame
	}
	var env map[string]json.RawMessage
	if json.Unmarshal(frame, &env) != nil {
		return frame
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(env["payload"], &payload) != nil || payload == nil {
		return frame
	}
	payload["referenced_message"] = json.RawMessage("null")
	pb, err := json.Marshal(payload)
	if err != nil {
		return frame
	}
	env["payload"] = pb
	out, err := json.Marshal(env)
	if err != nil {
		return frame
	}
	return out
}

// replaySplice is a reply frame's stored copy computed without its seq: the bytes before
// and after where json.Marshal of the envelope would place "seq" (keys sort, so between
// "payload" and "type"). It lets replayCopy's JSON round-trips run before seqMu is taken;
// under the lock only the seq digits are spliced in. nil means no stripping is needed.
type replaySplice struct {
	prefix []byte // `{"payload":...` — no trailing comma
	suffix []byte // `"type":...}` — no leading comma
}

// newReplaySplice does replayCopy's work for a not-yet-sequenced msg. nil when msg has no
// snippet, is not a sequenceable object, or cannot be parsed (the stored copy is then the
// wrapped frame or replayCopy of it).
func newReplaySplice(msg []byte) *replaySplice {
	if !sequenceable(msg) || !bytes.Contains(msg, referencedMessageKey) {
		return nil
	}
	var env map[string]json.RawMessage
	if json.Unmarshal(msg, &env) != nil {
		return nil
	}
	if _, has := env["seq"]; has {
		return nil
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(env["payload"], &payload) != nil || payload == nil {
		return nil
	}
	payload["referenced_message"] = json.RawMessage("null")
	pb, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	env["payload"] = pb
	before := map[string]json.RawMessage{}
	after := map[string]json.RawMessage{}
	for k, v := range env {
		if k < "seq" {
			before[k] = v
		} else {
			after[k] = v
		}
	}
	bb, err := json.Marshal(before)
	if err != nil {
		return nil
	}
	ab, err := json.Marshal(after)
	if err != nil {
		return nil
	}
	return &replaySplice{prefix: bb[:len(bb)-1], suffix: ab[1:]}
}

// storedCopy returns the replay bytes for wrapped (msg stamped with seq), identical to
// replayCopy(wrapped); rs is newReplaySplice(msg), computed before the sequencing lock.
func storedCopy(rs *replaySplice, msg, wrapped []byte, seq uint64) []byte {
	if rs == nil {
		if sequenceable(msg) {
			// wrapped is msg plus a seq; replayCopy would have found nothing to strip.
			if !bytes.Contains(msg, referencedMessageKey) {
				return wrapped
			}
		}
		return replayCopy(wrapped)
	}
	var mid [32]byte
	m := mid[:0]
	if len(rs.prefix) > 1 {
		m = append(m, ',')
	}
	m = append(m, `"seq":`...)
	m = strconv.AppendUint(m, seq, 10)
	if len(rs.suffix) > 1 {
		m = append(m, ',')
	}
	return slices.Concat(rs.prefix, m, rs.suffix)
}

type chatSendOKPayload struct {
	ClientMessageID      string   `json:"client_message_id,omitempty"`
	Deduplicated         bool     `json:"deduplicated,omitempty"`
	MessageID            int64    `json:"message_id"`
	Timestamp            string   `json:"timestamp"`
	SkippedAttachmentIDs []string `json:"skipped_attachment_ids,omitempty"`
}

type chatEditedPayload struct {
	MessageID        int64   `json:"message_id"`
	ChannelID        int64   `json:"channel_id"`
	Content          string  `json:"content"`
	EditedAt         string  `json:"edited_at"`
	Mentions         []int64 `json:"mentions"`
	MentionsEveryone bool    `json:"mentions_everyone"`
	MentionRoles     []int64 `json:"mention_roles"`
	MentionsHere     bool    `json:"mentions_here"`
}

type chatDeletedPayload struct {
	MessageID int64 `json:"message_id"`
	ChannelID int64 `json:"channel_id"`
}

type chatBulkDeletedPayload struct {
	ChannelID int64   `json:"channel_id"`
	IDs       []int64 `json:"ids"`
}

type reactionUpdatePayload struct {
	MessageID int64  `json:"message_id"`
	ChannelID int64  `json:"channel_id"`
	Emoji     string `json:"emoji"`
	UserID    int64  `json:"user_id"`
	Action    string `json:"action"`
}

type typingPayload struct {
	ChannelID int64  `json:"channel_id"`
	UserID    int64  `json:"user_id"`
	Username  string `json:"username"`
}

func buildChatSendOK(requestID string, msgID int64, timestamp, clientMessageID string, duplicate bool, skippedAttachmentIDs []string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChatSendOK,
		ID:      requestID,
		Payload: chatSendOKPayload{MessageID: msgID, Timestamp: timestamp, ClientMessageID: clientMessageID, Deduplicated: duplicate, SkippedAttachmentIDs: skippedAttachmentIDs},
	})
}

func buildChatEdited(msgID, channelID int64, content, editedAt string, mentions, mentionRoles []int64, mentionsEveryone, mentionsHere bool) []byte {
	if mentions == nil {
		mentions = []int64{}
	}
	if mentionRoles == nil {
		mentionRoles = []int64{}
	}
	return buildJSON(wsMsg{
		Type: MsgTypeChatEdited,
		Payload: chatEditedPayload{
			MessageID:        msgID,
			ChannelID:        channelID,
			Content:          content,
			EditedAt:         editedAt,
			Mentions:         mentions,
			MentionRoles:     mentionRoles,
			MentionsEveryone: mentionsEveryone,
			MentionsHere:     mentionsHere,
		},
	})
}

func buildChatDeleted(msgID, channelID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChatDeleted,
		Payload: chatDeletedPayload{MessageID: msgID, ChannelID: channelID},
	})
}

func buildChatBulkDeleted(channelID int64, ids []int64) []byte {
	if ids == nil {
		ids = []int64{}
	}
	return buildJSON(wsMsg{
		Type:    MsgTypeChatBulkDeleted,
		Payload: chatBulkDeletedPayload{ChannelID: channelID, IDs: ids},
	})
}

func buildReactionUpdate(msgID, channelID, userID int64, emoji, action string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeReactionUpdate,
		Payload: reactionUpdatePayload{
			MessageID: msgID,
			ChannelID: channelID,
			Emoji:     emoji,
			UserID:    userID,
			Action:    action,
		},
	})
}

func buildTypingMsg(channelID, userID int64, username string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeTyping,
		Payload: typingPayload{
			ChannelID: channelID,
			UserID:    userID,
			Username:  username,
		},
	})
}
