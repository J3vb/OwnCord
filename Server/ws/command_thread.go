package ws

import (
	"encoding/json"
	"fmt"

	"github.com/J3vb/OwnCord/Server/service"
)

// The thread commands: thread_create, thread_update, thread_delete
// and thread_focus, with the frames the server answers and announces.

// ThreadCreateCmd represents a thread_create message: start a thread on
// message MessageID of text channel ChannelID.
type ThreadCreateCmd struct {
	userID             int64
	ChannelID          int64
	MessageID          int64
	Name               string
	AutoArchiveMinutes int
}

func (c ThreadCreateCmd) Type() string  { return MsgTypeThreadCreate }
func (c ThreadCreateCmd) UserID() int64 { return c.userID }

// ThreadUpdateCmd represents a thread_update message; a nil field is unchanged.
type ThreadUpdateCmd struct {
	userID             int64
	ThreadID           int64
	Name               *string
	Archived           *bool
	Locked             *bool
	AutoArchiveMinutes *int
	// TagIDs replaces a forum post's tags; nil leaves them.
	TagIDs *[]int64
}

func (c ThreadUpdateCmd) Type() string  { return MsgTypeThreadUpdate }
func (c ThreadUpdateCmd) UserID() int64 { return c.userID }

// ThreadDeleteCmd represents a thread_delete message.
type ThreadDeleteCmd struct {
	userID   int64
	ThreadID int64
}

func (c ThreadDeleteCmd) Type() string  { return MsgTypeThreadDelete }
func (c ThreadDeleteCmd) UserID() int64 { return c.userID }

// ThreadFocusCmd represents a thread_focus message: the thread open beside the
// focused channel. ThreadID 0 (a null thread_id) closes the slot.
type ThreadFocusCmd struct {
	userID   int64
	ThreadID int64
}

func (c ThreadFocusCmd) Type() string  { return MsgTypeThreadFocus }
func (c ThreadFocusCmd) UserID() int64 { return c.userID }

// ThreadFollowCmd represents a thread_follow message: follow (Follow true) or
// unfollow a thread.
type ThreadFollowCmd struct {
	userID   int64
	ThreadID int64
	Follow   bool
}

func (c ThreadFollowCmd) Type() string  { return MsgTypeThreadFollow }
func (c ThreadFollowCmd) UserID() int64 { return c.userID }

func parseThreadCreate(userID int64, _ string, raw json.RawMessage) (Command, error) {
	var p struct {
		ClientRequestID    string      `json:"client_request_id"`
		ChannelID          json.Number `json:"channel_id"`
		MessageID          json.Number `json:"message_id"`
		Name               string      `json:"name"`
		AutoArchiveMinutes int         `json:"auto_archive_minutes"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid thread_create payload: %w", err)
	}
	chID, err := positiveID(p.ChannelID, "channel_id")
	if err != nil {
		return nil, err
	}
	msgID, err := positiveID(p.MessageID, "message_id")
	if err != nil {
		return nil, err
	}
	return ThreadCreateCmd{
		userID: userID, ChannelID: chID, MessageID: msgID, Name: p.Name,
		AutoArchiveMinutes: p.AutoArchiveMinutes,
	}, nil
}

func parseThreadUpdate(userID int64, _ string, raw json.RawMessage) (Command, error) {
	var p struct {
		ThreadID           json.Number `json:"thread_id"`
		Name               *string     `json:"name"`
		Archived           *bool       `json:"archived"`
		Locked             *bool       `json:"locked"`
		AutoArchiveMinutes *int        `json:"auto_archive_minutes"`
		TagIDs             *[]int64    `json:"tag_ids"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid thread_update payload: %w", err)
	}
	if p.TagIDs != nil && len(*p.TagIDs) > maxForumPostTagIDs {
		return nil, fmt.Errorf("too many tag_ids")
	}
	id, err := positiveID(p.ThreadID, "thread_id")
	if err != nil {
		return nil, err
	}
	return ThreadUpdateCmd{
		userID: userID, ThreadID: id, Name: p.Name, Archived: p.Archived, Locked: p.Locked,
		AutoArchiveMinutes: p.AutoArchiveMinutes, TagIDs: p.TagIDs,
	}, nil
}

func parseThreadDelete(userID int64, _ string, raw json.RawMessage) (Command, error) {
	var p struct {
		ThreadID json.Number `json:"thread_id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid thread_delete payload: %w", err)
	}
	id, err := positiveID(p.ThreadID, "thread_id")
	if err != nil {
		return nil, err
	}
	return ThreadDeleteCmd{userID: userID, ThreadID: id}, nil
}

func parseThreadFocus(userID int64, _ string, raw json.RawMessage) (Command, error) {
	var p struct {
		ThreadID *json.Number `json:"thread_id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid thread_focus payload: %w", err)
	}
	if p.ThreadID == nil {
		return ThreadFocusCmd{userID: userID}, nil
	}
	id, err := positiveID(*p.ThreadID, "thread_id")
	if err != nil {
		return nil, err
	}
	return ThreadFocusCmd{userID: userID, ThreadID: id}, nil
}

func parseThreadFollow(userID int64, _ string, raw json.RawMessage) (Command, error) {
	var p struct {
		ThreadID json.Number `json:"thread_id"`
		Follow   *bool       `json:"follow"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid thread_follow payload: %w", err)
	}
	id, err := positiveID(p.ThreadID, "thread_id")
	if err != nil {
		return nil, err
	}
	if p.Follow == nil {
		return nil, fmt.Errorf("follow is required")
	}
	return ThreadFollowCmd{userID: userID, ThreadID: id, Follow: *p.Follow}, nil
}

// buildThreadCreateOK answers a thread_create to its sender.
func buildThreadCreateOK(requestID string, t *service.ThreadInfo) []byte {
	return buildJSON(wsMsg{Type: MsgTypeThreadCreateOK, ID: requestID, Payload: struct {
		Thread *service.ThreadInfo `json:"thread"`
	}{t}})
}

// buildThreadUpdateOK answers a thread_update to its sender.
func buildThreadUpdateOK(requestID string, threadID int64) []byte {
	return buildJSON(wsMsg{Type: MsgTypeThreadUpdateOK, ID: requestID, Payload: struct {
		ThreadID int64 `json:"thread_id"`
	}{threadID}})
}

// buildThreadFollowOK answers a thread_follow to its sender with the state it
// left the follow in.
func buildThreadFollowOK(requestID string, threadID int64, following bool) []byte {
	return buildJSON(wsMsg{Type: MsgTypeThreadFollowOK, ID: requestID, Payload: struct {
		ThreadID  int64 `json:"thread_id"`
		Following bool  `json:"following"`
	}{threadID, following}})
}

// buildThreadFollowUpdate is the thread_follow_update frame: one user's follow
// of a thread, with the thread when they follow it. Never authoritative: ready
// is.
func buildThreadFollowUpdate(threadID int64, following bool, t *service.ThreadInfo) []byte {
	return buildJSON(wsMsg{Type: MsgTypeThreadFollowUpdate, Payload: struct {
		ThreadID  int64               `json:"thread_id"`
		Following bool                `json:"following"`
		Thread    *service.ThreadInfo `json:"thread,omitempty"`
	}{threadID, following, t}})
}

// buildThreadChanged is the thread_changed frame: the thread's absolute state.
func buildThreadChanged(t *service.ThreadInfo) []byte {
	return buildJSON(wsMsg{Type: MsgTypeThreadChanged, Payload: struct {
		Thread *service.ThreadInfo `json:"thread"`
	}{t}})
}

// buildThreadDeleted is the thread_deleted frame, sequenced on the parent.
func buildThreadDeleted(parentID, threadID int64) []byte {
	return buildJSON(wsMsg{Type: MsgTypeThreadDeleted, Payload: struct {
		ChannelID int64 `json:"channel_id"`
		ThreadID  int64 `json:"thread_id"`
	}{parentID, threadID}})
}

// buildThreadErrorMsg is an error frame that also names a thread (THREAD_EXISTS
// carries the thread that already has the message).
func buildThreadErrorMsg(ce ClientError, reqID string) []byte {
	msg := map[string]any{
		"type": MsgTypeError,
		"payload": map[string]any{
			"code":      ce.Code,
			"message":   ce.Message,
			"thread_id": ce.ThreadID,
		},
	}
	if reqID != "" {
		msg["id"] = reqID
	}
	return buildJSON(msg)
}
