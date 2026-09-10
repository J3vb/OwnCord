package db

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

var (
	// ErrMessageDeliveryConflict refuses reuse of a logical id for another send.
	ErrMessageDeliveryConflict = errors.New("message delivery id was already used for another payload")
	// ErrMessageDeliveryDeleted keeps a retry from resurrecting removed content.
	ErrMessageDeliveryDeleted = errors.New("message is deleted")
	// ErrMessageDeliveryEmpty means none of an attachment-only send's uploads linked.
	ErrMessageDeliveryEmpty = errors.New("message content cannot be empty")
	// ErrMessageDeliveryExpired closes the queue-wait gap after service validation.
	ErrMessageDeliveryExpired = errors.New("message delivery id expired")
	// ErrMessageDeliveryBeforeRestore refuses a send whose receipt may have
	// been discarded by restoring an older database.
	ErrMessageDeliveryBeforeRestore = errors.New("message delivery predates database restore")
)

// MessageDeliveryParams binds one immutable client id to its complete request.
// PayloadHash is SHA-256 of channel, raw content, reply and ordered upload ids.
// ExpiresAtMS comes from the validated timestamp in ClientMessageID, never from
// the retry time. The service rejects expired ids before reading or writing.
type MessageDeliveryParams struct {
	UserID, ChannelID int64
	ClientMessageID   string
	PayloadHash       []byte
	ExpiresAtMS       int64
	CreatedAtMS       int64
	Content           string
	ReplyTo           *int64
	AttachmentIDs     []string
	MentionedUserIDs  []int64
	MentionsEveryone  bool
}

// MessageDelivery is the committed result. A duplicate carries only the
// original id/timestamp, never a stale copy of edited/deleted message content.
type MessageDelivery struct {
	Message   *Message
	Duplicate bool
}

// FindMessageDelivery permits retries to skip slow-mode accounting only after
// the service has rechecked current permissions. CreateMessageDelivery repeats
// the lookup under its writer transaction to serialize simultaneous sends.
func (d *DB) FindMessageDelivery(ctx context.Context, p MessageDeliveryParams) (*MessageDelivery, error) {
	previous, err := findMessageDelivery(ctx, d.q, p)
	if err == nil && previous == nil && p.CreatedAtMS < d.MessageDeliveryFloorMS() {
		return nil, ErrMessageDeliveryBeforeRestore
	}
	return previous, err
}

func findMessageDelivery(ctx context.Context, q *dbgen.Queries, p MessageDeliveryParams) (*MessageDelivery, error) {
	r, err := q.GetMessageDeliveryReceipt(ctx, dbgen.GetMessageDeliveryReceiptParams{
		UserID: p.UserID, ClientMessageID: p.ClientMessageID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("message delivery receipt: %w", err)
	}
	if r.ChannelID != p.ChannelID || !bytes.Equal(r.PayloadHash, p.PayloadHash) {
		return nil, ErrMessageDeliveryConflict
	}
	if r.Available == 0 {
		return nil, ErrMessageDeliveryDeleted
	}
	return &MessageDelivery{Message: &Message{
		ID: r.MessageID, ChannelID: r.ChannelID, UserID: r.UserID, Timestamp: r.Timestamp,
	}, Duplicate: true}, nil
}

// CreateMessageDelivery commits message, receipt, mentions and attachment
// ownership changes together. Nothing observes a receipt for a half-written
// message. One writer connection serializes competing callers, and the unique
// key is the storage backstop. A lost response after commit is safe to retry.
func (d *DB) CreateMessageDelivery(ctx context.Context, p MessageDeliveryParams) (*MessageDelivery, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("message delivery begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	if p.ExpiresAtMS <= time.Now().UnixMilli() {
		return nil, ErrMessageDeliveryExpired
	}
	q := d.q.WithTx(tx)
	if previous, lookupErr := findMessageDelivery(ctx, q, p); lookupErr != nil || previous != nil {
		return previous, lookupErr
	}
	if p.CreatedAtMS < d.MessageDeliveryFloorMS() {
		return nil, ErrMessageDeliveryBeforeRestore
	}
	r, err := q.CreateMessageForDelivery(ctx, dbgen.CreateMessageForDeliveryParams{
		ChannelID: p.ChannelID, UserID: p.UserID, Content: p.Content,
		ReplyTo: p.ReplyTo, MentionsEveryone: b2i64(p.MentionsEveryone),
	})
	if err != nil {
		return nil, fmt.Errorf("message delivery insert: %w", err)
	}
	if err := insertMentionRows(ctx, tx, r.ID, p.MentionedUserIDs); err != nil {
		return nil, err
	}
	linked, err := linkAttachmentsToMessage(ctx, tx, r.ID, p.UserID, p.AttachmentIDs)
	if err != nil {
		return nil, err
	}
	if p.Content == "" && linked == 0 {
		return nil, ErrMessageDeliveryEmpty
	}
	if err := q.InsertMessageDeliveryReceipt(ctx, dbgen.InsertMessageDeliveryReceiptParams{
		UserID: p.UserID, ClientMessageID: p.ClientMessageID, ChannelID: p.ChannelID,
		PayloadHash: p.PayloadHash, MessageID: r.ID, Timestamp: r.Timestamp, ExpiresAtMs: p.ExpiresAtMS,
	}); err != nil {
		return nil, fmt.Errorf("message delivery receipt insert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("message delivery commit: %w", err)
	}
	return &MessageDelivery{Message: messageFromGen(r)}, nil
}

// DeleteExpiredMessageDeliveryReceipts is the periodic maintenance sweep.
// Rejection of expired ids does not depend on the sweep having run.
func (d *DB) DeleteExpiredMessageDeliveryReceipts(ctx context.Context) error {
	return d.q.DeleteExpiredMessageDeliveryReceipts(ctx, time.Now().UnixMilli())
}
