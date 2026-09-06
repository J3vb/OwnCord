package ws

import (
	"context"
	"errors"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// registerChatHandlers registers all chat-related V2 message handlers.
func registerChatHandlers(r *HandlerRegistry, deps ChatDeps) {
	r.RegisterV2(MsgTypeChatSend, handleChatSendV2, deps)
	r.RegisterV2(MsgTypeChatEdit, handleChatEditV2, deps)
	r.RegisterV2(MsgTypeChatDelete, handleChatDeleteV2, deps)
}

// handleChatSendV2 processes a chat_send command via the MessageService.
func handleChatSendV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	sendCmd := cmd.(ChatSendCmd)

	result, err := d.MessageSvc.SendMessage(ctx, service.SendMessageParams{
		ChannelID:     sendCmd.ChannelID(),
		UserID:        info.UserID,
		Username:      info.Username,
		Avatar:        info.Avatar,
		RoleName:      info.RoleName,
		Content:       sendCmd.Content(),
		ReplyTo:       sendCmd.ReplyTo(),
		AttachmentIDs: sendCmd.Attachments(),
	})
	if err != nil {
		return serviceErrorToResult(err)
	}

	// Build attachment data for broadcast.
	var attData []map[string]any
	for _, ai := range result.Attachments {
		attData = append(attData, map[string]any{
			"id":       ai.ID,
			"filename": ai.Filename,
			"size":     ai.Size,
			"mime":     ai.Mime,
			"url":      ai.URL,
		})
	}

	reply := buildChatSendOK(info.ReqID, result.MessageID, result.Timestamp)
	broadcast := buildChatMessage(chatMessageArgs{
		MsgID:            result.MessageID,
		ChannelID:        sendCmd.ChannelID(),
		UserID:           info.UserID,
		Username:         info.Username,
		Avatar:           info.Avatar,
		DisplayName:      info.DisplayName,
		RoleName:         info.RoleName,
		Content:          result.Content,
		Timestamp:        result.Timestamp,
		ReplyTo:          sendCmd.ReplyTo(),
		Attachments:      attData,
		Mentions:         result.Mentions,
		MentionsEveryone: result.MentionsEveryone,
		MentionsHere:     result.MentionsHere,
	})

	if !result.IsDM {
		return Result{
			Reply:  reply,
			Events: []Event{MessageSentChannelEvent{channelID: sendCmd.ChannelID(), payload: broadcast}},
		}
	}

	// DM path: build dm_channel_open events + sequenced message.
	var events []Event
	if len(result.OpenedDMFor) > 0 {
		// One payload per recipient, not one for all of them: `recipient` and
		// `recipients` are defined relative to who is reading, so a shared
		// payload would list a group member as their own DM partner.
		chName := ""
		if result.Channel != nil {
			chName = result.Channel.Name
		}
		for _, pid := range result.OpenedDMFor {
			var openPayload []byte
			if len(result.DMParticipants) > 0 {
				openPayload = buildDMChannelOpen(
					db.NewDMChannelInfo(sendCmd.ChannelID(), chName, result.DMIsGroup, result.DMParticipants, pid))
			} else {
				openPayload = buildDMChannelOpenFor(sendCmd.ChannelID(), result.SenderUser, pid)
			}
			if openPayload == nil {
				continue
			}
			events = append(events, DMChannelOpenEvent{
				targetUserID: pid,
				payload:      openPayload,
			})
		}
	}

	// B5-6: one dm_request per recipient a first-contact request was just
	// created for. Skipped (not a fallback shape) when the sender lookup
	// failed — SenderUser nil means the frame has no profile to carry, and
	// the recipient still recovers the request from GET /api/v1/dm-requests.
	if result.SenderUser != nil {
		for _, req := range result.RequestCreatedFor {
			events = append(events, DMRequestEvent{
				targetUserID: req.RecipientID,
				payload:      buildDMRequestForCreation(req, result.SenderUser, result.RequestPreview),
			})
		}
	}

	events = append(events, dmEventOrFallback(
		MessageSentDMEvent{channelID: sendCmd.ChannelID(), participantIDs: result.ParticipantIDs, payload: broadcast},
		MessageSentChannelEvent{channelID: sendCmd.ChannelID(), payload: broadcast},
		result.ParticipantIDs))

	return Result{Reply: reply, Events: events}
}

// handleChatEditV2 processes a chat_edit command via the MessageService.
func handleChatEditV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	editCmd := cmd.(ChatEditCmd)

	result, err := d.MessageSvc.EditMessage(ctx, info.UserID, editCmd.MessageID(), editCmd.Content())
	if err != nil {
		return serviceErrorToResult(err)
	}

	editedPayload := buildChatEdited(result.MessageID, result.ChannelID, result.Content, result.EditedAt,
		result.Mentions, result.MentionsEveryone, result.MentionsHere)
	if result.IsDM {
		return Result{Events: []Event{dmEventOrFallback(
			MessageEditedDMEvent{channelID: result.ChannelID, participantIDs: result.ParticipantIDs, payload: editedPayload},
			MessageEditedChannelEvent{channelID: result.ChannelID, payload: editedPayload},
			result.ParticipantIDs)}}
	}
	return Result{Events: []Event{MessageEditedChannelEvent{
		channelID: result.ChannelID,
		payload:   editedPayload,
	}}}
}

// handleChatDeleteV2 processes a chat_delete command via the MessageService.
func handleChatDeleteV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	deleteCmd := cmd.(ChatDeleteCmd)

	result, err := d.MessageSvc.DeleteMessage(ctx, info.UserID, deleteCmd.MessageID())
	if err != nil {
		return serviceErrorToResult(err)
	}

	deletedPayload := buildChatDeleted(result.MessageID, result.ChannelID)
	if result.IsDM {
		return Result{Events: []Event{dmEventOrFallback(
			MessageDeletedDMEvent{channelID: result.ChannelID, participantIDs: result.ParticipantIDs, payload: deletedPayload},
			MessageDeletedChannelEvent{channelID: result.ChannelID, payload: deletedPayload},
			result.ParticipantIDs)}}
	}
	return Result{Events: []Event{MessageDeletedChannelEvent{
		channelID: result.ChannelID,
		payload:   deletedPayload,
	}}}
}

// dmEventOrFallback returns the participant-targeted DM event, falling back
// to the channel-topic broadcast when the participant list is empty — the
// degraded shape a failed post-commit GetDMParticipantIDs leaves behind. A
// sequenced frame addressed to nobody would consume a seq and reach no one;
// the topic fallback still reaches whoever has the DM focused.
func dmEventOrFallback(dmEvent, fallback Event, participantIDs []int64) Event {
	if len(participantIDs) == 0 {
		return fallback
	}
	return dmEvent
}

// serviceErrorToResult converts a service-layer error to a WS Result.
func serviceErrorToResult(err error) Result {
	switch {
	case errors.Is(err, service.ErrRateLimited):
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: err.Error()}}
	case errors.Is(err, service.ErrSlowMode):
		return Result{Error: ClientError{Code: ErrCodeSlowMode, Message: err.Error()}}
	case errors.Is(err, service.ErrBadRequest):
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: err.Error()}}
	case errors.Is(err, service.ErrNotFound):
		return Result{Error: ClientError{Code: ErrCodeNotFound, Message: err.Error()}}
	case errors.Is(err, service.ErrForbidden), errors.Is(err, service.ErrBlocked),
		errors.Is(err, service.ErrDeletedMessage):
		return Result{Error: ClientError{Code: ErrCodeForbidden, Message: err.Error()}}
	case errors.Is(err, service.ErrConflict):
		return Result{Error: ClientError{Code: ErrCodeConflict, Message: err.Error()}}
	default:
		// Internal errors (service.ErrInternal wrappers embed the underlying
		// driver error via %v) must not reach the client verbatim, matching
		// the REST twin writeServiceError (Server/api/channel_handler.go) and
		// every other ErrCodeInternal site in this package. Log server-side
		// since this is the only ErrCodeInternal path whose caller
		// (handlers.go) skips its own logging for ClientError results.
		slog.Error("ws service internal error", "err", err)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "internal error"}}
	}
}
