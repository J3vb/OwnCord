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
	// Mentions carries the server-resolved user ids; MentionsEveryone reports
	// an @everyone/@here that cleared MENTION_EVERYONE. Clients highlight from
	// these instead of re-parsing the content.
	Mentions         []int64 `json:"mentions"`
	MentionsEveryone bool    `json:"mentions_everyone"`
	// MentionRoles lists the roles whose <@&id> token cleared the role-mention
	// gate (mentionable, or MENTION_EVERYONE). A client counts a role mention
	// only when the server lists the role here. Always present, empty for none.
	MentionRoles []int64 `json:"mention_roles"`
	// MentionsHere reports that MentionsEveryone came from @here rather than
	// @everyone (never both). Mention fan-out (service/mentions.go,
	// mentionEntries) skips the mention-count bump for an @here reader with no
	// live connection when the badge is written, so a client replaying this frame during a reconnect must not
	// raise a badge the server never counted (OC-0271).
	MentionsHere bool `json:"mentions_here"`
	// ReferencedMessage is the reply parent's snippet (null when not a reply,
	// or the parent is unavailable). A deleted parent is redacted to
	// {id, deleted: true}. An older server omits the field.
	ReferencedMessage *service.ReferencedMessage `json:"referenced_message"`
	// Kind and Call are set only on a call log row and omitted for an
	// ordinary message (WP 3B-9). See callBlock.
	Kind string     `json:"kind,omitempty"`
	Call *callBlock `json:"call,omitempty"`
	// GroupEvent is set only on a group DM row (WP 3B-10): the same shape as
	// the history payload's db.GroupEventInfo.
	GroupEvent *groupEventBlock `json:"group_event,omitempty"`
	// Forward is set only on a forwarded message (WP 6.9a): the same shape as
	// the history payload's db.ForwardInfo, static, so it replays as is.
	Forward *service.ForwardInfo `json:"forward,omitempty"`
	// Poll is set only on a poll message (WP 6.9b): the same shape as the
	// history payload's db.PollInfo. The counts are those at creation, zero, so
	// a replayed frame must not roll a newer count back (clients keep the higher
	// results.version).
	Poll *service.PollInfo `json:"poll,omitempty"`
	// Sticker is set only on a sticker message (WP 8.8a): the same shape as the
	// history payload's db.MessageStickerInfo. Static, so it replays as is; a
	// deleted sticker is read back with a null id and url by history.
	Sticker *service.MessageStickerInfo `json:"sticker,omitempty"`
	// Thread is the starter message's thread (WP 6.9c): the same shape as the
	// history payload's db.ThreadInfo. A message that has just been sent has no
	// thread yet, so no live send sets it; thread_changed carries a thread that
	// appears or changes afterwards. The field exists so a frame built from a
	// stored row has one shape with history.
	Thread *service.ThreadInfo `json:"thread,omitempty"`
}

// groupEventBlock is the group_event object of a group DM row. Add and remove
// set TargetUserID, rename sets Name ("" means removed), icon sets IconRemoved
// and leave sets none, so it encodes as {}.
type groupEventBlock struct {
	TargetUserID int64   `json:"target_user_id,omitempty"`
	Name         *string `json:"name,omitempty"`
	IconRemoved  *bool   `json:"icon_removed,omitempty"`
}

// callBlock is the call object of a call log row: the same shape as the
// history payload's db.CallInfo. EndedAt is null while the call is live.
type callBlock struct {
	StartedAt    string  `json:"started_at"`
	EndedAt      *string `json:"ended_at"`
	Participants []int64 `json:"participants"`
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
	MentionRoles      []int64
	MentionsEveryone  bool
	MentionsHere      bool
	ReferencedMessage *service.ReferencedMessage
	// Kind and Call are set only for a call log row.
	Kind string
	Call *callBlock
	// GroupEvent is set only for a group DM row.
	GroupEvent *groupEventBlock
	// Forward is set only for a forwarded message.
	Forward *service.ForwardInfo
	// Poll is set only for a poll message.
	Poll *service.PollInfo
	// Sticker is set only for a sticker message.
	Sticker *service.MessageStickerInfo
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

// replayCopy returns the bytes kept for replay (ring buffer and events table).
// A reply frame's parent snippet is live-only: replay can run after the parent
// was deleted, so the stored copy carries referenced_message null and the
// client falls back to the unknown-parent bar. Frames without a snippet are
// returned as is.
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

// replaySplice is a reply frame's stored copy computed without its seq: the
// bytes before and after the point where json.Marshal of the envelope map
// would place the "seq" key (envelope keys sort, so "seq" lands between
// "payload" and "type"). It exists so the JSON round-trips of replayCopy run
// before seqMu is taken; under the lock only the seq digits are spliced in.
// A nil *replaySplice means the frame needs no stripping.
type replaySplice struct {
	prefix []byte // `{"payload":...` — no trailing comma
	suffix []byte // `"type":...}` — no leading comma
}

// newReplaySplice does replayCopy's work for a not-yet-sequenced msg. It
// returns nil when msg carries no snippet, is not a sequenceable object, or
// cannot be parsed — in every such case the stored copy is the wrapped frame
// itself (or replayCopy of it, see storedCopy).
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

// storedCopy returns the replay bytes for wrapped (msg stamped with seq),
// identical to replayCopy(wrapped). rs is newReplaySplice(msg), computed
// before the sequencing lock. It does no JSON work on the splice path.
func storedCopy(rs *replaySplice, msg, wrapped []byte, seq uint64) []byte {
	if rs == nil {
		if sequenceable(msg) {
			// wrapped is msg plus a seq; replayCopy would have found
			// nothing to strip or failed to parse, and returned it as is.
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
