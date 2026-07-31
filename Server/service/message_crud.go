package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/telemetry"
)

// SendMessage validates, persists, and prepares broadcast data for a new message.
// Callers are responsible for emitting the appropriate events.
func (s *MessageService) SendMessage(ctx context.Context, p SendMessageParams) (*SendMessageResult, error) {
	// Phase B Step 8 — wrap the public service entrypoint in a tracing span
	// and a duration histogram. Both are no-ops in the default build.
	ctx, span := telemetry.GlobalTracer("service/message").Start(ctx, "MessageService.SendMessage",
		telemetry.Int64("user_id", p.UserID),
		telemetry.Int64("channel_id", p.ChannelID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "SendMessage"))
		span.End()
	}()

	// Rate limit.
	ratKey := auth.Key("chat", p.UserID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 10, time.Second) {
		return nil, ErrRateLimited
	}

	if p.ChannelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be a positive integer", ErrBadRequest)
	}

	ch, err := s.st.GetChannel(ctx, p.ChannelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}

	isDM := ch.Type == "dm"

	// Permission check.
	if err := s.checkSendPermission(ctx, p.UserID, p.ChannelID, ch.Type); err != nil {
		return nil, err
	}

	// Slow mode (non-DM only).
	if !isDM && ch.SlowMode > 0 && !s.perms.HasChannelPerm(ctx, p.UserID, p.ChannelID, permissions.ManageMessages) {
		slowKey := auth.Key(auth.Key("slow", p.UserID), p.ChannelID)
		if s.limiter != nil && !s.limiter.Allow(slowKey, 1, time.Duration(ch.SlowMode)*time.Second) {
			return nil, fmt.Errorf("%w: channel has %ds slow mode", ErrSlowMode, ch.SlowMode)
		}
	}

	// Validate and sanitize content.
	content, err := sanitizeContent(p.Content, len(p.AttachmentIDs) > 0)
	if err != nil {
		return nil, err
	}

	// Attachment permission (non-DM).
	if !isDM && len(p.AttachmentIDs) > 0 {
		if !s.perms.HasChannelPerm(ctx, p.UserID, p.ChannelID, permissions.AttachFiles) {
			return nil, fmt.Errorf("%w: missing ATTACH_FILES permission", ErrForbidden)
		}
	}

	// Resolve mentions against the sanitized content, before the insert, so the
	// row and its mention set are written together. Unknown @words and an
	// unauthorized @everyone resolve to nothing and stay plain text.
	mentions := s.resolveMentions(ctx, content, p.UserID, p.ChannelID, isDM)

	// Persist message. RETURNING hands back the inserted row, so the DB-assigned
	// timestamp the fan-out needs arrives with the insert instead of a re-read.
	msg, err := s.st.CreateMessageWithMentions(ctx, p.ChannelID, p.UserID, content, p.ReplyTo,
		mentions.UserIDs, mentions.Everyone)
	if err != nil {
		slog.Error("MessageService.SendMessage CreateMessage", "err", err)
		return nil, fmt.Errorf("%w: failed to save message", ErrInternal)
	}
	msgID := msg.ID

	// Link attachments. Ownership is enforced atomically inside the link
	// UPDATE itself (uploader match + still unlinked), so another user's
	// upload, an already-linked attachment, or a nonexistent id is skipped by
	// the statement — no check-then-link race and no N+1 pre-verification.
	var attachments []db.AttachmentInfo
	if len(p.AttachmentIDs) > 0 {
		linked, linkErr := s.st.LinkAttachmentsToMessage(ctx, msgID, p.UserID, p.AttachmentIDs)
		if linkErr != nil {
			slog.Error("MessageService.SendMessage LinkAttachments", "err", linkErr, "msg_id", msgID)
			// Cleanup: soft-delete the message. The compensating delete must run
			// even when the link failed because the request ctx was canceled.
			if delErr := s.st.DeleteMessage(context.WithoutCancel(ctx), msgID, p.UserID, true); delErr != nil {
				slog.Error("MessageService.SendMessage DeleteMessage (cleanup)", "err", delErr, "msg_id", msgID)
			}
			return nil, fmt.Errorf("%w: failed to send message with attachments", ErrInternal)
		}
		if linked < int64(len(p.AttachmentIDs)) {
			slog.Warn("MessageService.SendMessage: skipped attachments (not owned, already linked, or missing)",
				"msg_id", msgID, "user_id", p.UserID, "requested", len(p.AttachmentIDs), "linked", linked)
		}
		if linked > 0 {
			attMap, attErr := s.st.GetAttachmentsByMessageIDs(ctx, []int64{msgID})
			if attErr != nil {
				slog.Error("MessageService.SendMessage GetAttachments", "err", attErr)
			} else {
				attachments = attMap[msgID]
			}
		}
	}

	result := &SendMessageResult{
		MessageID:        msgID,
		Timestamp:        msg.Timestamp,
		Content:          content,
		IsDM:             isDM,
		Channel:          ch,
		Attachments:      attachments,
		Mentions:         mentions.UserIDs,
		MentionsEveryone: mentions.Everyone,
	}

	// DM path: open DM for recipients.
	if isDM {
		participantIDs, pErr := s.st.GetDMParticipantIDs(ctx, p.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.SendMessage GetDMParticipantIDs", "err", pErr, "channel_id", p.ChannelID)
			return result, nil // Message saved, skip DM side effects.
		}
		result.ParticipantIDs = participantIDs

		sender, _ := s.st.GetUserByID(ctx, p.UserID)
		result.SenderUser = sender

		for _, pid := range participantIDs {
			if pid == p.UserID {
				continue
			}
			if openErr := s.st.OpenDM(ctx, pid, p.ChannelID); openErr != nil {
				slog.Error("MessageService.SendMessage OpenDM", "err", openErr, "recipient_id", pid, "channel_id", p.ChannelID)
				continue
			}
			result.OpenedDMFor = append(result.OpenedDMFor, pid)
		}
	}

	// Mention badges. The message is committed, so this runs on a ctx detached
	// from cancellation for the same reason audit writes do: a client that hangs
	// up mid-request must not silently drop the recipients' badges.
	s.applyMentionCounts(context.WithoutCancel(ctx), p.ChannelID, p.UserID, mentions, isDM, result.ParticipantIDs)

	slog.Debug("message sent", "user", p.Username, "channel_id", p.ChannelID, "msg_id", msgID)
	return result, nil
}

// EditMessage validates and persists a message edit.
func (s *MessageService) EditMessage(ctx context.Context, userID, msgID int64, rawContent string) (*EditMessageResult, error) {
	// Rate limit.
	ratKey := auth.Key("chat_edit", userID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 10, time.Second) {
		return nil, ErrRateLimited
	}

	if msgID <= 0 {
		return nil, fmt.Errorf("%w: message_id must be positive integer", ErrBadRequest)
	}

	content, err := sanitizeContent(rawContent, false)
	if err != nil {
		return nil, err
	}

	// Fetch message.
	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}
	if msg.Deleted {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrDeletedMessage)
	}

	// Channel type for DM-aware permissions.
	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	chanType := ""
	if chErr == nil && ch != nil {
		chanType = ch.Type
	}
	isDM := chanType == "dm"

	if isDM {
		ok, dmErr := s.st.IsDMParticipant(ctx, userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
		}
		if blkErr := requireDMNotBlocked(ctx, s.st, userID, msg.ChannelID); blkErr != nil {
			return nil, blkErr
		}
	} else if permErr := s.checkSendPermission(ctx, userID, msg.ChannelID, chanType); permErr != nil {
		// An edit injects new text into the channel and is fanned out to every
		// reader, so it must clear the same gate as a send rather than
		// SEND_MESSAGES alone: READ_MESSAGES so a role locked out of a private
		// channel (the panel's "Can access" toggle denies
		// READ_MESSAGES|CONNECT_VOICE and leaves SEND_MESSAGES intact) cannot
		// rewrite its old posts, and the announcement rule so a demoted
		// moderator cannot rewrite a trusted broadcast. Mirrors DeleteMessage,
		// SetMessagePinned and handleReaction, which already require
		// READ_MESSAGES. The reason is collapsed into this sink's single opaque
		// error so the reply stays an ownership/permission non-oracle.
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}

	// EditMessage checks ownership internally and returns the updated row via
	// RETURNING, so the edited_at the broadcast needs arrives with the write.
	msg, err = s.st.EditMessage(ctx, msgID, userID, content)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}

	editedAt := ""
	if msg.EditedAt != nil {
		editedAt = *msg.EditedAt
	}

	// Re-resolve mentions from the new content and replace the stored set, so a
	// mention added by an edit is highlighted and one removed by an edit stops
	// being. Mention counts are deliberately NOT advanced here: an edit that
	// re-adds an already-counted mention would otherwise raise the badge twice,
	// and "only the original insert can raise a badge" is the simplest rule that
	// is always correct.
	mentions := s.resolveMentions(ctx, content, userID, msg.ChannelID, isDM)
	if mErr := s.st.ReplaceMessageMentions(context.WithoutCancel(ctx), msgID, mentions.UserIDs, mentions.Everyone); mErr != nil {
		slog.Error("MessageService.EditMessage ReplaceMessageMentions", "err", mErr, "msg_id", msgID)
	}

	result := &EditMessageResult{
		MessageID:        msgID,
		ChannelID:        msg.ChannelID,
		Content:          content,
		EditedAt:         editedAt,
		IsDM:             isDM,
		Mentions:         mentions.UserIDs,
		MentionsEveryone: mentions.Everyone,
	}

	if isDM {
		participantIDs, pErr := s.st.GetDMParticipantIDs(ctx, msg.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.EditMessage GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	slog.Debug("message edited", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID)
	return result, nil
}

// DeleteMessage validates and soft-deletes a message.
func (s *MessageService) DeleteMessage(ctx context.Context, userID, msgID int64) (*DeleteMessageResult, error) {
	// Rate limit.
	ratKey := auth.Key("chat_delete", userID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 10, time.Second) {
		return nil, ErrRateLimited
	}

	if msgID <= 0 {
		return nil, fmt.Errorf("%w: message_id must be positive integer", ErrBadRequest)
	}

	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}

	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	isDM := chErr == nil && ch != nil && ch.Type == "dm"

	var isMod bool
	if isDM {
		ok, dmErr := s.st.IsDMParticipant(ctx, userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
		}
	} else {
		// Require READ_MESSAGES alongside MANAGE_MESSAGES (and alongside
		// SEND_MESSAGES on the author path) so a role explicitly denied access to
		// a channel cannot delete messages in it. Mirrors handleReaction and
		// checkSendPermission, which both require ReadMessages for non-DM channels.
		isMsgOwner := msg.UserID == userID
		canManage := s.perms.HasChannelPerm(ctx, userID, msg.ChannelID, permissions.ReadMessages|permissions.ManageMessages)
		canDelete := canManage || (isMsgOwner && s.perms.HasChannelPerm(ctx, userID, msg.ChannelID, permissions.ReadMessages|permissions.SendMessages))
		if !canDelete {
			return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
		}
		// db.DeleteMessage skips the ownership check when ismod is true, so the
		// moderation flag must reuse the decision made above rather than
		// re-checking MANAGE_MESSAGES without READ_MESSAGES.
		isMod = canManage
	}

	if err := s.st.DeleteMessage(ctx, msgID, userID, isMod); err != nil {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}

	slog.Debug("message deleted", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID, "is_mod", isMod)
	// Audit rows must survive a request canceled after the delete committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "message_delete", "message", msgID,
		fmt.Sprintf("channel %d, mod_action=%v", msg.ChannelID, isMod))

	result := &DeleteMessageResult{
		MessageID: msgID,
		ChannelID: msg.ChannelID,
		IsDM:      isDM,
		IsMod:     isMod,
	}

	if isDM {
		participantIDs, pErr := s.st.GetDMParticipantIDs(ctx, msg.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.DeleteMessage GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	return result, nil
}
