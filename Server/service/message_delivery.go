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

// messageDeliveryParams validates the immutable logical id. Embedding time in
// the id lets the server safely reject old retries after receipt pruning.
func messageDeliveryParams(p SendMessageParams, content string, floorMS int64) (*db.MessageDeliveryParams, error) {
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
	}{p.ChannelID, p.Content, p.ReplyTo, attachments})
	if err != nil {
		return nil, fmt.Errorf("%w: fingerprint message: %w", ErrInternal, err)
	}
	hash := sha256.Sum256(encoded)
	return &db.MessageDeliveryParams{
		UserID: p.UserID, ChannelID: p.ChannelID, ClientMessageID: key,
		PayloadHash: hash[:], ExpiresAtMS: expiresMS, CreatedAtMS: createdMS, Content: content,
		ReplyTo: p.ReplyTo, AttachmentIDs: p.AttachmentIDs,
	}, nil
}

func messageDeliveryError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, db.ErrMessageDeliveryConflict):
		return fmt.Errorf("%w: client_message_id already used for another payload", ErrConflict)
	case errors.Is(err, db.ErrMessageDeliveryDeleted):
		return ErrDeletedMessage
	case errors.Is(err, db.ErrMessageDeliveryEmpty):
		return fmt.Errorf("%w: message content cannot be empty", ErrBadRequest)
	case errors.Is(err, db.ErrMessageDeliveryExpired):
		return fmt.Errorf("%w: client_message_id expired", ErrBadRequest)
	case errors.Is(err, db.ErrMessageDeliveryBeforeRestore):
		return fmt.Errorf("%w: server database was restored; review the pending message before sending it again", ErrBadRequest)
	default:
		return fmt.Errorf("%w: persist message delivery: %w", ErrInternal, err)
	}
}

// persistMessage preserves the older send path for clients without a key.
// Keyed sends commit attachment links with the receipt so a retry never sees
// an accepted receipt for a message whose attachment ownership later fails.
func (s *MessageService) persistMessage(ctx context.Context, p SendMessageParams, content string, mentions mentionSet, delivery *db.MessageDeliveryParams) (*db.Message, []db.AttachmentInfo, bool, error) {
	if delivery == nil {
		msg, err := s.st.CreateMessageWithMentions(ctx, p.ChannelID, p.UserID, content, p.ReplyTo, mentions.UserIDs, mentions.Everyone)
		if err != nil {
			return nil, nil, false, fmt.Errorf("%w: failed to save message: %w", ErrInternal, err)
		}
		attachments, err := s.sendMessageLinkAttachments(ctx, p, msg.ID, content)
		return msg, attachments, false, err
	}
	delivery.MentionedUserIDs, delivery.MentionsEveryone = mentions.UserIDs, mentions.Everyone
	saved, err := s.st.CreateMessageDelivery(ctx, *delivery)
	if err != nil {
		return nil, nil, false, messageDeliveryError(err)
	}
	if saved.Duplicate || len(p.AttachmentIDs) == 0 {
		return saved.Message, nil, saved.Duplicate, nil
	}
	// The write is committed. A disconnect must not erase attachment metadata
	// from the broadcast we still owe the channel.
	attachments, err := s.st.GetAttachmentsByMessageIDs(context.WithoutCancel(ctx), []int64{saved.Message.ID})
	if err != nil {
		slog.Error("message delivery attachments lookup", "err", err, "msg_id", saved.Message.ID)
	}
	return saved.Message, attachments[saved.Message.ID], false, nil
}

// checkMessageSlowMode is charged only for a new send. A matching receipt
// bypasses it, while current permissions and the general rate limit still run.
func (s *MessageService) checkMessageSlowMode(ctx context.Context, p SendMessageParams, ch *db.Channel) error {
	if ch.Type != "dm" && ch.SlowMode > 0 && !s.perms.HasChannelPerm(ctx, p.UserID, p.ChannelID, permissions.ManageMessages) {
		slowKey := auth.Key(auth.Key("slow", p.UserID), p.ChannelID)
		if s.limiter != nil && !s.limiter.Allow(slowKey, 1, time.Duration(ch.SlowMode)*time.Second) {
			return fmt.Errorf("%w: channel has %ds slow mode", ErrSlowMode, ch.SlowMode)
		}
	}
	return nil
}
