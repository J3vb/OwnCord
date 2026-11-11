package ws

import (
	"context"
	"errors"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

func registerChatHandlers(r *HandlerRegistry, deps ChatDeps) {
	r.RegisterV2(MsgTypeChatSend, handleChatSendV2, deps)
	r.RegisterV2(MsgTypeChatForward, handleChatForwardV2, deps)
	r.RegisterV2(MsgTypeForumPostCreate, handleForumPostCreateV2, deps)
	registerPollHandlers(r, deps)
	r.RegisterV2(MsgTypeChatEdit, handleChatEditV2, deps)
	r.RegisterV2(MsgTypeChatDelete, handleChatDeleteV2, deps)
}

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

// sendResultEvents turns a committed send into the Result chat_send and
// chat_forward share: the reply, then the sequenced chat_message (or, for a DM,
// dm_channel_open, dm_request and the participant-addressed message), so a
// forward's fan-out is the send path's.
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
		// One payload per recipient: `recipient` and `recipients` are relative to
		// the reader, so a shared payload would list a group member as their own
		// DM partner.
		chName := ""
		if result.Channel != nil {
			chName = result.Channel.Name
		}
		for _, pid := range result.OpenedDMFor {
			var openPayload []byte
			if len(result.DMParticipants) > 0 {
				openPayload = buildDMChannelOpen(
					db.NewDMChannelInfo(channelID, chName, result.DMIsGroup, result.DMOwnerID, result.DMIconID, result.DMParticipants, pid), pid, d.LiveStatus, d.LiveMobile)
			} else {
				openPayload = buildDMChannelOpenFor(channelID, result.SenderUser, pid, d.LiveStatus, d.LiveMobile)
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

	// One dm_request per recipient of a first-contact request. Skipped when the
	// sender lookup failed (no profile to carry); the recipient recovers it from
	// GET /api/v1/dm-requests.
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

// handleForumPostCreateV2 replies forum_post_create_ok; the events are the send
// path's, addressed to the new thread: its opening chat_message and a coalesced
// thread note for the forum's viewers. A retry answered from the receipt
// announces nothing.
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

func channelSendResult(reply, broadcast []byte, channelID, authorID int64, result *service.SendMessageResult) Result {
	events := []Event{
		channelEvt{evType: MsgTypeChatMessage, channelID: channelID, payload: broadcast},
		channelActivityEvt{
			channelID: channelID, msgID: result.MessageID, authorID: authorID,
			mentions: result.Mentions, roleUsers: result.RoleUserIDs, everyone: result.MentionsEveryone, hereOnly: result.MentionsHere,
		},
	}
	if result.Channel != nil && result.Channel.IsThread() {
		// The post moved the thread's count and last activity (and reopened it if
		// archived): tell the parent's viewers (coalesced).
		events = append(events, threadNoteEvt{threadID: channelID})
	}
	return Result{Reply: reply, Events: events}
}

func handleChatEditV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	editCmd := cmd.(ChatEditCmd)

	result, err := d.MessageSvc.EditMessage(ctx, info.UserID, editCmd.MessageID, editCmd.Content)
	if err != nil {
		return serviceErrorToResult(err)
	}

	return Result{Events: chatEditedEvents(result)}
}

func chatEditedEvents(result *service.EditMessageResult) []Event {
	payload := buildChatEdited(result.MessageID, result.ChannelID, result.Content, result.EditedAt,
		result.Mentions, result.MentionRoles, result.MentionsEveryone, result.MentionsHere)
	return editedFrameEvents(payload, result.ChannelID, result.IsDM, result.ParticipantIDs, result.PostOpening)
}

// editedFrameEvents addresses one chat_edited payload to a DM's participants
// (topic only when the list is empty) or the channel plus, for a forum post's
// opening message, a coalesced thread note. Edits and file removals share it so
// they reach the same readers.
func editedFrameEvents(payload []byte, channelID int64, isDM bool, participantIDs []int64, postOpening bool) []Event {
	if isDM {
		return []Event{dmEventOrFallback(
			dmEvt{evType: MsgTypeChatEdited, channelID: channelID, participantIDs: participantIDs, payload: payload},
			channelEvt{evType: MsgTypeChatEdited, channelID: channelID, payload: payload},
			participantIDs)}
	}
	events := []Event{channelEvt{evType: MsgTypeChatEdited, channelID: channelID, payload: payload}}
	if postOpening {
		// A forum post's opening message is the list's preview: the forum's
		// viewers hear the new text as a thread_changed.
		events = append(events, threadNoteEvt{threadID: channelID})
	}
	return events
}

func handleChatDeleteV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	deleteCmd := cmd.(ChatDeleteCmd)

	result, err := d.MessageSvc.DeleteMessage(ctx, info.UserID, deleteCmd.MessageID)
	if err != nil {
		return serviceErrorToResult(err)
	}

	return Result{Events: chatDeletedEvents(result)}
}

func chatDeletedEvents(result *service.DeleteMessageResult) []Event {
	payload := buildChatDeleted(result.MessageID, result.ChannelID)
	if result.IsDM {
		return []Event{dmEventOrFallback(
			dmEvt{evType: MsgTypeChatDeleted, channelID: result.ChannelID, participantIDs: result.ParticipantIDs, payload: payload},
			channelEvt{evType: MsgTypeChatDeleted, channelID: result.ChannelID, payload: payload},
			result.ParticipantIDs)}
	}
	events := []Event{channelEvt{evType: MsgTypeChatDeleted, channelID: result.ChannelID, payload: payload}}
	if result.IsThread {
		// The delete moved the thread's count and last message: tell the parent's
		// viewers (coalesced).
		events = append(events, threadNoteEvt{threadID: result.ChannelID})
	}
	return events
}

// dmEventOrFallback returns the participant-targeted DM event, falling back to
// the channel-topic broadcast when the participant list is empty (a failed post-
// commit lookup): a sequenced frame addressed to nobody would consume a seq and
// reach no one.
func dmEventOrFallback(dmEvent, fallback Event, participantIDs []int64) Event {
	if len(participantIDs) == 0 {
		return fallback
	}
	return dmEvent
}

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
		// A locked thread refuses with its own code; it wraps ErrForbidden, so
		// this precedes it.
		return Result{Error: ClientError{Code: ErrCodeThreadLocked, Message: err.Error()}}
	case errors.Is(err, service.ErrForbidden), errors.Is(err, service.ErrBlocked):
		return Result{Error: ClientError{Code: ErrCodeForbidden, Message: err.Error()}}
	case errors.Is(err, service.ErrDeletedMessage):
		// Same state as REST's 409 ALREADY_DELETED, not a permission refusal.
		return Result{Error: ClientError{Code: ErrCodeAlreadyDeleted, Message: err.Error()}}
	case errors.Is(err, service.ErrConflict):
		return Result{Error: ClientError{Code: ErrCodeConflict, Message: err.Error()}}
	default:
		// Internal errors (service.ErrInternal embeds the driver error via %v)
		// must not reach the client verbatim, like REST's writeServiceError.
		// Logged here because handlers.go skips logging for ClientError results.
		slog.Error("ws service internal error", "err", err)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "internal error"}}
	}
}
