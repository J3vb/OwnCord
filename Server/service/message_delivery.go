package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/google/uuid"
)

// MessageRetryWindow bounds both client retry lifetime and server receipts.
const MessageRetryWindow = 24 * time.Hour

// messageDeliveryParams validates the immutable logical id. Embedding time in the
// id lets the server reject old retries after receipt pruning. Content is left
// empty: the caller fills in the sanitized text after the send gates, since a
// receipt lookup does not need it.
func messageDeliveryParams(p SendMessageParams, floorMS int64) (*db.MessageDeliveryParams, error) {
	if p.ClientMessageID == "" {
		return nil, nil
	}
	key := p.ClientMessageID
	if len(key) != 50 || key[13] != ':' {
		return nil, fmt.Errorf("%w: invalid client_message_id", ErrBadRequest)
	}
	createdMS, err := strconv.ParseInt(key[:13], 10, 64)
	u, uuidErr := uuid.Parse(key[14:])
	if err != nil || uuidErr != nil || u.Version() != 4 || u.Variant() != uuid.RFC4122 || u.String() != key[14:] || strconv.FormatInt(createdMS, 10) != key[:13] {
		return nil, fmt.Errorf("%w: invalid client_message_id", ErrBadRequest)
	}
	nowMS := time.Now().UnixMilli()
	expiresMS := createdMS + MessageRetryWindow.Milliseconds()
	if expiresMS <= nowMS || createdMS > max(nowMS+db.MessageDeliveryClockSkew.Milliseconds(), floorMS) {
		return nil, fmt.Errorf("%w: client_message_id expired or device clock is ahead", ErrBadRequest)
	}
	// Hash raw input, not the sanitized result: reusing a key for changed text
	// is a conflict even when two inputs sanitize to the same stored string.
	attachments := append([]string{}, p.AttachmentIDs...)
	encoded, err := json.Marshal(struct {
		ChannelID   int64
		Content     string
		ReplyTo     *int64
		Attachments []string
		// omitempty keeps a false ping hashing as before the field existed, so earlier
		// receipts still match; the same holds for each field below.
		ReplyPing bool   `json:",omitempty"`
		ForwardOf int64  `json:",omitempty"`
		Poll      string `json:",omitempty"`
		ForumPost string `json:",omitempty"`
		StickerID int64  `json:",omitempty"`
	}{p.ChannelID, p.Content, p.ReplyTo, attachments, p.ReplyPing, p.ForwardOf, p.Poll, p.ForumPost, p.StickerID})
	if err != nil {
		return nil, fmt.Errorf("%w: fingerprint message: %w", ErrInternal, err)
	}
	hash := sha256.Sum256(encoded)
	return &db.MessageDeliveryParams{
		UserID: p.UserID, ChannelID: p.ChannelID, ClientMessageID: key,
		PayloadHash: hash[:], ExpiresAtMS: expiresMS, CreatedAtMS: createdMS,
		ReplyTo: p.ReplyTo, AttachmentIDs: p.AttachmentIDs,
	}, nil
}

// answerSendRetry runs ahead of the channel, permission and content gates. A retry
// of an accepted send is answered from its receipt: the message exists, so a later
// permission change must not turn its acknowledgment into a refusal. Otherwise it
// returns the parsed key, or nil for a send without one.
func (s *MessageService) answerSendRetry(ctx context.Context, p SendMessageParams) (*db.MessageDeliveryParams, *SendMessageResult, error) {
	if err := s.sendMessageRateGate(p); err != nil {
		return nil, nil, err
	}
	delivery, err := messageDeliveryParams(p, s.st.MessageDeliveryFloorMS())
	if err != nil || delivery == nil {
		return nil, nil, err
	}
	previous, err := s.st.FindMessageDelivery(ctx, *delivery)
	if err != nil {
		return nil, nil, messageDeliveryError(err)
	}
	if previous != nil {
		return nil, &SendMessageResult{
			MessageID: previous.Message.ID, Timestamp: previous.Message.Timestamp, Duplicate: true,
			SkippedAttachmentIDs: s.replaySkipped(ctx, p, previous.Message.ID),
		}, nil
	}
	return delivery, nil, nil
}

// sendMessageRateGate runs before anything reads the database, retries
// included: the per-user chat rate limit, then the channel id's shape.
func (s *MessageService) sendMessageRateGate(p SendMessageParams) error {
	if s.limiter != nil && !s.limiter.Allow(auth.Key("chat", p.UserID), 10, time.Second) {
		return ErrRateLimited
	}
	if p.ChannelID <= 0 {
		return fmt.Errorf("%w: channel_id must be a positive integer", ErrBadRequest)
	}
	return nil
}

// errAllAttachmentsSkipped is the error for a send with no text whose every
// attachment was skipped; it matches ErrBadRequest (older callers) and
// ErrAttachmentsUnavailable (the precise wire code).
func errAllAttachmentsSkipped() error {
	return fmt.Errorf("%w: %w: none of the attachments could be sent", ErrBadRequest, ErrAttachmentsUnavailable)
}

// skippedAttachmentIDs returns the requested ids that are not in linked, in
// request order, first occurrence only. It returns nil when nothing was skipped.
func skippedAttachmentIDs(requested, linked []string) []string {
	if len(requested) == 0 {
		return nil
	}
	got := make(map[string]struct{}, len(linked))
	for _, id := range linked {
		got[id] = struct{}{}
	}
	var skipped []string
	seen := make(map[string]struct{}, len(requested))
	for _, id := range requested {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		if _, ok := got[id]; !ok {
			skipped = append(skipped, id)
		}
	}
	return skipped
}

// replaySkipped derives the skipped ids for a retry answered from a receipt.
// Receipts do not store them: the payload hash binds the retry to the same ordered
// id list and a live message's attachment rows are never unlinked while its
// receipt answers, so requested minus linked is exact. A read failure logs and
// returns nil, so the ack is plain and never a false "skipped" that would make the
// client re-attach files that did send.
func (s *MessageService) replaySkipped(ctx context.Context, p SendMessageParams, msgID int64) []string {
	if len(p.AttachmentIDs) == 0 {
		return nil
	}
	rows, err := s.st.GetAttachmentsByMessageIDs(context.WithoutCancel(ctx), []int64{msgID})
	if err != nil {
		slog.Error("MessageService.SendMessage GetAttachments", "err", err, "msg_id", msgID, "replay", true)
		return nil
	}
	linked := make([]string, 0, len(rows[msgID]))
	for _, a := range rows[msgID] {
		linked = append(linked, a.ID)
	}
	return skippedAttachmentIDs(p.AttachmentIDs, linked)
}

func messageDeliveryError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, db.ErrAccountErasing):
		return fmt.Errorf("%w: account is being deleted", ErrForbidden)
	case errors.Is(err, db.ErrMessageDeliveryConflict):
		return fmt.Errorf("%w: client_message_id already used for another payload", ErrConflict)
	case errors.Is(err, db.ErrMessageDeliveryDeleted):
		return ErrDeletedMessage
	case errors.Is(err, db.ErrMessageDeliveryEmpty):
		return errAllAttachmentsSkipped()
	case errors.Is(err, db.ErrForwardSourceGone):
		// The message being forwarded was deleted after the gates passed.
		return fmt.Errorf("%w: message not found", ErrNotFound)
	case errors.Is(err, db.ErrStickerGone):
		return errStickerNotFound()
	case errors.Is(err, db.ErrMessageDeliveryExpired):
		return fmt.Errorf("%w: client_message_id expired", ErrBadRequest)
	case errors.Is(err, db.ErrMessageDeliveryBeforeRestore):
		return fmt.Errorf("%w: server database was restored; review the pending message before sending it again", ErrBadRequest)
	default:
		return fmt.Errorf("%w: persist message delivery: %w", ErrInternal, err)
	}
}

// persistMessage is the send path for clients without a key. Keyed sends commit
// attachment links with the receipt so a retry never sees an accepted receipt for
// a message whose attachment ownership later fails.
func (s *MessageService) persistMessage(ctx context.Context, p SendMessageParams, content string, mentions mentionSet, delivery *db.MessageDeliveryParams) (*db.Message, []db.AttachmentInfo, []string, bool, error) {
	if delivery == nil {
		msg, err := s.st.CreateMessageWithMentions(ctx, p.ChannelID, p.UserID, content, p.ReplyTo, mentions.UserIDs, mentions.ReplyPingUserID, mentions.Everyone, mentions.RoleIDs)
		if err != nil {
			return nil, nil, nil, false, messageDeliveryError(err)
		}
		attachments, skipped, err := s.sendMessageLinkAttachments(ctx, p, msg.ID, content)
		return msg, attachments, skipped, false, err
	}
	delivery.MentionedUserIDs, delivery.MentionsEveryone = mentions.UserIDs, mentions.Everyone
	delivery.ReplyPingUserID, delivery.MentionedRoleIDs = mentions.ReplyPingUserID, mentions.RoleIDs
	saved, err := s.st.CreateMessageDelivery(ctx, *delivery)
	if err != nil {
		return nil, nil, nil, false, messageDeliveryError(err)
	}
	if saved.Duplicate || len(p.AttachmentIDs) == 0 {
		return saved.Message, nil, nil, saved.Duplicate, nil
	}
	// The write is committed. A disconnect must not erase attachment metadata
	// from the broadcast we still owe the channel.
	attachments, err := s.st.GetAttachmentsByMessageIDs(context.WithoutCancel(ctx), []int64{saved.Message.ID})
	if err != nil {
		slog.Error("message delivery attachments lookup", "err", err, "msg_id", saved.Message.ID)
	}
	return saved.Message, attachments[saved.Message.ID], skippedAttachmentIDs(p.AttachmentIDs, saved.LinkedAttachmentIDs), false, nil
}

// checkMessageSlowMode is charged only for a new send: a matching receipt returns
// before it, as before the permission gates; a retry meets only the general rate
// limit.
func (s *MessageService) checkMessageSlowMode(ctx context.Context, p SendMessageParams, ch *db.Channel) error {
	if ch.Type != "dm" && ch.SlowMode > 0 && !s.perms.HasChannelPerm(ctx, p.UserID, p.ChannelID, permissions.ManageMessages) {
		slowKey := auth.Key(auth.Key("slow", p.UserID), p.ChannelID)
		if s.limiter != nil && !s.limiter.Allow(slowKey, 1, time.Duration(ch.SlowMode)*time.Second) {
			return fmt.Errorf("%w: channel has %ds slow mode", ErrSlowMode, ch.SlowMode)
		}
	}
	return nil
}
