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

// persistOrRefund is persistMessage that gives the slow-mode token back when nothing new was
// posted: the write failed, or an identical attempt committed it and holds its own token.
func (s *MessageService) persistOrRefund(ctx context.Context, p SendMessageParams, content string, mentions mentionSet, delivery *db.MessageDeliveryParams, refundSlow func()) (*db.Message, []db.AttachmentInfo, []string, bool, error) {
	msg, attachments, skipped, duplicate, err := s.persistMessage(ctx, p, content, mentions, delivery)
	if err != nil || duplicate {
		refundSlow()
	}
	return msg, attachments, skipped, duplicate, err
}

// replySnippet reads the replied-to message for the broadcast, nil when p is not a reply.
// The send is committed already: a failed read costs only the snippet.
func (s *MessageService) replySnippet(ctx context.Context, p SendMessageParams, msgID int64) *ReferencedMessage {
	if p.ReplyTo == nil {
		return nil
	}
	refs, err := s.st.GetReferencedMessages(context.WithoutCancel(ctx), p.ChannelID, []int64{*p.ReplyTo})
	if err != nil {
		slog.Error("MessageService.SendMessage GetAttachments", "err", err, "msg_id", msgID, "read", "referenced_message")
	}
	return refs[*p.ReplyTo]
}

// SendMessage validates, persists and prepares broadcast data for a new message; callers emit the events.
func (s *MessageService) SendMessage(ctx context.Context, p SendMessageParams) (*SendMessageResult, error) {
	ctx, done := traceCall(ctx, "service/message", "MessageService.SendMessage",
		telemetry.Int64("user_id", p.UserID),
		telemetry.Int64("channel_id", p.ChannelID),
	)
	defer done()

	delivery, retry, err := s.answerSendRetry(ctx, p)
	if err != nil || retry != nil {
		return retry, err
	}
	ch, content, err := s.sendMessagePrecheck(ctx, p)
	if err != nil {
		return nil, err
	}
	isDM := ch.Type == "dm"
	var stickerRef *db.StickerRef
	if p.StickerID != 0 {
		if stickerRef, content, err = s.resolveSticker(ctx, p); err != nil {
			return nil, err
		}
	}
	if delivery != nil {
		delivery.Content, delivery.Sticker = content, stickerRef
	}
	replyRef, err := s.checkReplyTarget(ctx, p)
	if err != nil {
		return nil, err
	}
	refundSlow, err := s.checkMessageSlowMode(ctx, p, ch)
	if err != nil {
		return nil, err
	}

	// Resolve mentions against the sanitized content before the insert, so the row and its
	// mention set are written together. A reply_ping adds the replied-to author without
	// taking a content slot.
	mentions := s.loadRoleHolders(ctx, s.resolveMentions(ctx, content, p.UserID, p.ChannelID, isDM).
		withReplyPing(replyPingTarget(p, replyRef)), p.ChannelID)

	msg, attachments, skipped, duplicate, err := s.persistOrRefund(ctx, p, content, mentions, delivery, refundSlow)
	if err != nil {
		return nil, err
	}
	if duplicate {
		return &SendMessageResult{
			MessageID: msg.ID, Timestamp: msg.Timestamp, Duplicate: true,
			SkippedAttachmentIDs: s.replaySkipped(ctx, p, msg.ID),
		}, nil
	}
	msgID := msg.ID

	result := &SendMessageResult{
		MessageID:            msgID,
		Timestamp:            msg.Timestamp,
		Content:              content,
		IsDM:                 isDM,
		Channel:              ch,
		Attachments:          attachments,
		SkippedAttachmentIDs: skipped,
		ThreadJoined:         msg.ThreadJoined,
	}
	mentions.fill(result)
	if stickerRef != nil {
		id := stickerRef.ID
		result.Sticker = db.NewMessageStickerInfo(&id, stickerRef.Name)
	}
	result.ReferencedMessage = s.replySnippet(ctx, p, msgID)

	if isDM && !s.sendMessageDMSideEffects(ctx, p, result) {
		return result, nil // Message saved, skip DM side effects.
	}

	// Mention badges run off the send path: the message is committed, so bookkeeping must not
	// delay delivery, and ctx is detached so a hang-up cannot drop them. If a reader's
	// channel_focus clears the badge first, the read-state guard (msgID vs last_message_id)
	// makes the increment a no-op. With a running worker the job is queued and resolved at
	// flush time (guards see write-time state); without one it resolves and writes inline via bg.
	channelID, authorID, participantIDs := p.ChannelID, p.UserID, result.ParticipantIDs
	bgCtx := context.WithoutCancel(ctx)
	// A message with no @user, @role, @everyone or @here raises no badge and takes no queue slot.
	if mentions.pings() {
		s.dispatchMentionBadges(bgCtx, mentionJob{
			enqueueAt: time.Now(), channelID: channelID, msgID: msgID,
			apply: func(ctx context.Context) []db.MentionBatchEntry {
				return s.mentionEntries(ctx, channelID, msgID, authorID, mentions, isDM, participantIDs)
			},
		})
	}
	// Web Push dispatch (nil when off) is independent of the mention worker and keeps its own background hop, as
	// Notify can take seconds.
	if s.pushNotifier != nil {
		candidates := mentions.reachIDs()
		if isDM {
			candidates = participantIDs
		}
		s.runBackground(bgCtx, "push dispatch", func(ctx context.Context) {
			ctx, cancel := context.WithTimeout(ctx, backgroundJobTimeout)
			defer cancel()
			s.pushNotifier.Notify(ctx, channelID, authorID, candidates)
		})
	}

	slog.Debug("message sent", "user", p.Username, "channel_id", p.ChannelID, "msg_id", msgID)
	return result, nil
}

// sendMessageLinkAttachments links the requested uploads to the committed message and
// returns the broadcast's attachment data. A failed link, or one that attached nothing to a
// contentless message, soft-deletes the row and returns the error.
func (s *MessageService) sendMessageLinkAttachments(ctx context.Context, p SendMessageParams, msgID int64, content string) ([]db.AttachmentInfo, []string, error) {
	if len(p.AttachmentIDs) == 0 {
		return nil, nil, nil
	}

	// Ownership is enforced atomically inside the link UPDATE (uploader match and still
	// unlinked), so foreign, already-linked and missing ids are skipped with no
	// check-then-link race or N+1 pre-check.
	var attachments []db.AttachmentInfo
	linked, linkErr := s.st.LinkAttachmentsToMessage(ctx, msgID, p.UserID, p.AttachmentIDs)
	if linkErr != nil {
		slog.Error("MessageService.SendMessage LinkAttachments", "err", linkErr, "msg_id", msgID)
		// The compensating delete must run even if the link failed on a canceled ctx.
		if delErr := s.st.DeleteMessage(context.WithoutCancel(ctx), msgID, p.UserID, true); delErr != nil {
			slog.Error("MessageService.SendMessage DeleteMessage (cleanup)", "err", delErr, "msg_id", msgID)
		}
		return nil, nil, fmt.Errorf("%w: failed to send message with attachments", ErrInternal)
	}
	skipped := skippedAttachmentIDs(p.AttachmentIDs, linked)
	if len(skipped) > 0 {
		slog.Warn("MessageService.SendMessage: skipped attachments (not owned, already linked, or missing)",
			"msg_id", msgID, "user_id", p.UserID, "requested", len(p.AttachmentIDs), "linked", len(linked))
	}
	if len(linked) == 0 && content == "" {
		// sanitizeContent waived the empty-content check on the requested attachment count. None
		// linked (missing, foreign, or already linked, e.g. a retried partial send), so the row is
		// blank: compensate as the linkErr path does rather than broadcast it.
		if delErr := s.st.DeleteMessage(context.WithoutCancel(ctx), msgID, p.UserID, true); delErr != nil {
			slog.Error("MessageService.SendMessage DeleteMessage (empty-after-link cleanup)", "err", delErr, "msg_id", msgID)
		}
		return nil, nil, errAllAttachmentsSkipped()
	}
	if len(linked) > 0 {
		attMap, attErr := s.st.GetAttachmentsByMessageIDs(context.WithoutCancel(ctx), []int64{msgID})
		if attErr != nil {
			slog.Error("MessageService.SendMessage GetAttachments", "err", attErr)
		} else {
			attachments = attMap[msgID]
		}
	}
	return attachments, skipped, nil
}

// sendMessageDMSideEffects fills the DM fields of result, (re)opens the DM for every
// trusted (or group) participant whose DM is not open, and stages a message request for a
// 1:1 recipient who does not yet trust the sender. False when the participant lookup
// failed: the caller returns the saved message without the remaining effects.
func (s *dmDelivery) sendMessageDMSideEffects(ctx context.Context, p SendMessageParams, result *SendMessageResult) bool {
	// The message is committed, so everything below must survive the sender dropping: a
	// canceled ctx would drop every recipient from the fan-out and skip re-opening
	// dm_open_state, with chat_send_ok already sent.
	bgCtx := context.WithoutCancel(ctx)
	// One read carries participants, the group flag, open state and trust, so a failure cannot
	// misclassify a group DM as 1:1 or skip the first-contact gate for an untrusted recipient;
	// the message stays saved and the frame goes to the sender only (a nil audience means the
	// channel-topic broadcast).
	isGroup, targets, tErr := s.st.GetDMDeliveryTargets(bgCtx, p.ChannelID, p.UserID)
	if tErr != nil {
		slog.Error("MessageService.SendMessage GetDMDeliveryTargets", "err", tErr, "channel_id", p.ChannelID)
		result.ParticipantIDs = []int64{p.UserID}
		return false
	}
	result.DMIsGroup = isGroup

	sender, _ := s.st.GetUserByID(bgCtx, p.UserID)
	result.SenderUser = sender

	// Viewer-neutral (viewerID 0 matches nobody); the ws layer re-derives the recipient per
	// addressee. A read failure is non-fatal; the caller falls back to the 1:1 shape.
	if participants, partErr := s.st.GetDMParticipants(bgCtx, p.ChannelID, 0); partErr == nil {
		result.DMParticipants = participants
	} else {
		slog.Warn("MessageService.SendMessage GetDMParticipants", "err", partErr, "channel_id", p.ChannelID)
	}

	for i := range targets {
		t := targets[i]
		if t.UserID == p.UserID {
			continue
		}
		if !isGroup && s.messageRequests != nil && s.dmFirstContactGate(bgCtx, p, &targets[i], result) {
			// Staged as a request or refused: never OpenDM an untrusted recipient.
			continue
		}
		// Already open: nothing to write; a racing close can land on either side of the read.
		if t.Open {
			continue
		}
		// OpenDM is idempotent: opened reports a genuine insert. Only a real (re)open goes into
		// OpenedDMFor, since each id makes the ws layer emit dm_channel_open and bump the hub's
		// visibility watermark, forcing every other client's reconnect onto a full resync.
		opened, openErr := s.st.OpenDM(bgCtx, t.UserID, p.ChannelID)
		if openErr != nil {
			slog.Error("MessageService.SendMessage OpenDM", "err", openErr, "recipient_id", t.UserID, "channel_id", p.ChannelID)
			continue
		}
		if opened {
			result.OpenedDMFor = append(result.OpenedDMFor, t.UserID)
		}
	}

	s.fillGroupOwner(bgCtx, isGroup, p.ChannelID, result)

	// The live-delivery audience (see DMAudience) comes from the same read. A staged request's
	// trust edge points the other way, so a just-staged recipient is excluded; the gate's
	// accepted edge for a recipient with requests off marks that target trusted in this slice.
	if s.messageRequests == nil {
		result.ParticipantIDs = dmTargetIDs(targets)
	} else {
		result.ParticipantIDs = dmDeliveryAudience(isGroup, targets, p.UserID)
	}
	return true
}

// DMAudience is the live-delivery audience for a DM frame from senderID in channelID: the
// first-contact gate's audience when wired, else every participant. Exported for the ws
// typing path (ws/handlers_presence.go), the one DM frame path outside this package.
func (s *dmDelivery) DMAudience(ctx context.Context, channelID, senderID int64) ([]int64, error) {
	if s.messageRequests == nil {
		return s.st.GetDMParticipantIDs(ctx, channelID)
	}
	return s.messageRequests.DMDeliveryAudience(ctx, channelID, senderID)
}

// EditMessage validates and persists a message edit.
func (s *MessageService) EditMessage(ctx context.Context, userID, msgID int64, rawContent string) (*EditMessageResult, error) {
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

	_, ch, err := s.loadEditTarget(ctx, msgID)
	if err != nil {
		return nil, err
	}
	chanType := ch.Type
	isDM := chanType == "dm"

	if accessErr := s.editMessageCheckAccess(ctx, userID, ch); accessErr != nil {
		return nil, accessErr
	}

	if err := s.refuseStickerMessage(ctx, msgID, "a sticker message cannot be edited"); err != nil {
		return nil, err
	}

	// EditMessage checks ownership itself and returns the row via RETURNING, so edited_at arrives with it.
	msg, err := s.st.EditMessage(ctx, msgID, userID, content)
	if err != nil && !errors.Is(err, db.ErrNotFound) && !errors.Is(err, db.ErrForbidden) {
		// A store failure (busy database, spent deadline, I/O) is not a refusal: logged and answered
		// INTERNAL, or REQUEST_TIMEOUT for a spent frame.
		return nil, fmt.Errorf("%w: edit message: %w", ErrInternal, err)
	}
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}

	editedAt := ""
	if msg.EditedAt != nil {
		editedAt = *msg.EditedAt
	}

	// Re-resolve mentions from the new content and replace the stored set, so edits add and
	// remove highlights. Counts are deliberately NOT advanced: re-adding an already-counted
	// mention would raise the badge twice; only the original insert raises a badge.
	mentions := s.resolveMentions(context.WithoutCancel(ctx), content, userID, msg.ChannelID, isDM) // detached: it swallows read errors, so a spent deadline would empty the set
	// A reply_ping row is kept by the replace and handed back so the broadcast keeps the replied-to author
	// highlighted.
	replyPingID, mErr := s.st.ReplaceMessageMentions(context.WithoutCancel(ctx), msgID, mentions.UserIDs, mentions.Everyone, mentions.RoleIDs)
	if mErr != nil {
		slog.Error("MessageService.EditMessage ReplaceMessageMentions", "err", mErr, "msg_id", msgID)
	}
	mentions = mentions.withReplyPing(replyPingID)
	result := &EditMessageResult{
		MessageID:        msgID,
		ChannelID:        msg.ChannelID,
		Content:          content,
		EditedAt:         editedAt,
		IsDM:             isDM,
		Mentions:         mentions.UserIDs,
		MentionRoles:     mentions.RoleIDs,
		MentionsEveryone: mentions.Everyone,
		MentionsHere:     mentions.HereOnly,
		PostOpening:      s.isPostOpening(context.WithoutCancel(ctx), ch, msgID),
	}

	if isDM {
		// Detached: the edit committed, so a dropped editor must not lose the chat_edited fan-out.
		participantIDs, pErr := s.DMAudience(context.WithoutCancel(ctx), msg.ChannelID, userID)
		if pErr != nil {
			slog.Error("MessageService.EditMessage DMAudience", "err", pErr, "channel_id", msg.ChannelID)
			// A nil ParticipantIDs would make dmEventOrFallback (ws/handlers_chat.go) use the
			// channel-topic broadcast, reaching anyone subscribed to the DM's topic (channel_focus is
			// participant-gated, not trust-gated) past the first-contact gate. Fail closed to the editor.
			result.ParticipantIDs = []int64{userID}
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	slog.Debug("message edited", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID)
	return result, nil
}

func (s *MessageService) loadEditTarget(ctx context.Context, msgID int64) (*db.Message, *db.Channel, error) {
	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: edit message: load: %w", ErrInternal, err)
	}
	if msg == nil {
		return nil, nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}
	if msg.Deleted {
		return nil, nil, fmt.Errorf("%w: cannot edit this message", ErrDeletedMessage)
	}
	// Call log and group event rows are written only by the server.
	if msg.Kind != db.MessageKindUser {
		return nil, nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}

	// Fail closed: a lookup failure must not fall through with chanType="", which routes into
	// the non-DM branch that passes on the base role mask alone, skipping the
	// DM-participant check and RequireDMReachable.
	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	if chErr != nil {
		return nil, nil, fmt.Errorf("%w: edit message: load channel: %w", ErrInternal, chErr)
	}
	if ch == nil {
		return nil, nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}
	return msg, ch, nil
}

// editMessageCheckAccess gates an edit through the send predicate (CanSendMessage via
// channelSubject/denial), so a timed-out user cannot broadcast new text by editing an old
// message. Most verdicts collapse into one opaque ErrForbidden (non-oracle); ErrTimedOut,
// a DM's ErrBlocked and store failures (internal) pass through.
func (s *MessageService) editMessageCheckAccess(ctx context.Context, userID int64, ch *db.Channel) error {
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, true)
	if errors.Is(err, ErrInternal) {
		return err
	}
	if err != nil {
		return fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}
	if verdict := denial(permissions.CanSendMessage(sub)); verdict != nil {
		if errors.Is(verdict, ErrTimedOut) || (ch.Type == "dm" && errors.Is(verdict, ErrBlocked)) {
			return verdict
		}
		return fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}
	return nil
}
