package ws

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/permissions"
)

// registerChatHandlers registers all chat-related V2 message handlers.
func registerChatHandlers(r *HandlerRegistry, deps ChatDeps) {
	r.RegisterV2(MsgTypeChatSend, handleChatSendV2, deps)
	r.RegisterV2(MsgTypeChatEdit, handleChatEditV2, deps)
	r.RegisterV2(MsgTypeChatDelete, handleChatDeleteV2, deps)
}

// handleChatSendV2 processes a chat_send command.
func handleChatSendV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	sendCmd := cmd.(ChatSendCmd)
	userID := info.UserID
	channelID := sendCmd.ChannelID()

	// Rate limit.
	ratKey := fmt.Sprintf("chat:%d", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, chatRateLimit, chatWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many messages"}}
	}

	if channelID <= 0 {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "channel_id must be a positive integer"}}
	}

	ch, err := d.DB.GetChannel(channelID)
	if err != nil || ch == nil {
		return Result{Error: ClientError{Code: ErrCodeNotFound, Message: "channel not found"}}
	}

	isDM := ch.Type == "dm"

	// Permission check.
	if r := chatSendPermCheck(d, userID, channelID, isDM); r != nil {
		return *r
	}

	// Slow mode.
	if !isDM && ch.SlowMode > 0 && !hasPerm(d.DB, d.Permissions, userID, channelID, permissions.ManageMessages) {
		slowKey := fmt.Sprintf("slow:%d:%d", userID, channelID)
		if d.Limiter != nil && !d.Limiter.Allow(slowKey, 1, time.Duration(ch.SlowMode)*time.Second) {
			return Result{Error: ClientError{Code: ErrCodeSlowMode, Message: fmt.Sprintf("channel has %ds slow mode", ch.SlowMode)}}
		}
	}

	// Validate content — check raw length before sanitizing to prevent
	// CPU/memory amplification from huge payloads hitting bluemonday.
	rawContent := sendCmd.Content()
	attachmentIDs := sendCmd.Attachments()
	if len(rawContent) > maxMessageLen*4 {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "message content exceeds maximum length of 4000 characters"}}
	}
	content := sanitizer.Sanitize(rawContent)
	if content == "" && len(attachmentIDs) == 0 {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "message content cannot be empty"}}
	}
	if len([]rune(content)) > maxMessageLen {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "message content exceeds maximum length of 4000 characters"}}
	}

	// Attachment permission.
	if !isDM && len(attachmentIDs) > 0 {
		if r := requirePerm(d.DB, d.Permissions, userID, channelID, permissions.AttachFiles, "ATTACH_FILES"); r != nil {
			return *r
		}
	}

	// Persist message.
	msgID, err := d.DB.CreateMessage(channelID, userID, content, sendCmd.ReplyTo())
	if err != nil {
		slog.Error("ws handleChatSendV2 CreateMessage", "err", err)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to save message"}}
	}

	// Link attachments.
	var attData []map[string]any
	if len(attachmentIDs) > 0 {
		linked, linkErr := d.DB.LinkAttachmentsToMessage(msgID, attachmentIDs)
		if linkErr != nil {
			slog.Error("ws handleChatSendV2 LinkAttachments", "err", linkErr, "msg_id", msgID)
			if delErr := d.DB.DeleteMessage(msgID, userID, true); delErr != nil {
				slog.Error("ws handleChatSendV2 DeleteMessage (cleanup)", "err", delErr, "msg_id", msgID)
			}
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to send message with attachments"}}
		}
		if linked > 0 {
			attMap, attErr := d.DB.GetAttachmentsByMessageIDs([]int64{msgID})
			if attErr != nil {
				slog.Error("ws handleChatSendV2 GetAttachments", "err", attErr)
			} else {
				for _, ai := range attMap[msgID] {
					attData = append(attData, map[string]any{
						"id":       ai.ID,
						"filename": ai.Filename,
						"size":     ai.Size,
						"mime":     ai.Mime,
						"url":      ai.URL,
					})
				}
			}
		}
	}

	// Fetch message for timestamp.
	msg, err := d.DB.GetMessage(msgID)
	if err != nil || msg == nil {
		slog.Error("ws handleChatSendV2 GetMessage after create", "err", err)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to retrieve message"}}
	}

	slog.Debug("message sent", "user", info.Username, "channel_id", channelID, "msg_id", msgID)

	reply := buildChatSendOK(info.ReqID, msgID, msg.Timestamp)
	broadcast := buildChatMessage(msgID, channelID, userID, info.Username, info.Avatar, info.RoleName, content, msg.Timestamp, sendCmd.ReplyTo(), attData)

	if !isDM {
		return Result{
			Reply:  reply,
			Events: []Event{MessageSentChannelEvent{channelID: channelID, payload: broadcast}},
		}
	}

	// DM path: open DM for recipients, send dm_channel_open, then sequenced message.
	participantIDs, pErr := d.DB.GetDMParticipantIDs(channelID)
	if pErr != nil {
		slog.Error("ws handleChatSendV2 GetDMParticipantIDs", "err", pErr, "channel_id", channelID)
		// Message is saved; return the ACK but skip broadcast.
		return Result{Reply: reply}
	}

	var events []Event
	sender, _ := d.DB.GetUserByID(userID)
	for _, pid := range participantIDs {
		if pid == userID {
			continue
		}
		if openErr := d.DB.OpenDM(pid, channelID); openErr != nil {
			slog.Error("ws handleChatSendV2 OpenDM", "err", openErr, "recipient_id", pid, "channel_id", channelID)
			continue
		}
		if sender != nil {
			events = append(events, DMChannelOpenEvent{
				targetUserID: pid,
				payload:      buildDMChannelOpen(channelID, sender),
			})
		}
	}

	events = append(events, MessageSentDMEvent{
		channelID:      channelID,
		participantIDs: participantIDs,
		payload:        broadcast,
	})

	return Result{Reply: reply, Events: events}
}

// chatSendPermCheck validates send permission for DM and non-DM channels.
func chatSendPermCheck(d ChatDeps, userID, channelID int64, isDM bool) *Result {
	if isDM {
		ok, dmErr := d.DB.IsDMParticipant(userID, channelID)
		if dmErr != nil {
			slog.Error("ws chatSendPermCheck IsDMParticipant", "err", dmErr)
			r := Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to check DM participation"}}
			return &r
		}
		if !ok {
			r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "you are not a participant in this DM"}}
			return &r
		}
		recipient, recErr := d.DB.GetDMRecipient(channelID, userID)
		if recErr == nil && recipient != nil {
			blocked, blkErr := d.DB.IsEitherBlocked(userID, recipient.ID)
			if blkErr != nil {
				slog.Error("ws chatSendPermCheck IsEitherBlocked", "err", blkErr)
				r := Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to check block status"}}
				return &r
			}
			if blocked {
				r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "cannot send messages — user is blocked"}}
				return &r
			}
		}
		return nil
	}
	return requirePerm(d.DB, d.Permissions, userID, channelID, permissions.ReadMessages|permissions.SendMessages, "SEND_MESSAGES")
}

// handleChatEditV2 processes a chat_edit command.
func handleChatEditV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	editCmd := cmd.(ChatEditCmd)
	userID := info.UserID
	msgID := editCmd.MessageID()

	// Rate limit.
	ratKey := fmt.Sprintf("chat_edit:%d", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, chatRateLimit, chatWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many edits"}}
	}

	if msgID <= 0 {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "message_id must be positive integer"}}
	}

	// Validate content — check raw length before sanitizing to prevent
	// CPU/memory amplification from huge payloads hitting bluemonday.
	rawContent := editCmd.Content()
	if len(rawContent) > maxMessageLen*4 {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "message too long"}}
	}
	content := sanitizer.Sanitize(rawContent)
	if content == "" {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "content cannot be empty"}}
	}
	if len([]rune(content)) > maxMessageLen {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "message too long"}}
	}

	// Fetch message (opaque error to prevent IDOR).
	msg, err := d.DB.GetMessage(msgID)
	if err != nil || msg == nil {
		return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "cannot edit this message"}}
	}

	// BUG-126: Reject edits on soft-deleted messages.
	if msg.Deleted {
		return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "cannot edit this message"}}
	}

	// Channel type for DM-aware permissions.
	editCh, chErr := d.DB.GetChannel(msg.ChannelID)
	editIsDM := chErr == nil && editCh != nil && editCh.Type == "dm"

	if editIsDM {
		ok, dmErr := d.DB.IsDMParticipant(userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "cannot edit this message"}}
		}
	} else if !hasPerm(d.DB, d.Permissions, userID, msg.ChannelID, permissions.SendMessages) {
		return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "cannot edit this message"}}
	}

	// EditMessage checks ownership internally.
	if err := d.DB.EditMessage(msgID, userID, content); err != nil {
		return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "cannot edit this message"}}
	}

	// Re-fetch for updated edited_at timestamp.
	msg, err = d.DB.GetMessage(msgID)
	if err != nil || msg == nil {
		slog.Error("ws handleChatEditV2 GetMessage after edit", "err", err, "msg_id", msgID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "edit saved but broadcast failed"}}
	}

	editedAt := ""
	if msg.EditedAt != nil {
		editedAt = *msg.EditedAt
	}
	slog.Debug("message edited", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID)

	editedPayload := buildChatEdited(msgID, msg.ChannelID, content, editedAt)
	if editIsDM {
		participantIDs, pErr := d.DB.GetDMParticipantIDs(msg.ChannelID)
		if pErr != nil {
			slog.Error("handleChatEditV2 GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
			return Result{}
		}
		return Result{Events: []Event{MessageEditedDMEvent{
			channelID:      msg.ChannelID,
			participantIDs: participantIDs,
			payload:        editedPayload,
		}}}
	}
	return Result{Events: []Event{MessageEditedChannelEvent{
		channelID: msg.ChannelID,
		payload:   editedPayload,
	}}}
}

// handleChatDeleteV2 processes a chat_delete command.
func handleChatDeleteV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(ChatDeps)
	deleteCmd := cmd.(ChatDeleteCmd)
	userID := info.UserID
	msgID := deleteCmd.MessageID()

	// Rate limit.
	ratKey := fmt.Sprintf("chat_delete:%d", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, chatRateLimit, chatWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many deletes"}}
	}

	if msgID <= 0 {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "message_id must be positive integer"}}
	}

	// Fetch message (opaque error to prevent IDOR).
	msg, err := d.DB.GetMessage(msgID)
	if err != nil || msg == nil {
		return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "cannot delete this message"}}
	}

	// Channel type for DM-aware permissions.
	delCh, chErr := d.DB.GetChannel(msg.ChannelID)
	delIsDM := chErr == nil && delCh != nil && delCh.Type == "dm"

	if delIsDM {
		ok, dmErr := d.DB.IsDMParticipant(userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "cannot delete this message"}}
		}
	} else {
		// Mod override: ManageMessages allows deleting any message.
		// Own-message delete requires SendMessages (a muted user cannot delete).
		isMsgOwner := msg.UserID == userID
		canManage := hasPerm(d.DB, d.Permissions, userID, msg.ChannelID, permissions.ManageMessages)
		canDelete := canManage || (isMsgOwner && hasPerm(d.DB, d.Permissions, userID, msg.ChannelID, permissions.SendMessages))
		if !canDelete {
			return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "cannot delete this message"}}
		}
	}

	// In DMs, users can only delete their own messages (no mod override).
	isMod := !delIsDM && hasPerm(d.DB, d.Permissions, userID, msg.ChannelID, permissions.ManageMessages)
	if err := d.DB.DeleteMessage(msgID, userID, isMod); err != nil {
		return Result{Error: ClientError{Code: ErrCodeForbidden, Message: "cannot delete this message"}}
	}

	slog.Debug("message deleted", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID, "is_mod", isMod)
	_ = d.DB.LogAudit(userID, "message_delete", "message", msgID,
		fmt.Sprintf("channel %d, mod_action=%v", msg.ChannelID, isMod))

	deletedPayload := buildChatDeleted(msgID, msg.ChannelID)
	if delIsDM {
		participantIDs, pErr := d.DB.GetDMParticipantIDs(msg.ChannelID)
		if pErr != nil {
			slog.Error("handleChatDeleteV2 GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
			return Result{}
		}
		return Result{Events: []Event{MessageDeletedDMEvent{
			channelID:      msg.ChannelID,
			participantIDs: participantIDs,
			payload:        deletedPayload,
		}}}
	}
	return Result{Events: []Event{MessageDeletedChannelEvent{
		channelID: msg.ChannelID,
		payload:   deletedPayload,
	}}}
}
