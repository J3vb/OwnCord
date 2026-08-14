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

	// Archived channels are read-only. Until now `archived` was consulted only
	// by the visibility predicate (VisibleChannelIDs / RefreshChannelVisibility),
	// so it hid the channel without protecting it: any caller that still held
	// the id — a custom client, or a stock client racing the channel_delete —
	// could keep posting into an archive indefinitely. History stays readable;
	// only writes are refused.
	if !isDM && ch.Archived {
		return nil, fmt.Errorf("%w: channel is archived", ErrForbidden)
	}

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
		if linked == 0 && content == "" {
			// sanitizeContent waived the empty-content check purely on the
			// requested attachment count, before any link attempt. None of
			// them actually linked (all missing, foreign, or already
			// linked — e.g. a retry of a partially-completed send), so the
			// row that just committed has no content and no attachments.
			// Compensate the same way the linkErr path above does, rather
			// than broadcasting a blank message.
			if delErr := s.st.DeleteMessage(context.WithoutCancel(ctx), msgID, p.UserID, true); delErr != nil {
				slog.Error("MessageService.SendMessage DeleteMessage (empty-after-link cleanup)", "err", delErr, "msg_id", msgID)
			}
			return nil, fmt.Errorf("%w: message content cannot be empty", ErrBadRequest)
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

	// Advance the author's own read state past the message they just sent.
	// Both unread queries count "messages with id > my read_states row" and
	// neither filters by author, so without this an author's own message
	// counts as unread to themselves: post in a channel, navigate away, and
	// the next `ready` restates it as an unread badge that never clears until
	// something else marks the channel read.
	//
	// Done here rather than by adding an author filter to the two queries so
	// the stored read state stays truthful — you have, in fact, seen your own
	// message — and so the fix covers DMs and text channels through one path.
	//
	// Best-effort: the message is already committed and broadcast-bound, so a
	// failure here must not fail the send. The worst case is the pre-existing
	// stale-badge behaviour, which the next mark_read corrects.
	if err := s.st.UpdateReadState(ctx, p.UserID, p.ChannelID, msgID); err != nil {
		slog.Warn("MessageService.SendMessage: could not advance author read state",
			"err", err, "user_id", p.UserID, "channel_id", p.ChannelID, "msg_id", msgID)
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
		// The message is already committed, so this lookup must survive the
		// sender's connection dropping the instant the write commits — the same
		// reason the compensating deletes and applyMentionCounts below detach
		// from ctx. Without WithoutCancel, a canceled request ctx here silently
		// drops every recipient from the fan-out (ParticipantIDs stays nil) with
		// no error surfaced to anyone: the sender sees chat_send_ok and the
		// other participant never gets the message live.
		participantIDs, pErr := s.st.GetDMParticipantIDs(context.WithoutCancel(ctx), p.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.SendMessage GetDMParticipantIDs", "err", pErr, "channel_id", p.ChannelID)
			return result, nil // Message saved, skip DM side effects.
		}
		result.ParticipantIDs = participantIDs

		sender, _ := s.st.GetUserByID(ctx, p.UserID)
		result.SenderUser = sender

		// Viewer-neutral (viewerID 0 matches nobody, so every status is
		// broadcast-collapsed); the ws layer re-derives "who is the recipient"
		// per addressee. A read failure is non-fatal — the message is already
		// committed, and the caller falls back to the 1:1 shape.
		if participants, partErr := s.st.GetDMParticipants(ctx, p.ChannelID, 0); partErr == nil {
			result.DMParticipants = participants
		} else {
			slog.Warn("MessageService.SendMessage GetDMParticipants", "err", partErr, "channel_id", p.ChannelID)
		}
		if isGroup, gErr := s.st.IsGroupDM(ctx, p.ChannelID); gErr == nil {
			result.DMIsGroup = isGroup
		}

		for _, pid := range participantIDs {
			if pid == p.UserID {
				continue
			}
			// OpenDM is INSERT OR IGNORE and idempotent: opened reports whether
			// this call actually inserted the row. Only a genuine (re)open goes
			// into OpenedDMFor — the ws layer emits a dm_channel_open per id in
			// that slice, and each one bumps the hub's global visibility
			// watermark, forcing every other connected client's next reconnect
			// onto a full resync. An already-open DM must not pay that cost on
			// every single message.
			opened, openErr := s.st.OpenDM(ctx, pid, p.ChannelID)
			if openErr != nil {
				slog.Error("MessageService.SendMessage OpenDM", "err", openErr, "recipient_id", pid, "channel_id", p.ChannelID)
				continue
			}
			if opened {
				result.OpenedDMFor = append(result.OpenedDMFor, pid)
			}
		}
	}

	// Mention badges run off the send path: the message is already committed, so
	// the recipients' badge bookkeeping (the full reader-resolution chain plus
	// the batched increment) must not delay delivering the message to the rest
	// of the channel. The ctx is detached from cancellation — for the same
	// reason audit writes are — so a client hanging up mid-request cannot drop
	// the badges. If a reader's channel_focus clears the badge in the tiny
	// window before the increment lands, IncrementMentionCounts' own read-state
	// guard (msgID vs. last_message_id) makes the increment a no-op instead of
	// resurrecting it — the badge does not reappear.
	channelID, authorID, participantIDs := p.ChannelID, p.UserID, result.ParticipantIDs
	s.bg(func() {
		s.applyMentionCounts(context.WithoutCancel(ctx), channelID, msgID, authorID, mentions, isDM, participantIDs)
	})

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

	// Channel type for DM-aware permissions. Fail closed: a lookup failure must
	// not fall through with chanType="", which routes into the non-DM
	// permission branch below. That branch passes on the base role mask alone
	// (SEND_MESSAGES|READ_MESSAGES, no per-channel override exists for a DM),
	// skipping both the DM-participant check and requireDMNotBlocked entirely.
	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	if chErr != nil || ch == nil {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}
	chanType := ch.Type
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
		// Detached from ctx for the same reason as the SendMessage post-commit
		// lookup: the edit already committed, so an editor whose connection
		// drops right after must not silently drop the chat_edited fan-out.
		participantIDs, pErr := s.st.GetDMParticipantIDs(context.WithoutCancel(ctx), msg.ChannelID)
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

	// Archived channels are read-only, mirroring SendMessage's gate
	// (message_crud.go:54): history stays visible, but a member or moderator
	// must not be able to mutate it by deleting a message out of the archive.
	if !isDM && ch != nil && ch.Archived {
		return nil, fmt.Errorf("%w: channel is archived", ErrForbidden)
	}

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
		// Detached from ctx for the same reason as the send/edit paths: the
		// soft-delete already committed, so a deleter whose connection drops
		// right after must not silently drop the chat_deleted fan-out.
		participantIDs, pErr := s.st.GetDMParticipantIDs(context.WithoutCancel(ctx), msg.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.DeleteMessage GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	return result, nil
}
