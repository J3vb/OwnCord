package ws

import (
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// callSignalPayload carries an ephemeral DM call signal (call_incoming /
// call_declined). There is no call id: the call is presence in the DM's voice
// channel.
type callSignalPayload struct {
	ChannelID int64  `json:"channel_id"`
	FromUser  int64  `json:"from_user"`
	Username  string `json:"username"`
}

// buildDMChannelOpen constructs a dm_channel_open for one viewer. The payload is
// db.DMChannelInfo, the shape REST and ready carry. It is built per viewer
// because recipient/recipients are relative to the reader and each participant's
// status is the live one (presentDMStatuses), not the users.status row.
func buildDMChannelOpen(info db.DMChannelInfo, viewerID int64, liveStatus func(userID int64) string, liveMobile func(userID int64) bool) []byte {
	presented := presentDMStatuses([]db.DMChannelInfo{info}, viewerID, liveStatus)
	if liveMobile != nil {
		presentDMMobile(presented, liveMobile)
	}
	return buildJSON(wsMsg{
		Type:    MsgTypeDMChannelOpen,
		Payload: presented[0],
	})
}

// buildDMChannelOpenFor announces a 1:1 DM to the user on the other end. Returns
// nil if recipient is nil.
func buildDMChannelOpenFor(channelID int64, recipient *db.User, viewerID int64, liveStatus func(userID int64) string, liveMobile func(userID int64) bool) []byte {
	if recipient == nil {
		slog.Warn("buildDMChannelOpenFor called with nil recipient", "channel_id", channelID)
		return nil
	}
	avatarStr := ""
	if recipient.Avatar != nil {
		avatarStr = *recipient.Avatar
	}
	displayName := ""
	if recipient.DisplayName != nil {
		displayName = *recipient.DisplayName
	}
	other := db.DMUser{
		ID:          recipient.ID,
		Username:    recipient.Username,
		Avatar:      avatarStr,
		DisplayName: displayName,
	}
	return buildDMChannelOpen(db.DMChannelInfo{
		ChannelID:  channelID,
		Recipient:  other,
		Recipients: []db.DMUser{other},
	}, viewerID, liveStatus, liveMobile)
}

// dmRequestSenderPayload is the sender profile a dm_request carries, so the inbox
// renders without a second fetch; mirrors GET /api/v1/dm-requests.
type dmRequestSenderPayload struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Avatar      string `json:"avatar"`
}

// dmRequestPreviewPayload is the held message's preview, present only on creation.
type dmRequestPreviewPayload struct {
	MessageID int64  `json:"message_id"`
	Content   string `json:"content"`
	Timestamp string `json:"timestamp"`
}

type dmRequestPayload struct {
	ID        int64                    `json:"id"`
	State     string                   `json:"state"`
	ChannelID int64                    `json:"channel_id"`
	Sender    dmRequestSenderPayload   `json:"sender"`
	Preview   *dmRequestPreviewPayload `json:"preview"`
	CreatedAt string                   `json:"created_at"`
	DecidedAt *string                  `json:"decided_at"`
}

// buildDMRequest constructs a dm_request: sent once on creation (Preview set) and
// again with a new State on every transition (Preview nil); see DMRequestEvent.
func buildDMRequest(p dmRequestPayload) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeDMRequest,
		Payload: p,
	})
}

// buildDMRequestForCreation builds the creation-time dm_request for a staged
// request: req from service.SendMessageResult.RequestCreatedFor, sender from
// SenderUser, preview from RequestPreview.
func buildDMRequestForCreation(req *db.MessageRequest, sender *db.User, preview *service.DMRequestPreview) []byte {
	avatar := ""
	if sender.Avatar != nil {
		avatar = *sender.Avatar
	}
	displayName := ""
	if sender.DisplayName != nil {
		displayName = *sender.DisplayName
	}
	var previewPayload *dmRequestPreviewPayload
	if preview != nil {
		previewPayload = &dmRequestPreviewPayload{
			MessageID: preview.MessageID,
			Content:   preview.Content,
			Timestamp: preview.Timestamp,
		}
	}
	return buildDMRequest(dmRequestPayload{
		ID:        req.ID,
		State:     req.State,
		ChannelID: req.ChannelID,
		Sender: dmRequestSenderPayload{
			ID: sender.ID, Username: sender.Username,
			DisplayName: displayName, Avatar: avatar,
		},
		Preview:   previewPayload,
		CreatedAt: req.CreatedAt,
		DecidedAt: req.DecidedAt,
	})
}

func buildCallSignal(msgType string, channelID, fromUserID int64, username string) []byte {
	return buildJSON(wsMsg{
		Type: msgType,
		Payload: callSignalPayload{
			ChannelID: channelID,
			FromUser:  fromUserID,
			Username:  username,
		},
	})
}
