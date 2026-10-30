package ws

import (
	"context"
	"errors"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// registerChatHandlers registers all chat-related V2 message handlers.
func registerChatHandlers(r *HandlerRegistry, deps ChatDeps) {
	r.RegisterV2(MsgTypeChatSend, handleChatSendV2, deps)
	r.RegisterV2(MsgTypeChatForward, handleChatForwardV2, deps)
	r.RegisterV2(MsgTypeForumPostCreate, handleForumPostCreateV2, deps)
	registerPollHandlers(r, deps)
	r.RegisterV2(MsgTypeChatEdit, handleChatEditV2, deps)
	r.RegisterV2(MsgTypeChatDelete, handleChatDeleteV2, deps)
}

// handleChatSendV2 processes a chat_send command via the MessageService.
func handleChatSendV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	sendCmd := cmd.(ChatSendCmd)

	result, err := d.MessageSvc.SendMessage(ctx, service.SendMessageParams{
		ClientMessageID: sendCmd.ClientMessageID,
		ChannelID:       sendCmd.ChannelID,
		UserID:          info.UserID,
		Username:        info.Username,
		Avatar:          info.Avatar,
		RoleName:        info.RoleName,
		Content:         sendCmd.Content,
		ReplyTo:         sendCmd.ReplyTo,
		ReplyPing:       sendCmd.ReplyPing,
		AttachmentIDs:   sendCmd.Attachments(),
		StickerID:       sendCmd.StickerID,
	})
	if err != nil {
		return serviceErrorToResult(err)
	}
	reply := buildChatSendOK(info.ReqID, result.MessageID, result.Timestamp, sendCmd.ClientMessageID, result.Duplicate, result.SkippedAttachmentIDs)
	if result.Duplicate {
		return Result{Reply: reply}
	}

	return sendResultEvents(d, info, sendCmd.ClientMessageID, sendCmd.ChannelID, sendCmd.ReplyTo, reply, result)
}

// sendResultEvents turns a committed SendMessageResult into the ws Result both
// chat_send and chat_forward return: the reply, then the sequenced chat_message
// for the channel or, for a DM, the dm_channel_open and dm_request events and
// the participant-addressed chat_message. Sharing it is what makes a forward's
// fan-out literally the send path's.
func sendResultEvents(d ChatDeps, info ClientInfo, clientMessageID string, channelID int64, replyTo *int64, reply []byte, result *service.SendMessageResult) Result {
	attData := make([]map[string]any, 0, len(result.Attachments))
	for _, ai := range result.Attachments {
		attData = append(attData, map[string]any{
			"id":       ai.ID,
			"filename": ai.Filename,
			"size":     ai.Size,
			"mime":     ai.Mime,
			"url":      ai.URL,
		})
	}

	broadcast := buildChatMessage(chatMessageArgs{
		ClientMessageID:   clientMessageID,
		MsgID:             result.MessageID,
		ChannelID:         channelID,
		UserID:            info.UserID,
		Username:          info.Username,
		Avatar:            info.Avatar,
		DisplayName:       info.DisplayName,
		RoleName:          info.RoleName,
		Content:           result.Content,
		Timestamp:         result.Timestamp,
		ReplyTo:           replyTo,
		Attachments:       attData,
		Mentions:          result.Mentions,
		MentionRoles:      result.MentionRoles,
		MentionsEveryone:  result.MentionsEveryone,
		MentionsHere:      result.MentionsHere,
		ReferencedMessage: result.ReferencedMessage,
		Forward:           result.Forward,
		Poll:              result.Poll,
		Sticker:           result.Sticker,
	})

	if !result.IsDM {
		return channelSendResult(reply, broadcast, channelID, info.UserID, result)
	}

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
					db.NewDMChannelInfo(channelID, chName, result.DMIsGroup, result.DMOwnerID, result.DMIconID, result.DMParticipants, pid), pid, d.LiveStatus)
			} else {
				openPayload = buildDMChannelOpenFor(channelID, result.SenderUser, pid, d.LiveStatus)
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

	// one dm_request per recipient a first-contact request was just
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
		dmEvt{evType: MsgTypeChatMessage, channelID: channelID, participantIDs: result.ParticipantIDs, payload: broadcast},
		channelEvt{evType: MsgTypeChatMessage, channelID: channelID, payload: broadcast},
		result.ParticipantIDs))

	return Result{Reply: reply, Events: events}
}

// handleChatForwardV2 processes a chat_forward command via the
// MessageService. The reply is chat_forward_ok; the events are the send path's.
func handleChatForwardV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	fwd := cmd.(ChatForwardCmd)

	result, err := d.MessageSvc.ForwardMessage(ctx, service.ForwardParams{
		ClientMessageID: fwd.ClientMessageID,
		UserID:          info.UserID,
		Username:        info.Username,
		TargetChannelID: fwd.ChannelID,
		SourceMessageID: fwd.MessageID,
	})
	if err != nil {
		return serviceErrorToResult(err)
	}
	reply := buildChatForwardOK(info.ReqID, result.MessageID, fwd.ChannelID, fwd.ClientMessageID, result.Duplicate)
	if result.Duplicate {
		return Result{Reply: reply}
	}
	return sendResultEvents(d, info, fwd.ClientMessageID, fwd.ChannelID, nil, reply, result)
}

// handleForumPostCreateV2 processes a forum_post_create via the
// MessageService. The reply is forum_post_create_ok; the events are the send
// path's, addressed to the new post's thread: its opening chat_message, and a
// thread note that tells the forum's viewers (thread_changed, coalesced). A
// retry answered from the receipt announces nothing.
func handleForumPostCreateV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	post := cmd.(ForumPostCreateCmd)

	res, err := d.MessageSvc.CreateForumPost(ctx, service.ForumPostParams{
		ClientMessageID: post.ClientMessageID, ChannelID: post.ChannelID, UserID: info.UserID,
		Username: info.Username, Name: post.Name, Content: post.Content,
		AttachmentIDs: post.Attachments(), TagIDs: post.TagIDs,
	})
	if err != nil {
		return serviceErrorToResult(err)
	}
	var skipped []string
	if res.Send != nil {
		skipped = res.Send.SkippedAttachmentIDs
	}
	reply := buildForumPostCreateOK(info.ReqID, res.Thread, res.MessageID, post.ClientMessageID, res.Duplicate, skipped)
	if res.Duplicate {
		return Result{Reply: reply}
	}
	return sendResultEvents(d, info, post.ClientMessageID, res.Thread.ID, nil, reply, res.Send)
}

// channelSendResult is a committed non-DM send: the sequenced chat_message,
// then the note the channel_activity coalescer records.
func channelSendResult(reply, broadcast []byte, channelID, authorID int64, result *service.SendMessageResult) Result {
	events := []Event{
		channelEvt{evType: MsgTypeChatMessage, channelID: channelID, payload: broadcast},
		channelActivityEvt{
			channelID: channelID, msgID: result.MessageID, authorID: authorID,
			mentions: result.Mentions, roleUsers: result.RoleUserIDs, everyone: result.MentionsEveryone, hereOnly: result.MentionsHere,
		},
	}
	if result.Channel != nil && result.Channel.IsThread() {
		// The post moved the thread's count and last activity, and reopened it
		// if it was archived: tell the parent's viewers (coalesced).
		events = append(events, threadNoteEvt{threadID: channelID})
	}
	return Result{Reply: reply, Events: events}
}

// handleChatEditV2 processes a chat_edit command via the MessageService.
func handleChatEditV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	editCmd := cmd.(ChatEditCmd)

	result, err := d.MessageSvc.EditMessage(ctx, info.UserID, editCmd.MessageID, editCmd.Content)
	if err != nil {
		return serviceErrorToResult(err)
	}

	editedPayload := buildChatEdited(result.MessageID, result.ChannelID, result.Content, result.EditedAt,
		result.Mentions, result.MentionRoles, result.MentionsEveryone, result.MentionsHere)
	if result.IsDM {
		return Result{Events: []Event{dmEventOrFallback(
			dmEvt{evType: MsgTypeChatEdited, channelID: result.ChannelID, participantIDs: result.ParticipantIDs, payload: editedPayload},
			channelEvt{evType: MsgTypeChatEdited, channelID: result.ChannelID, payload: editedPayload},
			result.ParticipantIDs)}}
	}
	events := []Event{channelEvt{
		evType:    MsgTypeChatEdited,
		channelID: result.ChannelID,
		payload:   editedPayload,
	}}
	if result.PostOpening {
		// A forum post's opening message is the list's preview: the forum's
		// viewers hear the new text as a thread_changed (coalesced).
		events = append(events, threadNoteEvt{threadID: result.ChannelID})
	}
	return Result{Events: events}
}

// handleChatDeleteV2 processes a chat_delete command via the MessageService.
func handleChatDeleteV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	deleteCmd := cmd.(ChatDeleteCmd)

	result, err := d.MessageSvc.DeleteMessage(ctx, info.UserID, deleteCmd.MessageID)
	if err != nil {
		return serviceErrorToResult(err)
	}

	deletedPayload := buildChatDeleted(result.MessageID, result.ChannelID)
	if result.IsDM {
		return Result{Events: []Event{dmEventOrFallback(
			dmEvt{evType: MsgTypeChatDeleted, channelID: result.ChannelID, participantIDs: result.ParticipantIDs, payload: deletedPayload},
			channelEvt{evType: MsgTypeChatDeleted, channelID: result.ChannelID, payload: deletedPayload},
			result.ParticipantIDs)}}
	}
	events := []Event{channelEvt{
		evType:    MsgTypeChatDeleted,
		channelID: result.ChannelID,
		payload:   deletedPayload,
	}}
	if result.IsThread {
		// The delete moved the thread's count and last message: tell the
		// parent's viewers (coalesced).
		events = append(events, threadNoteEvt{threadID: result.ChannelID})
	}
	return Result{Events: events}
}

// dmEventOrFallback returns the participant-targeted DM event, falling back to the
// channel-topic broadcast when the participant list is empty (the shape a failed
// post-commit participant lookup leaves). A sequenced frame addressed to nobody would
// consume a seq and reach no one; the fallback still reaches whoever has the DM focused.
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
	case errors.Is(err, service.ErrAttachmentsUnavailable):
		return Result{Error: ClientError{Code: ErrCodeAttachmentsUnavailable, Message: err.Error()}}
	case errors.Is(err, service.ErrReactionLimit):
		return Result{Error: ClientError{Code: ErrCodeReactionLimit, Message: err.Error()}}
	case errors.Is(err, service.ErrPollEnded):
		return Result{Error: ClientError{Code: ErrCodePollEnded, Message: err.Error()}}
	case errors.Is(err, service.ErrStickerNotFound):
		return Result{Error: ClientError{Code: ErrCodeStickerNotFound, Message: err.Error()}}
	case errors.Is(err, service.ErrBadRequest):
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: err.Error()}}
	case errors.Is(err, service.ErrNotFound):
		return Result{Error: ClientError{Code: ErrCodeNotFound, Message: err.Error()}}
	case errors.Is(err, service.ErrTimedOut):
		return Result{Error: ClientError{Code: ErrCodeTimedOut, Message: err.Error()}}
	case errors.Is(err, service.ErrCallNeedsAcceptance):
		return Result{Error: ClientError{Code: ErrCodeCallRequiresAcceptance, Message: err.Error()}}
	case errors.Is(err, permissions.ErrThreadLocked):
		// A locked thread refuses a post, reaction, pin or change
		// with its own code; it wraps ErrForbidden, so this precedes it.
		return Result{Error: ClientError{Code: ErrCodeThreadLocked, Message: err.Error()}}
	case errors.Is(err, service.ErrForbidden), errors.Is(err, service.ErrBlocked):
		return Result{Error: ClientError{Code: ErrCodeForbidden, Message: err.Error()}}
	case errors.Is(err, service.ErrDeletedMessage):
		// Same state as REST's 409 ALREADY_DELETED, not a permission refusal.
		return Result{Error: ClientError{Code: ErrCodeAlreadyDeleted, Message: err.Error()}}
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
