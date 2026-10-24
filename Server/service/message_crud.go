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

	// Resolve mentions against the sanitized content, before the insert, so the
	// row and its mention set are written together. Unknown @words and an
	// unauthorized @everyone resolve to nothing and stay plain text.
	// A reply_ping adds the replied-to author on top of the capped content
	// mentions, without taking a content slot; everything downstream reads the
	// one set.
	mentions := s.loadRoleHolders(ctx, s.resolveMentions(ctx, content, p.UserID, p.ChannelID, isDM).
		withReplyPing(replyPingTarget(p, replyRef)), p.ChannelID)

	// Persist message. RETURNING hands back the inserted row, so the DB-assigned
	// timestamp the fan-out needs arrives with the insert instead of a re-read.
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
		// The message is committed; a failed snippet read only costs the
		// snippet, so it must not fail the send.
		refs, refErr := s.st.GetReferencedMessages(context.WithoutCancel(ctx), p.ChannelID, []int64{*p.ReplyTo})
		if refErr != nil {
			slog.Error("MessageService.SendMessage GetAttachments", "err", refErr, "msg_id", msgID, "read", "referenced_message")
		}
		result.ReferencedMessage = refs[*p.ReplyTo]
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
	//
	// With a running mention worker (production), the job is queued and one
	// window's jobs share a writer transaction (P5-O05); resolution runs at
	// flush time so the block/visibility filters and the read-state guard see
	// the state at write time. Without a worker (every test, and any caller
	// built via NewMessageService directly) it resolves and writes inline via
	// bg, so the counts are readable as soon as SendMessage returns.
	channelID, authorID, participantIDs := p.ChannelID, p.UserID, result.ParticipantIDs
	bgCtx := context.WithoutCancel(ctx)
	// A message with no @user, @role, @everyone or @here raises no badge, so it
	// never takes a queue slot or a goroutine.
	if mentions.pings() {
		s.dispatchMentionBadges(bgCtx, mentionJob{
			enqueueAt: time.Now(), channelID: channelID, msgID: msgID,
			apply: func(ctx context.Context) []db.MentionBatchEntry {
				return s.mentionEntries(ctx, channelID, msgID, authorID, mentions, isDM, participantIDs)
			},
		})
	}
	// Web Push dispatch (B5-11, behind HP-5): nil when dispatch is off. It is
	// independent of the mention worker, so it keeps its own background hop
	// (the Notify call can take seconds) rather than sharing the worker's
	// queue.
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

// sendMessageLinkAttachments links the requested uploads to the message row
// that was just committed and returns the attachment data the broadcast needs.
// Nothing requested is a no-op. A failed link, or a link that attached nothing
// to a message with no content of its own, compensates by soft-deleting the
// row and returns the error the caller surfaces to the sender.
func (s *MessageService) sendMessageLinkAttachments(ctx context.Context, p SendMessageParams, msgID int64, content string) ([]db.AttachmentInfo, []string, error) {
	if len(p.AttachmentIDs) == 0 {
		return nil, nil, nil
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
		return nil, nil, fmt.Errorf("%w: failed to send message with attachments", ErrInternal)
	}
	skipped := skippedAttachmentIDs(p.AttachmentIDs, linked)
	if len(skipped) > 0 {
		slog.Warn("MessageService.SendMessage: skipped attachments (not owned, already linked, or missing)",
			"msg_id", msgID, "user_id", p.UserID, "requested", len(p.AttachmentIDs), "linked", len(linked))
	}
	if len(linked) == 0 && content == "" {
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
		return nil, nil, errAllAttachmentsSkipped()
	}
	if len(linked) > 0 {
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
	return attachments, skipped, nil
}

// sendMessageDMSideEffects fills in the DM-specific fields of result,
// (re)opens the DM for every trusted (or group) participant whose DM is not
// already open, and — for a one-to-one DM whose recipient does not yet trust
// the sender — stages a message request instead (B5-6 decision 4). It reports
// false when the participant lookup failed, which is the one case where the
// caller returns the already-saved message without the remaining side
// effects.
func (s *MessageService) sendMessageDMSideEffects(ctx context.Context, p SendMessageParams, result *SendMessageResult) bool {
	// The message is already committed, so everything below must survive
	// the sender's connection dropping the instant the write commits — the
	// same reason the compensating deletes and the mention fan-out below
	// detach from ctx. Without WithoutCancel, a canceled request ctx here
	// silently drops every recipient from the fan-out (ParticipantIDs
	// stays nil), skips re-opening the recipient's dm_open_state, and
	// degrades the payload shape — with no error surfaced to anyone: the
	// sender sees chat_send_ok and the other participant never gets the
	// message live.
	bgCtx := context.WithoutCancel(ctx)
	// DP-51: one read carries the participants, the group flag, each
	// participant's open state and whether they trust the sender, so the
	// send needs no separate IsGroupDM, per-recipient trust read, OpenDM
	// write for an already-open DM, or delivery-audience re-read.
	//
	// OC-0419: the group flag rides on this read, so a failure here can
	// never misclassify a group DM as one-to-one, nor skip the first-contact
	// gate for an untrusted 1:1 recipient. Message stays saved, the other DM
	// side effects are skipped, and the frame goes to the sender only (as in
	// EditMessage: a nil audience means the channel-topic broadcast).
	isGroup, targets, tErr := s.st.GetDMDeliveryTargets(bgCtx, p.ChannelID, p.UserID)
	if tErr != nil {
		slog.Error("MessageService.SendMessage GetDMDeliveryTargets", "err", tErr, "channel_id", p.ChannelID)
		result.ParticipantIDs = []int64{p.UserID}
		return false
	}
	result.DMIsGroup = isGroup

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

	for i := range targets {
		t := targets[i]
		if t.UserID == p.UserID {
			continue
		}
		if !isGroup && s.messageRequests != nil && s.dmFirstContactGate(bgCtx, p, &targets[i], result) {
			// Staged as a request (or refused outright — recipient not reachable):
			// never OpenDM an untrusted recipient. dmFirstContactGate has
			// already done everything this send owes them.
			continue
		}
		// Already open: nothing to write through the single writer. A close
		// racing this send can land on either side of the read, exactly as
		// it could already land on either side of the OpenDM write.
		if t.Open {
			continue
		}
		// OpenDM is INSERT OR IGNORE and idempotent: opened reports whether
		// this call actually inserted the row. Only a genuine (re)open goes
		// into OpenedDMFor — the ws layer emits a dm_channel_open per id in
		// that slice, and each one bumps the hub's global visibility
		// watermark, forcing every other connected client's next reconnect
		// onto a full resync. An already-open DM must not pay that cost on
		// every single message (OC-0106).
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

	// The live-delivery audience: the sender plus every other participant who
	// trusts them (one-to-one) or every participant (group) — see
	// DMAudience — derived from the same read. A staged request's trust edge
	// points the other way (the recipient becomes trusted BY the sender), so
	// a recipient this send just staged a request for is correctly excluded;
	// the one write that adds a recipient is the gate's accepted edge for a
	// recipient with message requests off, which marks that target trusted
	// in this very slice.
	if s.messageRequests == nil {
		result.ParticipantIDs = dmTargetIDs(targets)
	} else {
		result.ParticipantIDs = dmDeliveryAudience(isGroup, targets, p.UserID)
	}
	return true
}

// DMAudience is the live-delivery audience for a DM frame senderID's action
// in channelID just produced: MessageRequestService.DMDeliveryAudience when
// the gate is wired, or every participant when it is not — s.messageRequests
// == nil means every test and any caller built via NewMessageService
// directly instead of service.New(), which keeps their behaviour exactly as
// it was before B5-6. Exported for the ws layer's typing path
// (PresenceDeps.MessageSvc, ws/handlers_presence.go) — the one DM frame path
// outside package service.
func (s *MessageService) DMAudience(ctx context.Context, channelID, senderID int64) ([]int64, error) {
	if s.messageRequests == nil {
		return s.st.GetDMParticipantIDs(ctx, channelID)
	}
	return s.messageRequests.DMDeliveryAudience(ctx, channelID, senderID)
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
	// Call log and group event rows are written only by the server.
	if msg.Kind != db.MessageKindUser {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}

	// Channel type for DM-aware permissions. Fail closed: a lookup failure must
	// not fall through with chanType="", which routes into the non-DM
	// permission branch below. That branch passes on the base role mask alone
	// (SEND_MESSAGES|READ_MESSAGES, no per-channel override exists for a DM),
	// skipping both the DM-participant check and RequireDMReachable entirely.
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
	mentions := s.resolveMentions(context.WithoutCancel(ctx), content, userID, msg.ChannelID, isDM) // detached: it swallows read errors, so a spent deadline would empty the set
	// A reply_ping row is kept by the replace and handed back so the broadcast
	// keeps the replied-to author highlighted.
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
		// Detached from ctx for the same reason as the SendMessage post-commit
		// lookup: the edit already committed, so an editor whose connection
		// drops right after must not silently drop the chat_edited fan-out.
		participantIDs, pErr := s.DMAudience(context.WithoutCancel(ctx), msg.ChannelID, userID)
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

// editMessageCheckAccess gates an edit through the same predicate a send
// uses (permissions.CanSendMessage, via channelSubject/denial) instead of a
// second, DM-only copy of participation/block — a timed-out user must not
// be able to broadcast new text into a channel or a DM by editing an old
// message (P1-2, Codex review). isDM is the caller's already-computed
// ch.Type == "dm".
//
// Most of the verdict is still collapsed into one opaque "cannot edit this
// message" (ErrForbidden) so the reply stays an ownership/permission
// non-oracle — but ErrTimedOut, and a DM's ErrBlocked (the prior DM branch's
// own behavior), pass through distinctly: TIMED_OUT and "blocked" are
// signals the client already surfaces elsewhere and are not oracles here.
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

// deleteAuthz decides whether userID may delete msg and whether the delete
// runs as a moderation action (isMod). The rule is permissions.CanDeleteMessage;
// any refusal, or a failure to resolve the subject, is one opaque ErrForbidden.
func (s *MessageService) deleteAuthz(ctx context.Context, userID int64, msg *db.Message, ch *db.Channel) (bool, error) {
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, false)
	if err != nil {
		return false, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
	// db.DeleteMessage skips the ownership check when ismod is true, so the
	// moderation flag is the predicate's own verdict, never a second check.
	isMod, verdict := permissions.CanDeleteMessage(sub, msg.UserID == userID)
	if verdict != nil {
		return false, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}
	return isMod, nil
}

// DeleteMessage validates and soft-deletes a message.
func (s *MessageService) DeleteMessage(ctx context.Context, userID, msgID int64) (*DeleteMessageResult, error) {
	return s.deleteMessage(ctx, userID, msgID, nil, "")
}

// DeleteMessageForReport is DeleteMessage with a report link (B5-9's
// report-linked removal entry point, plan item 7): same authorization and
// effect, plus report_id on the removal ledger row. reason is the
// moderator's submitted reason for the removal, stored on the ledger row
// (P2-10, Codex review: this used to be silently discarded in favor of the
// fixed phrase every other delete path uses) — empty falls back to that
// same fixed phrase.
func (s *MessageService) DeleteMessageForReport(ctx context.Context, userID, msgID, reportID int64, reason string) (*DeleteMessageResult, error) {
	return s.deleteMessage(ctx, userID, msgID, &reportID, reason)
}

func (s *MessageService) deleteMessage(ctx context.Context, userID, msgID int64, reportID *int64, reason string) (*DeleteMessageResult, error) {
	if err := validateActionReason(reason); err != nil {
		return nil, err
	}
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
	// Call and group rows are read-only for everyone, moderators included. A
	// pin row (WP 6.12) and a welcome row (WP 8.6) delete like a message.
	if msg.Kind != db.MessageKindUser && msg.Kind != db.MessageKindPinAdd && msg.Kind != db.MessageKindMemberJoin {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
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

	isMod, err := s.deleteAuthz(ctx, userID, msg, ch)
	if err != nil {
		return nil, err
	}

	// Flush this message's queued mention-badge increment before the
	// soft-delete commits and the reversal below runs, so increment and
	// reversal stay symmetric (P5-O05; see FlushPendingMentionCounts). The
	// liveness guard then sees the message still live and the reversal at the
	// end of this method takes exactly the increment back — including when the
	// recipient already held a genuine badge from an earlier message, which an
	// unflushed reversal would wrongly consume.
	s.FlushPendingMentionCounts(context.WithoutCancel(ctx), []int64{msgID})

	if err := s.st.DeleteMessageWithRemoval(ctx, msgID, userID, isMod, msg.UserID, reportID, reason); err != nil {
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
		// Detached from ctx for the same reason as the send/edit paths: the
		// soft-delete already committed, so a deleter whose connection drops
		// right after must not silently drop the chat_deleted fan-out.
		participantIDs, pErr := s.DMAudience(context.WithoutCancel(ctx), msg.ChannelID, userID)
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
