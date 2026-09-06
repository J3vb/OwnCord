package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/telemetry"
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

	ch, content, err := s.sendMessagePrecheck(ctx, p)
	if err != nil {
		return nil, err
	}
	isDM := ch.Type == "dm"

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

	attachments, err := s.sendMessageLinkAttachments(ctx, p, msgID, content)
	if err != nil {
		return nil, err
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
		MentionsHere:     mentions.HereOnly,
	}

	// DM path: open DM for recipients.
	if isDM && !s.sendMessageDMSideEffects(ctx, p, result) {
		return result, nil // Message saved, skip DM side effects.
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

// sendMessagePrecheck runs every gate a send must clear before anything is
// written: rate limit, channel lookup, send permission, content sanitization,
// attachment permission and slow mode. It returns the resolved channel and the
// sanitized content for the caller to persist.
func (s *MessageService) sendMessagePrecheck(ctx context.Context, p SendMessageParams) (*db.Channel, string, error) {
	// Rate limit.
	ratKey := auth.Key("chat", p.UserID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 10, time.Second) {
		return nil, "", ErrRateLimited
	}

	if p.ChannelID <= 0 {
		return nil, "", fmt.Errorf("%w: channel_id must be a positive integer", ErrBadRequest)
	}

	ch, err := s.st.GetChannel(ctx, p.ChannelID)
	if err != nil || ch == nil {
		return nil, "", fmt.Errorf("%w: channel not found", ErrNotFound)
	}

	isDM := ch.Type == "dm"

	// Permission check. Also refuses a write against an archived channel — see
	// requireChannelWritable in message_perms.go, the shared gate every
	// message write sink routes through.
	if err := s.checkSendPermission(ctx, p.UserID, ch); err != nil {
		return nil, "", err
	}

	// Validate and sanitize content.
	content, err := sanitizeContent(p.Content, len(p.AttachmentIDs) > 0)
	if err != nil {
		return nil, "", err
	}

	// Attachment permission (non-DM).
	if !isDM && len(p.AttachmentIDs) > 0 {
		if !s.perms.HasChannelPerm(ctx, p.UserID, p.ChannelID, permissions.AttachFiles) {
			return nil, "", fmt.Errorf("%w: missing ATTACH_FILES permission", ErrForbidden)
		}
	}

	// Slow mode (non-DM only). Deliberately checked last, after content and
	// attachment validation: Allow() below records the cooldown timestamp the
	// instant it returns true, so a send that fails validation after this
	// point must not have already spent the once-per-window token — that
	// would lock the composer for up to ch.SlowMode seconds for a send that
	// never actually posted anything.
	if !isDM && ch.SlowMode > 0 && !s.perms.HasChannelPerm(ctx, p.UserID, p.ChannelID, permissions.ManageMessages) {
		slowKey := auth.Key(auth.Key("slow", p.UserID), p.ChannelID)
		if s.limiter != nil && !s.limiter.Allow(slowKey, 1, time.Duration(ch.SlowMode)*time.Second) {
			return nil, "", fmt.Errorf("%w: channel has %ds slow mode", ErrSlowMode, ch.SlowMode)
		}
	}

	return ch, content, nil
}

// sendMessageLinkAttachments links the requested uploads to the message row
// that was just committed and returns the attachment data the broadcast needs.
// Nothing requested is a no-op. A failed link, or a link that attached nothing
// to a message with no content of its own, compensates by soft-deleting the
// row and returns the error the caller surfaces to the sender.
func (s *MessageService) sendMessageLinkAttachments(ctx context.Context, p SendMessageParams, msgID int64, content string) ([]db.AttachmentInfo, error) {
	if len(p.AttachmentIDs) == 0 {
		return nil, nil
	}

	// Link attachments. Ownership is enforced atomically inside the link
	// UPDATE itself (uploader match + still unlinked), so another user's
	// upload, an already-linked attachment, or a nonexistent id is skipped by
	// the statement — no check-then-link race and no N+1 pre-verification.
	var attachments []db.AttachmentInfo
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
		// Detached from ctx for the same reason as the compensating deletes
		// above: the link already committed, so a request ctx canceled the
		// instant it returns (sender disconnects right after) must not turn
		// a successful attachment-only send into a blank broadcast bubble.
		attMap, attErr := s.st.GetAttachmentsByMessageIDs(context.WithoutCancel(ctx), []int64{msgID})
		if attErr != nil {
			slog.Error("MessageService.SendMessage GetAttachments", "err", attErr)
		} else {
			attachments = attMap[msgID]
		}
	}
	return attachments, nil
}

// sendMessageDMSideEffects fills in the DM-specific fields of result,
// (re)opens the DM for every trusted (or group) participant, and — for a
// one-to-one DM whose recipient does not yet trust the sender — stages a
// message request instead (B5-6 decision 4). It reports false when the
// participant lookup failed, which is the one case where the caller returns
// the already-saved message without the remaining side effects.
func (s *MessageService) sendMessageDMSideEffects(ctx context.Context, p SendMessageParams, result *SendMessageResult) bool {
	// The message is already committed, so everything below must survive
	// the sender's connection dropping the instant the write commits — the
	// same reason the compensating deletes and applyMentionCounts below
	// detach from ctx. Without WithoutCancel, a canceled request ctx here
	// silently drops every recipient from the fan-out (ParticipantIDs
	// stays nil), skips re-opening the recipient's dm_open_state, and
	// degrades the payload shape — with no error surfaced to anyone: the
	// sender sees chat_send_ok and the other participant never gets the
	// message live.
	bgCtx := context.WithoutCancel(ctx)
	participantIDs, pErr := s.st.GetDMParticipantIDs(bgCtx, p.ChannelID)
	if pErr != nil {
		slog.Error("MessageService.SendMessage GetDMParticipantIDs", "err", pErr, "channel_id", p.ChannelID)
		return false
	}

	sender, _ := s.st.GetUserByID(bgCtx, p.UserID)
	result.SenderUser = sender

	// Viewer-neutral (viewerID 0 matches nobody, so every status is
	// broadcast-collapsed); the ws layer re-derives "who is the recipient"
	// per addressee. A read failure is non-fatal — the message is already
	// committed, and the caller falls back to the 1:1 shape.
	if participants, partErr := s.st.GetDMParticipants(bgCtx, p.ChannelID, 0); partErr == nil {
		result.DMParticipants = participants
	} else {
		slog.Warn("MessageService.SendMessage GetDMParticipants", "err", partErr, "channel_id", p.ChannelID)
	}
	isGroup, gErr := s.st.IsGroupDM(bgCtx, p.ChannelID)
	if gErr == nil {
		result.DMIsGroup = isGroup
	}

	for _, pid := range participantIDs {
		if pid == p.UserID {
			continue
		}
		if !isGroup && s.messageRequests != nil && s.dmFirstContactGate(bgCtx, p, pid, result) {
			// Staged as a request (or refused outright — banned recipient):
			// never OpenDM an untrusted recipient. dmFirstContactGate has
			// already done everything this send owes them.
			continue
		}
		// OpenDM is INSERT OR IGNORE and idempotent: opened reports whether
		// this call actually inserted the row. Only a genuine (re)open goes
		// into OpenedDMFor — the ws layer emits a dm_channel_open per id in
		// that slice, and each one bumps the hub's global visibility
		// watermark, forcing every other connected client's next reconnect
		// onto a full resync. An already-open DM must not pay that cost on
		// every single message.
		opened, openErr := s.st.OpenDM(bgCtx, pid, p.ChannelID)
		if openErr != nil {
			slog.Error("MessageService.SendMessage OpenDM", "err", openErr, "recipient_id", pid, "channel_id", p.ChannelID)
			continue
		}
		if opened {
			result.OpenedDMFor = append(result.OpenedDMFor, pid)
		}
	}

	// The live-delivery audience: the sender plus every other participant who
	// trusts them (one-to-one) or every participant (group) — see
	// dmAudience. Computed last, after the loop above has written any new
	// trust/request rows, so a recipient this very send just staged a
	// request for is correctly excluded.
	if audience, aErr := s.dmAudience(bgCtx, p.ChannelID, p.UserID); aErr != nil {
		slog.Error("MessageService.SendMessage DMAudience", "err", aErr, "channel_id", p.ChannelID)
		// Fail closed toward every other participant, but still let the
		// sender see their own message live — the same best-effort posture
		// as the rest of this function's error handling.
		result.ParticipantIDs = []int64{p.UserID}
	} else {
		result.ParticipantIDs = audience
	}
	return true
}

// dmFirstContactGate runs the B5-6 gate for one non-sender participant
// (recipientID) of a one-to-one DM p.UserID just sent into. It reports true
// when the send effect for this recipient is already fully handled (a
// request was staged, or the recipient is banned and gets nothing) — the
// caller's cue to skip OpenDM entirely for them. False means the recipient
// already trusts the sender and today's OpenDM path applies.
func (s *MessageService) dmFirstContactGate(ctx context.Context, p SendMessageParams, recipientID int64, result *SendMessageResult) bool {
	recipient, rErr := s.st.GetUserByID(ctx, recipientID)
	if rErr != nil {
		slog.Error("MessageService.SendMessage: recipient lookup for the first-contact gate failed",
			"err", rErr, "recipient_id", recipientID)
		return true // nothing more can be decided for them; do not OpenDM
	}
	// "Cannot receive DMs" (community-services.md S1): no finer predicate
	// exists today than the ban state, so a banned recipient gets no request
	// row and no frame. The send itself still succeeds for the sender
	// (decision 5).
	if recipient == nil || auth.IsEffectivelyBanned(recipient) {
		return true
	}
	trusted, tErr := s.st.IsTrustedSender(ctx, recipientID, p.UserID)
	if tErr != nil {
		slog.Error("MessageService.SendMessage: trust lookup failed",
			"err", tErr, "recipient_id", recipientID, "sender_id", p.UserID)
		return true
	}
	if trusted {
		return false // today's OpenDM path
	}

	req, fcErr := s.messageRequests.firstContact(ctx, p.UserID, recipientID, p.ChannelID, result.MessageID)
	if fcErr != nil {
		slog.Error("MessageService.SendMessage: first-contact gate failed",
			"err", fcErr, "recipient_id", recipientID, "sender_id", p.UserID)
		return true
	}
	if req != nil {
		result.RequestCreatedFor = append(result.RequestCreatedFor, req)
		if result.RequestPreview == nil {
			result.RequestPreview = &DMRequestPreview{
				MessageID: result.MessageID,
				Content:   result.Content,
				Timestamp: result.Timestamp,
			}
		}
	}
	return true
}

// dmAudience is the live-delivery audience for a DM frame senderID's action
// in channelID just produced: MessageRequestService.DMDeliveryAudience when
// the gate is wired, or every participant when it is not — s.messageRequests
// == nil means every test and any caller built via NewMessageService
// directly instead of service.New(), which keeps their behaviour exactly as
// it was before B5-6.
func (s *MessageService) dmAudience(ctx context.Context, channelID, senderID int64) ([]int64, error) {
	if s.messageRequests == nil {
		return s.st.GetDMParticipantIDs(ctx, channelID)
	}
	return s.messageRequests.DMDeliveryAudience(ctx, channelID, senderID)
}

// DMAudience exports dmAudience for the ws layer's typing path
// (PresenceDeps.MessageSvc, ws/handlers_presence.go) — the one DM frame path
// outside package service. Every other DM frame path (send, edit, delete,
// reaction) calls dmAudience directly, being in the same package.
func (s *MessageService) DMAudience(ctx context.Context, channelID, senderID int64) ([]int64, error) {
	return s.dmAudience(ctx, channelID, senderID)
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

	if accessErr := s.editMessageCheckAccess(ctx, userID, msg.ChannelID, ch, isDM); accessErr != nil {
		return nil, accessErr
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
		MentionsHere:     mentions.HereOnly,
	}

	if isDM {
		// Detached from ctx for the same reason as the SendMessage post-commit
		// lookup: the edit already committed, so an editor whose connection
		// drops right after must not silently drop the chat_edited fan-out.
		participantIDs, pErr := s.dmAudience(context.WithoutCancel(ctx), msg.ChannelID, userID)
		if pErr != nil {
			slog.Error("MessageService.EditMessage DMAudience", "err", pErr, "channel_id", msg.ChannelID)
			// Codex P2-5: leaving ParticipantIDs nil here made
			// dmEventOrFallback (ws/handlers_chat.go) treat the empty slice
			// as "no explicit audience" and fall back to the plain
			// per-channel-topic broadcast — reaching anyone subscribed to
			// the DM's topic (channel_focus is participant-gated, not
			// trust-gated) regardless of the first-contact gate. Fail closed
			// to the editor only instead.
			result.ParticipantIDs = []int64{userID}
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	slog.Debug("message edited", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID)
	return result, nil
}

// editMessageCheckAccess gates an edit on the channel the message lives in:
// participation plus the block check for a DM, the shared send gate for
// everything else. isDM is the caller's already-computed ch.Type == "dm".
func (s *MessageService) editMessageCheckAccess(ctx context.Context, userID, channelID int64, ch *db.Channel, isDM bool) error {
	if isDM {
		ok, dmErr := s.st.IsDMParticipant(ctx, userID, channelID)
		if dmErr != nil || !ok {
			return fmt.Errorf("%w: cannot edit this message", ErrForbidden)
		}
		if blkErr := requireDMNotBlocked(ctx, s.st, userID, channelID); blkErr != nil {
			return blkErr
		}
	} else if permErr := s.checkSendPermission(ctx, userID, ch); permErr != nil {
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
		return fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}
	return nil
}

// deleteAuthz decides whether userID may delete msg and whether the delete
// runs as a moderation action (isMod).
func (s *MessageService) deleteAuthz(ctx context.Context, userID int64, msg *db.Message, isDM bool) (bool, error) {
	if isDM {
		ok, dmErr := s.st.IsDMParticipant(ctx, userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return false, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
		}
		return false, nil
	}
	// Require READ_MESSAGES alongside MANAGE_MESSAGES (and alongside
	// SEND_MESSAGES on the author path) so a role explicitly denied access to
	// a channel cannot delete messages in it. Mirrors handleReaction and
	// checkSendPermission, which both require ReadMessages for non-DM channels.
	isMsgOwner := msg.UserID == userID
	canManage := s.perms.HasChannelPerm(ctx, userID, msg.ChannelID, permissions.ReadMessages|permissions.ManageMessages)
	canDelete := canManage || (isMsgOwner && s.perms.HasChannelPerm(ctx, userID, msg.ChannelID, permissions.ReadMessages|permissions.SendMessages))
	if !canDelete {
		return false, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
	// db.DeleteMessage skips the ownership check when ismod is true, so the
	// moderation flag must reuse the decision made above rather than
	// re-checking MANAGE_MESSAGES without READ_MESSAGES.
	return canManage, nil
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
	// OC-0284: GetMessage returns tombstones (so callers can broadcast the
	// deletion event), and every layer beneath a plain re-delete is silently
	// idempotent. Without this guard a second chat_delete for the same
	// message reaches DecrementMentionCounts below a second time, which has
	// no per-message idempotence of its own and eats a mention raised by a
	// different, still-live message. Mirrors EditMessage's msg.Deleted guard.
	if msg.Deleted {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrDeletedMessage)
	}

	// Fail closed, mirroring EditMessage: a lookup failure must not fall
	// through to the non-DM permission branch (skipping the DM-participant
	// check) or past the archived gate below.
	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	if chErr != nil || ch == nil {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
	isDM := ch.Type == "dm"

	// Archived channels are read-only — see requireChannelWritable in
	// message_perms.go, the shared gate every message write sink routes
	// through.
	if err := requireChannelWritable(ch); err != nil {
		return nil, err
	}

	isMod, err := s.deleteAuthz(ctx, userID, msg, isDM)
	if err != nil {
		return nil, err
	}

	if err := s.st.DeleteMessage(ctx, msgID, userID, isMod); err != nil {
		// db.DeleteMessage's UPDATE now excludes already-deleted rows (OC-0284),
		// so a message that raced this request to the writer between the
		// msg.Deleted check above and this write surfaces here as
		// db.ErrNotFound. Map it to ErrDeletedMessage rather than the generic
		// ErrForbidden below so the caller sees the same taxonomy as the
		// sequential-repeat guard above, and so this request never reaches the
		// DecrementMentionCounts call past this point for a delete that did
		// not actually happen.
		if errors.Is(err, db.ErrNotFound) {
			return nil, fmt.Errorf("%w: cannot delete this message", ErrDeletedMessage)
		}
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}

	slog.Debug("message deleted", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID, "is_mod", isMod)
	// Audit rows must survive a request canceled after the delete committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "message_delete", "message", msgID,
		fmt.Sprintf("channel %d, mod_action=%v", msg.ChannelID, isMod))

	// OC-0275: reverse this message's mention_count increments so a deleted
	// mention does not leave a red badge on a channel with zero unread.
	// Detached from ctx like the audit write above and the DM fan-out below —
	// the soft-delete already committed, so a canceled request must not skip
	// the correction.
	if mcErr := s.st.DecrementMentionCounts(context.WithoutCancel(ctx), msg.ChannelID, []int64{msgID}); mcErr != nil {
		slog.Error("MessageService.DeleteMessage DecrementMentionCounts", "err", mcErr, "channel_id", msg.ChannelID, "msg_id", msgID)
	}

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
		participantIDs, pErr := s.dmAudience(context.WithoutCancel(ctx), msg.ChannelID, userID)
		if pErr != nil {
			slog.Error("MessageService.DeleteMessage DMAudience", "err", pErr, "channel_id", msg.ChannelID)
			// Codex P2-5: see EditMessage's identical comment — an empty
			// ParticipantIDs here would make dmEventOrFallback broadcast the
			// chat_deleted over the plain channel topic instead, reaching an
			// untrusted recipient subscribed to it. Fail closed to the
			// deleter only.
			result.ParticipantIDs = []int64{userID}
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	return result, nil
}
