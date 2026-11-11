package ws

import (
	"encoding/json"
	"fmt"
)

// The read-state commands (channel_focus, mark_read, mark_unread), split from
// command.go which is at its size ceiling.

// ChannelFocusCmd represents a channel_focus message.
type ChannelFocusCmd struct {
	userID    int64
	ChannelID int64
	// NoRead is true only when the client sent read:false; absent means read:true
	// (old clients).
	NoRead bool
}

func (c ChannelFocusCmd) Type() string  { return MsgTypeChannelFocus }
func (c ChannelFocusCmd) UserID() int64 { return c.userID }

// MarkReadCmd advances the caller's read state without making the channel focused
// (channel_focus would rebind the focused channel).
type MarkReadCmd struct {
	userID    int64
	ChannelID int64
	// MessageID is the message to read up to; 0 marks the channel read at its
	// latest message.
	MessageID int64
}

func (c MarkReadCmd) Type() string  { return MsgTypeMarkRead }
func (c MarkReadCmd) UserID() int64 { return c.userID }

// MarkUnreadCmd moves the read pointer to just before MessageID, so it and
// everything after are unread.
type MarkUnreadCmd struct {
	userID    int64
	ChannelID int64
	MessageID int64
}

func (c MarkUnreadCmd) Type() string  { return MsgTypeMarkUnread }
func (c MarkUnreadCmd) UserID() int64 { return c.userID }

func parseChannelFocus(userID int64, _ string, raw json.RawMessage) (Command, error) {
	chID, err := parseCallChannelID(MsgTypeChannelFocus, raw)
	if err != nil {
		return nil, err
	}
	var p struct {
		Read *bool `json:"read"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid channel_focus payload: %w", err)
	}
	return ChannelFocusCmd{userID: userID, ChannelID: chID, NoRead: p.Read != nil && !*p.Read}, nil
}

func parseMarkRead(userID int64, _ string, raw json.RawMessage) (Command, error) {
	chID, err := parseCallChannelID(MsgTypeMarkRead, raw)
	if err != nil {
		return nil, err
	}
	var p struct {
		MessageID *json.Number `json:"message_id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid mark_read payload: %w", err)
	}
	var msgID int64
	if p.MessageID != nil {
		if msgID, err = positiveID(*p.MessageID, "message_id"); err != nil {
			return nil, err
		}
	}
	return MarkReadCmd{userID: userID, ChannelID: chID, MessageID: msgID}, nil
}

func parseMarkUnread(userID int64, _ string, raw json.RawMessage) (Command, error) {
	chID, err := parseCallChannelID(MsgTypeMarkUnread, raw)
	if err != nil {
		return nil, err
	}
	var p struct {
		MessageID json.Number `json:"message_id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid mark_unread payload: %w", err)
	}
	msgID, err := positiveID(p.MessageID, "message_id")
	if err != nil {
		return nil, err
	}
	return MarkUnreadCmd{userID: userID, ChannelID: chID, MessageID: msgID}, nil
}
