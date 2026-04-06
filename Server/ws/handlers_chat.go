package ws

import (
	"context"
	"errors"

	"github.com/owncord/server/service"
)

// registerChatHandlers registers all chat-related V2 message handlers.
func registerChatHandlers(r *HandlerRegistry, deps ChatDeps) {
	r.RegisterV2(MsgTypeChatSend, handleChatSendV2, deps)
	r.RegisterV2(MsgTypeChatEdit, handleChatEditV2, deps)
	r.RegisterV2(MsgTypeChatDelete, handleChatDeleteV2, deps)
}

// handleChatSendV2 processes a chat_send command via the MessageService.
func handleChatSendV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	sendCmd := cmd.(ChatSendCmd)

	result, err := d.MessageSvc.SendMessage(service.SendMessageParams{
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
	broadcast := buildChatMessage(result.MessageID, sendCmd.ChannelID(), info.UserID,
		info.Username, info.Avatar, info.RoleName, result.Content, result.Timestamp,
		sendCmd.ReplyTo(), attData)

	if !result.IsDM {
		return Result{
			Reply:  reply,
			Events: []Event{MessageSentChannelEvent{channelID: sendCmd.ChannelID(), payload: broadcast}},
		}
	}

	// DM path: build dm_channel_open events + sequenced message.
	var events []Event
	if result.SenderUser != nil {
		for _, pid := range result.OpenedDMFor {
			events = append(events, DMChannelOpenEvent{
				targetUserID: pid,
				payload:      buildDMChannelOpen(sendCmd.ChannelID(), result.SenderUser),
			})
		}
	}

	events = append(events, MessageSentDMEvent{
		channelID:      sendCmd.ChannelID(),
		participantIDs: result.ParticipantIDs,
		payload:        broadcast,
	})

	return Result{Reply: reply, Events: events}
}

// handleChatEditV2 processes a chat_edit command via the MessageService.
func handleChatEditV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	editCmd := cmd.(ChatEditCmd)

	result, err := d.MessageSvc.EditMessage(info.UserID, editCmd.MessageID(), editCmd.Content())
	if err != nil {
		return serviceErrorToResult(err)
	}

	editedPayload := buildChatEdited(result.MessageID, result.ChannelID, result.Content, result.EditedAt)
	if result.IsDM {
		return Result{Events: []Event{MessageEditedDMEvent{
			channelID:      result.ChannelID,
			participantIDs: result.ParticipantIDs,
			payload:        editedPayload,
		}}}
	}
	return Result{Events: []Event{MessageEditedChannelEvent{
		channelID: result.ChannelID,
		payload:   editedPayload,
	}}}
}

// handleChatDeleteV2 processes a chat_delete command via the MessageService.
func handleChatDeleteV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	deleteCmd := cmd.(ChatDeleteCmd)

	result, err := d.MessageSvc.DeleteMessage(info.UserID, deleteCmd.MessageID())
	if err != nil {
		return serviceErrorToResult(err)
	}

	deletedPayload := buildChatDeleted(result.MessageID, result.ChannelID)
	if result.IsDM {
		return Result{Events: []Event{MessageDeletedDMEvent{
			channelID:      result.ChannelID,
			participantIDs: result.ParticipantIDs,
			payload:        deletedPayload,
		}}}
	}
	return Result{Events: []Event{MessageDeletedChannelEvent{
		channelID: result.ChannelID,
		payload:   deletedPayload,
	}}}
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
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: err.Error()}}
	}
}
