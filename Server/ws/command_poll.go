package ws

import (
	"encoding/json"
	"fmt"
)

// PollAnswerCmd is one answer of a poll_create. Emoji is "" for none.
type PollAnswerCmd struct {
	Text  string
	Emoji string
}

// PollCreateCmd represents a poll_create message (WP 6.9b): post a poll as a
// message in ChannelID. The text fields are raw; the service sanitises and
// bounds them.
type PollCreateCmd struct {
	userID           int64
	ReqID            string
	ClientMessageID  string
	ChannelID        int64
	Question         string
	Answers          []PollAnswerCmd
	DurationHours    int
	AllowMultiselect bool
}

func (c PollCreateCmd) Type() string  { return MsgTypePollCreate }
func (c PollCreateCmd) UserID() int64 { return c.userID }

// maxPollAnswerFrames bounds the answers array a frame may carry before the
// service counts them, so a hostile frame cannot make the parser build a huge
// slice. The real cap (10) is the service's.
const maxPollAnswerFrames = 64

// parsePollCreate is the poll_create entry of commandConstructors. The channel
// id must be a positive integer and client_message_id is required (the service
// validates its shape), since a poll is only ever retried by receipt.
func parsePollCreate(userID int64, reqID string, raw json.RawMessage) (Command, error) {
	var p struct {
		ClientMessageID string      `json:"client_message_id"`
		ChannelID       json.Number `json:"channel_id"`
		Question        string      `json:"question"`
		Answers         []struct {
			Text  string  `json:"text"`
			Emoji *string `json:"emoji"`
		} `json:"answers"`
		DurationHours    json.Number `json:"duration_hours"`
		AllowMultiselect bool        `json:"allow_multiselect"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid poll_create payload: %w", err)
	}
	chID, err := p.ChannelID.Int64()
	if err != nil || chID <= 0 {
		return nil, fmt.Errorf("channel_id must be a positive integer")
	}
	if p.ClientMessageID == "" {
		return nil, fmt.Errorf("client_message_id is required")
	}
	hours, err := p.DurationHours.Int64()
	if err != nil || hours < 0 || hours > 1<<20 {
		return nil, fmt.Errorf("duration_hours must be an integer")
	}
	if len(p.Answers) > maxPollAnswerFrames {
		return nil, fmt.Errorf("too many answers")
	}
	answers := make([]PollAnswerCmd, len(p.Answers))
	for i, a := range p.Answers {
		answers[i].Text = a.Text
		if a.Emoji != nil {
			answers[i].Emoji = *a.Emoji
		}
	}
	return PollCreateCmd{
		userID: userID, ReqID: reqID, ClientMessageID: p.ClientMessageID, ChannelID: chID,
		Question: p.Question, Answers: answers, DurationHours: int(hours), AllowMultiselect: p.AllowMultiselect,
	}, nil
}

type pollCreateOKPayload struct {
	MessageID       int64  `json:"message_id"`
	ChannelID       int64  `json:"channel_id"`
	ClientMessageID string `json:"client_message_id"`
	Deduplicated    bool   `json:"deduplicated"`
}

// buildPollCreateOK answers a poll_create: the id of the new message.
// deduplicated is true when a retry was answered from the receipt and nothing
// new was posted.
func buildPollCreateOK(requestID string, msgID, channelID int64, clientMessageID string, duplicate bool) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypePollCreateOK,
		ID:   requestID,
		Payload: pollCreateOKPayload{
			MessageID: msgID, ChannelID: channelID, ClientMessageID: clientMessageID, Deduplicated: duplicate,
		},
	})
}
