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

// SendMessage validates, persists and prepares broadcast data for a new message;
// callers emit the events.
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
		// A sticker send stores the fallback text; the gates above already ran.
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
	if err := s.checkMessageSlowMode(ctx, p, ch); err != nil {
		return nil, err
	}

	// Resolve mentions against the sanitized content before the insert, so the row
	// and its mention set are written together. Unknown @words and an unauthorized
	// @everyone stay plain text. A reply_ping adds the replied-to author without
	// taking a content slot; everything downstream reads the one set.
	mentions := s.loadRoleHolders(ctx, s.resolveMentions(ctx, content, p.UserID, p.ChannelID, isDM).
		withReplyPing(replyPingTarget(p, replyRef)), p.ChannelID)

	// RETURNING hands back the DB-assigned timestamp the fan-out needs.
	msg, attachments, skipped, duplicate, err := s.persistMessage(ctx, p, content, mentions, delivery)
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
	if p.ReplyTo != nil {
		// Committed already: a failed snippet read costs only the snippet.
		refs, refErr := s.st.GetReferencedMessages(context.WithoutCancel(ctx), p.ChannelID, []int64{*p.ReplyTo})
		if refErr != nil {
			slog.Error("MessageService.SendMessage GetAttachments", "err", refErr, "msg_id", msgID, "read", "referenced_message")
		}
		result.ReferencedMessage = refs[*p.ReplyTo]
	}

	if isDM && !s.sendMessageDMSideEffects(ctx, p, result) {
		return result, nil // Message saved, skip DM side effects.
	}

	// Mention badges run off the send path: the message is committed, so the badge
	// bookkeeping must not delay delivery, and the ctx is detached so a hang-up
	// cannot drop the badges. If a reader's channel_focus clears the badge before
	// the increment lands, IncrementMentionCounts' read-state guard (msgID vs
	// last_message_id) makes the increment a no-op. With a running mention worker the
	// job is queued, one window's jobs share a writer transaction, and resolution
	// runs at flush time so the block/visibility filters and guard see write-time
	// state. Without a worker (tests, NewMessageService callers) it resolves and
	// writes inline via bg.
	channelID, authorID, participantIDs := p.ChannelID, p.UserID, result.ParticipantIDs
	bgCtx := context.WithoutCancel(ctx)
	// A message with no @user, @role, @everyone or @here raises no badge and takes
	// no queue slot or goroutine.
	if mentions.pings() {
		s.dispatchMentionBadges(bgCtx, mentionJob{
			enqueueAt: time.Now(), channelID: channelID, msgID: msgID,
			apply: func(ctx context.Context) []db.MentionBatchEntry {
				return s.mentionEntries(ctx, channelID, msgID, authorID, mentions, isDM, participantIDs)
			},
		})
	}
	// Web Push dispatch (nil when off) is independent of the mention worker and keeps
	// its own background hop, as Notify can take seconds.
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

// sendMessageLinkAttachments links the requested uploads to the committed message
// and returns the broadcast's attachment data. A failed link, or a link that
// attached nothing to a contentless message, soft-deletes the row and returns the
// error for the sender.
func (s *MessageService) sendMessageLinkAttachments(ctx context.Context, p SendMessageParams, msgID int64, content string) ([]db.AttachmentInfo, []string, error) {
	if len(p.AttachmentIDs) == 0 {
		return nil, nil, nil
	}

	// Ownership is enforced atomically inside the link UPDATE (uploader match and
	// still unlinked), so foreign, already-linked and missing ids are skipped with no
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
		// sanitizeContent waived the empty-content check on the requested attachment
		// count, before any link. None linked (missing, foreign, or already linked, e.g.
		// a retried partial send), so the committed row is blank: compensate as the
		// linkErr path does rather than broadcast it.
		if delErr := s.st.DeleteMessage(context.WithoutCancel(ctx), msgID, p.UserID, true); delErr != nil {
			slog.Error("MessageService.SendMessage DeleteMessage (empty-after-link cleanup)", "err", delErr, "msg_id", msgID)
		}
		return nil, nil, errAllAttachmentsSkipped()
	}
	if len(linked) > 0 {
		// Detached: the link committed, and a ctx canceled right after must not turn an
		// attachment-only send into a blank bubble.
		attMap, attErr := s.st.GetAttachmentsByMessageIDs(context.WithoutCancel(ctx), []int64{msgID})
		if attErr != nil {
			slog.Error("MessageService.SendMessage GetAttachments", "err", attErr)
		} else {
			attachments = attMap[msgID]
		}
	}
	return attachments, skipped, nil
}

// sendMessageDMSideEffects fills the DM fields of result, (re)opens the DM for
// every trusted (or group) participant whose DM is not open, and for a 1:1 DM
// whose recipient does not yet trust the sender stages a message request. It
// reports false when the participant lookup failed, so the caller returns the
// saved message without the remaining side effects.
func (s *MessageService) sendMessageDMSideEffects(ctx context.Context, p SendMessageParams, result *SendMessageResult) bool {
	// The message is committed, so everything below must survive the sender dropping:
	// a canceled ctx would silently drop every recipient from the fan-out, skip
	// re-opening dm_open_state and degrade the payload, with chat_send_ok already
	// sent and the other participant never seeing the message live.
	bgCtx := context.WithoutCancel(ctx)
	// One read carries participants, the group flag, each open state and trust, so
	// no separate IsGroupDM, per-recipient trust read, redundant OpenDM write or
	// audience re-read is needed. The group flag rides on it so a failure cannot
	// misclassify a group DM as 1:1 or skip the first-contact gate for an untrusted
	// recipient; the message stays saved and the frame goes to the sender only (a
	// nil audience means the channel-topic broadcast, as in EditMessage).
	isGroup, targets, tErr := s.st.GetDMDeliveryTargets(bgCtx, p.ChannelID, p.UserID)
	if tErr != nil {
		slog.Error("MessageService.SendMessage GetDMDeliveryTargets", "err", tErr, "channel_id", p.ChannelID)
		result.ParticipantIDs = []int64{p.UserID}
		return false
	}
	result.DMIsGroup = isGroup

	sender, _ := s.st.GetUserByID(bgCtx, p.UserID)
	result.SenderUser = sender

	// Viewer-neutral (viewerID 0 matches nobody); the ws layer re-derives the
	// recipient per addressee. A read failure is non-fatal; the caller falls back to
	// the 1:1 shape.
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
		// Already open: nothing to write. A racing close can land on either side of the
		// read, as it could of the OpenDM write.
		if t.Open {
			continue
		}
		// OpenDM is idempotent: opened reports a genuine insert. Only a real (re)open
		// goes into OpenedDMFor, since each id makes the ws layer emit dm_channel_open
		// and bump the hub's global visibility watermark, forcing every other client's
		// next reconnect onto a full resync; an already-open DM must not pay that per
		// message.
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

	// The live-delivery audience (see DMAudience) comes from the same read. A staged
	// request's trust edge points the other way, so a recipient just staged is
	// excluded; the gate's accepted edge for a recipient with requests off marks
	// that target trusted in this very slice.
	if s.messageRequests == nil {
		result.ParticipantIDs = dmTargetIDs(targets)
	} else {
		result.ParticipantIDs = dmDeliveryAudience(isGroup, targets, p.UserID)
	}
	return true
}

// DMAudience is the live-delivery audience for a DM frame produced by senderID in
// channelID: the first-contact gate's audience when wired, else every participant
// (tests and NewMessageService callers). Exported for the ws typing path
// (ws/handlers_presence.go), the one DM frame path outside this package.
func (s *MessageService) DMAudience(ctx context.Context, channelID, senderID int64) ([]int64, error) {
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

	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}
	if msg.Deleted {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrDeletedMessage)
	}
	// Call log and group event rows are written only by the server.
	if msg.Kind != db.MessageKindUser {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}

	// Fail closed: a lookup failure must not fall through with chanType="", which
	// routes into the non-DM permission branch. That branch passes on the base role
	// mask alone (no per-channel override exists for a DM), skipping the
	// DM-participant check and RequireDMReachable.
	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	if chErr != nil || ch == nil {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}
	chanType := ch.Type
	isDM := chanType == "dm"

	if accessErr := s.editMessageCheckAccess(ctx, userID, ch); accessErr != nil {
		return nil, accessErr
	}

	if err := s.refuseStickerMessage(ctx, msgID, "a sticker message cannot be edited"); err != nil {
		return nil, err
	}

	// EditMessage checks ownership itself and returns the row via RETURNING, so
	// edited_at arrives with the write.
	msg, err = s.st.EditMessage(ctx, msgID, userID, content)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}

	editedAt := ""
	if msg.EditedAt != nil {
		editedAt = *msg.EditedAt
	}

	// Re-resolve mentions from the new content and replace the stored set, so edits
	// add and remove highlights. Counts are deliberately NOT advanced: re-adding an
	// already-counted mention would raise the badge twice, and "only the original
	// insert raises a badge" is the simplest always-correct rule.
	mentions := s.resolveMentions(context.WithoutCancel(ctx), content, userID, msg.ChannelID, isDM) // detached: it swallows read errors, so a spent deadline would empty the set
	// A reply_ping row is kept by the replace and handed back so the broadcast keeps
	// the replied-to author highlighted.
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
		// Detached: the edit committed, so a dropped editor must not lose the
		// chat_edited fan-out.
		participantIDs, pErr := s.DMAudience(context.WithoutCancel(ctx), msg.ChannelID, userID)
		if pErr != nil {
			slog.Error("MessageService.EditMessage DMAudience", "err", pErr, "channel_id", msg.ChannelID)
			// A nil ParticipantIDs would make dmEventOrFallback (ws/handlers_chat.go) fall
			// back to the channel-topic broadcast, reaching anyone subscribed to the DM's
			// topic (channel_focus is participant-gated, not trust-gated) regardless of the
			// first-contact gate. Fail closed to the editor only.
			result.ParticipantIDs = []int64{userID}
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	slog.Debug("message edited", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID)
	return result, nil
}

// editMessageCheckAccess gates an edit through the send predicate
// (permissions.CanSendMessage via channelSubject/denial) instead of a DM-only
// copy, so a timed-out user cannot broadcast new text by editing an old message.
// Most verdicts collapse into one opaque ErrForbidden (an ownership/permission
// non-oracle), but ErrTimedOut and a DM's ErrBlocked pass through: the client
// already surfaces them elsewhere.
func (s *MessageService) editMessageCheckAccess(ctx context.Context, userID int64, ch *db.Channel) error {
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, true)
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

// deleteAuthz decides whether userID may delete msg and whether it runs as a
// moderation action (isMod), per permissions.CanDeleteMessage. Any refusal is one
// opaque ErrForbidden.
func (s *MessageService) deleteAuthz(ctx context.Context, userID int64, msg *db.Message, ch *db.Channel) (bool, error) {
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, false)
	if err != nil {
		return false, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
	// db.DeleteMessage skips the ownership check when ismod is true, so the flag is
	// the predicate's own verdict, never a second check.
	isMod, verdict := permissions.CanDeleteMessage(sub, msg.UserID == userID)
	if verdict != nil {
		return false, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
	return isMod, nil
}

// DeleteMessage validates and soft-deletes a message.
func (s *MessageService) DeleteMessage(ctx context.Context, userID, msgID int64) (*DeleteMessageResult, error) {
	return s.deleteMessage(ctx, userID, msgID, nil, "", false)
}

// DeleteMessageForReport is DeleteMessage for the report-linked removal: same
// authorization and effect, plus report_id on the ledger row. reason is the
// moderator's text for that row; empty falls back to the fixed phrase.
func (s *MessageService) DeleteMessageForReport(ctx context.Context, userID, msgID, reportID int64, reason string) (*DeleteMessageResult, error) {
	return s.deleteMessage(ctx, userID, msgID, &reportID, reason, false)
}

// deleteMessage is the delete every path shares. onlyIfEmpty adds a precondition
// checked in the write itself: the message must still have no text and no file,
// else the delete is refused with errNoLongerEmpty and nothing changes.
func (s *MessageService) deleteMessage(ctx context.Context, userID, msgID int64, reportID *int64, reason string, onlyIfEmpty bool) (*DeleteMessageResult, error) {
	if err := validateActionReason(reason); err != nil {
		return nil, err
	}
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
	// GetMessage returns tombstones (so callers can broadcast deletion) and lower
	// layers make a re-delete silently idempotent. Without this guard a second
	// chat_delete reaches DecrementMentionCounts again, which has no per-message
	// idempotence and would eat a mention raised by a different live message.
	if msg.Deleted {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrDeletedMessage)
	}
	// Call and group rows are read-only for everyone, moderators included. Pin and
	// welcome rows delete like a message.
	if msg.Kind != db.MessageKindUser && msg.Kind != db.MessageKindPinAdd && msg.Kind != db.MessageKindMemberJoin {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}

	// Fail closed, as EditMessage: a lookup failure must not skip the DM-participant
	// check or the archived gate.
	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	if chErr != nil || ch == nil {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
	isDM := ch.Type == "dm"

	// Archived channels are read-only (requireChannelWritable, message_perms.go).
	if err := requireChannelWritable(ch); err != nil {
		return nil, err
	}

	isMod, err := s.deleteAuthz(ctx, userID, msg, ch)
	if err != nil {
		return nil, err
	}

	// Flush this message's queued mention-badge increment before the soft-delete
	// commits, so increment and reversal stay symmetric: the liveness guard then
	// sees the message live and the reversal takes exactly the increment back, even
	// when the recipient held a genuine badge from an earlier message, which an
	// unflushed reversal would wrongly consume.
	s.FlushPendingMentionCounts(context.WithoutCancel(ctx), []int64{msgID})

	if err := s.softDeleteRow(ctx, msgID, userID, isMod, msg.UserID, reportID, reason, onlyIfEmpty); err != nil {
		return nil, err
	}

	slog.Debug("message deleted", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID, "is_mod", isMod)
	// Audit rows must survive a request canceled after the commit.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "message_delete", "message", msgID,
		fmt.Sprintf("channel %d, mod_action=%v", msg.ChannelID, isMod))

	// Reverse this message's mention_count increments so a deleted mention leaves
	// no badge on a channel with zero unread. Detached: the soft-delete committed.
	if mcErr := s.reverseMentionCounts(context.WithoutCancel(ctx), msg.ChannelID, []int64{msgID}); mcErr != nil {
		slog.Error("MessageService.DeleteMessage DecrementMentionCounts", "err", mcErr, "channel_id", msg.ChannelID, "msg_id", msgID)
	}

	result := &DeleteMessageResult{
		MessageID: msgID,
		ChannelID: msg.ChannelID,
		IsDM:      isDM,
		IsMod:     isMod,
		IsThread:  ch.IsThread(),
	}

	if isDM {
		// Detached: the soft-delete committed, so a dropped deleter must not lose the
		// chat_deleted fan-out.
		participantIDs, pErr := s.DMAudience(context.WithoutCancel(ctx), msg.ChannelID, userID)
		if pErr != nil {
			slog.Error("MessageService.DeleteMessage DMAudience", "err", pErr, "channel_id", msg.ChannelID)
			// As in EditMessage: a nil ParticipantIDs would broadcast chat_deleted over the
			// channel topic, reaching an untrusted recipient. Fail closed to the deleter only.
			result.ParticipantIDs = []int64{userID}
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	return result, nil
}

// softDeleteRow writes the delete: the guarded own-empty variant when onlyIfEmpty,
// else the normal one.
func (s *MessageService) softDeleteRow(ctx context.Context, msgID, userID int64, isMod bool, authorID int64, reportID *int64, reason string, onlyIfEmpty bool) error {
	var err error
	switch {
	case !onlyIfEmpty:
		err = s.st.DeleteMessageWithRemoval(ctx, msgID, userID, isMod, authorID, reportID, reason)
	case s.emptyDeleter == nil:
		return errNoLongerEmpty
	default:
		err = s.emptyDeleter.DeleteEmptyOwnMessage(ctx, msgID, userID)
	}
	switch {
	case err == nil:
		return nil
	case errors.Is(err, db.ErrMessageNotEmpty):
		return errNoLongerEmpty
	case errors.Is(err, db.ErrNotFound):
		// A message that raced this request to the writer after the msg.Deleted check
		// surfaces as db.ErrNotFound. Map it to ErrDeletedMessage, the same taxonomy as
		// the sequential-repeat guard, and so this request never reaches
		// DecrementMentionCounts for a delete that did not happen.
		return fmt.Errorf("%w: cannot delete this message", ErrDeletedMessage)
	default:
		return fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
}
