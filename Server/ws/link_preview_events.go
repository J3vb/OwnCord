package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/linkwire"
)

// LinkPreviewUpdate is a message whose link cards the server just built or cleared. A DM
// names its participants; a channel message leaves them empty and goes to the channel topic.
type LinkPreviewUpdate struct {
	MessageID      int64
	ChannelID      int64
	IsDM           bool
	ParticipantIDs []int64
	// Version is the message's content version (edited_at, else timestamp) the cards were
	// built for; a client keeps the frame with the newest.
	Version string
	Cards   []linkwire.Card
}

// messageLinkPreviewsPayload is the message_link_previews frame. link_previews is always an
// array: an empty one tells clients to drop the cards they hold.
type messageLinkPreviewsPayload struct {
	MessageID    int64           `json:"message_id"`
	ChannelID    int64           `json:"channel_id"`
	Version      string          `json:"content_version"`
	LinkPreviews []linkwire.Card `json:"link_previews"`
}

func buildMessageLinkPreviews(u LinkPreviewUpdate) []byte {
	cards := u.Cards
	if cards == nil {
		cards = []linkwire.Card{}
	}
	return buildJSON(wsMsg{
		Type:    MsgTypeMessageLinkPreviews,
		Payload: messageLinkPreviewsPayload{MessageID: u.MessageID, ChannelID: u.ChannelID, Version: u.Version, LinkPreviews: cards},
	})
}

// messageLinkPreviewsEvent addresses the frame to a DM's participants, or to the channel's
// readers, the same audience a chat_edited for the message reaches. A DM with no participant
// list is not sent: the channel topic could reach someone the first-contact gate holds back.
func messageLinkPreviewsEvent(u LinkPreviewUpdate) (Event, bool) {
	payload := buildMessageLinkPreviews(u)
	if !u.IsDM {
		return channelEvt{evType: MsgTypeMessageLinkPreviews, channelID: u.ChannelID, payload: payload}, true
	}
	if len(u.ParticipantIDs) == 0 {
		return nil, false
	}
	return dmEvt{evType: MsgTypeMessageLinkPreviews, channelID: u.ChannelID, participantIDs: u.ParticipantIDs, payload: payload}, true
}

// LinkPreviewsChanged delivers a message_link_previews frame, sequenced like chat_edited so a
// client that was offline replays it. ctx is the unfurl worker's, detached from any send.
func (h *Hub) LinkPreviewsChanged(ctx context.Context, u LinkPreviewUpdate) {
	ev, ok := messageLinkPreviewsEvent(u)
	if !ok {
		return
	}
	h.EmitEvents(ctx, []Event{ev})
}
