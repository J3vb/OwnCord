package db

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/dbtime"
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
	// MentionedRoleIDs are the roles whose @role tokens cleared the mention
	// gate; stored as message_role_mentions rows with the message.
	MentionedRoleIDs []int64
	// ReplyPingUserID is the replied-to author a reply_ping adds to the mention
	// set, 0 for none. It is stored as a message_mentions row flagged reply_ping.
	ReplyPingUserID  int64
	MentionsEveryone bool
	// Forward, when set, makes this send a forward: the message is
	// the snapshot, AttachmentIDs are the sender's own clones of the original's
	// files, and the transaction re-checks the original before it writes.
	Forward *ForwardRow
	// Poll, when set, makes this send a poll: the poll row and its
	// answers commit with the message and the receipt. Content is the readable
	// fallback text the service built from the same fields.
	Poll *PollInput
	// Sticker, when set, makes this send a sticker message: the
	// message_stickers row commits with the message and the receipt. Content is
	// the readable fallback the service built.
	Sticker *StickerRef
	// ForumPost, when set, makes this send a forum post.
	// ChannelID is the forum: the receipt is keyed on it, but the message is
	// written into a thread the transaction creates under the forum, so the
	// post, its opening message, its tags and the receipt commit or fail
	// together.
	ForumPost *ForumPostInput
}

// MessageDelivery is the committed result. A duplicate carries only the
// original id/timestamp, never a stale copy of edited/deleted message content.
type MessageDelivery struct {
	Message   *Message
	Duplicate bool
	// LinkedAttachmentIDs are the requested uploads this send attached, set
	// only on a fresh commit (a duplicate does not re-link).
	LinkedAttachmentIDs []string
	// Thread is the post a forum-post send created, set only on a fresh
	// commit. Message.ChannelID is then that thread, not the forum.
	Thread *ThreadInfo
}

// FindMessageDelivery answers a retry from the sender's own receipt. The
// service calls it right after the general rate limit, before the permission
// gates, and a hit returns only the original id and timestamp.
// CreateMessageDelivery repeats the lookup under its writer transaction to
// serialize simultaneous sends.
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

// CreateMessageDelivery commits message, receipt, mentions, attachment
// ownership changes and the author's read state (advanceAuthorReadState)
// together. Nothing observes a receipt for a half-written
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
	if err := refuseWhileErasing(ctx, tx, p.UserID); err != nil {
		return nil, fmt.Errorf("message delivery: %w", err)
	}
	if p.Forward != nil {
		if err := recheckForwardSource(ctx, q, p.Forward); err != nil {
			return nil, err
		}
	}
	msgChannel, err := deliveryTargetChannel(ctx, q, p)
	if err != nil {
		return nil, err
	}
	r, err := q.CreateMessageForDelivery(ctx, dbgen.CreateMessageForDeliveryParams{
		ChannelID: msgChannel, UserID: p.UserID, Content: p.Content,
		ReplyTo: p.ReplyTo, MentionsEveryone: b2i64(p.MentionsEveryone),
	})
	if err != nil {
		return nil, fmt.Errorf("message delivery insert: %w", err)
	}
	if err := insertAllMentionRows(ctx, tx, r.ID, p.MentionedUserIDs, p.ReplyPingUserID, p.MentionedRoleIDs, false); err != nil {
		return nil, err
	}
	linked, err := linkAttachmentsToMessage(ctx, tx, r.ID, p.UserID, p.AttachmentIDs)
	if err != nil {
		return nil, err
	}
	if p.Content == "" && len(linked) == 0 {
		return nil, ErrMessageDeliveryEmpty
	}
	if err := insertMessageSideRows(ctx, q, r.ID, p); err != nil {
		return nil, err
	}
	if err := q.InsertMessageDeliveryReceipt(ctx, dbgen.InsertMessageDeliveryReceiptParams{
		UserID: p.UserID, ClientMessageID: p.ClientMessageID, ChannelID: p.ChannelID,
		PayloadHash: p.PayloadHash, MessageID: r.ID, Timestamp: r.Timestamp, ExpiresAtMs: p.ExpiresAtMS,
	}); err != nil {
		return nil, fmt.Errorf("message delivery receipt insert: %w", err)
	}
	advanceAuthorReadState(ctx, q, p.UserID, msgChannel, r.ID)
	joined, err := threadPostEffects(ctx, q, msgChannel, p.UserID, p.MentionedUserIDs, p.ReplyPingUserID)
	if err != nil {
		return nil, fmt.Errorf("message delivery: %w", err)
	}
	thread, err := d.finishForumPost(ctx, q, p, msgChannel, r.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("message delivery commit: %w", err)
	}
	msg := messageFromGen(r)
	msg.ThreadJoined = joined
	return &MessageDelivery{Message: msg, LinkedAttachmentIDs: linked, Thread: thread}, nil
}

// deliveryTargetChannel is the channel the message row goes into: the send's
// channel, or for a forum post the new thread this call creates under the forum.
func deliveryTargetChannel(ctx context.Context, q *dbgen.Queries, p MessageDeliveryParams) (int64, error) {
	if p.ForumPost == nil {
		return p.ChannelID, nil
	}
	now := time.Now().UTC().Format(dbtime.ISOLayout)
	return insertForumPost(ctx, q, p.ChannelID, p.UserID, p.ForumPost, now)
}

// finishForumPost links a forum post's tags and opening message once the
// message exists and returns the post's thread; nil for any other send.
func (d *DB) finishForumPost(ctx context.Context, q *dbgen.Queries, p MessageDeliveryParams, threadID, messageID int64) (*ThreadInfo, error) {
	if p.ForumPost == nil {
		return nil, nil
	}
	if err := linkForumPost(ctx, q, threadID, messageID, p.ForumPost.TagIDs); err != nil {
		return nil, err
	}
	return d.getThread(ctx, q, threadID)
}

// insertMessageSideRows writes the forward block, poll or sticker a message carries.
func insertMessageSideRows(ctx context.Context, q *dbgen.Queries, messageID int64, p MessageDeliveryParams) error {
	if p.Forward != nil {
		if err := insertForwardRow(ctx, q, messageID, p.Forward); err != nil {
			return err
		}
	}
	if p.Poll != nil {
		if err := insertPollRows(ctx, q, messageID, p.Poll); err != nil {
			return err
		}
	}
	if p.Sticker != nil {
		if err := insertStickerRow(ctx, q, messageID, p.Sticker); err != nil {
			return err
		}
	}
	return nil
}

// DeleteExpiredMessageDeliveryReceipts is the periodic maintenance sweep.
// Rejection of expired ids does not depend on the sweep having run.
func (d *DB) DeleteExpiredMessageDeliveryReceipts(ctx context.Context) error {
	return d.q.DeleteExpiredMessageDeliveryReceipts(ctx, time.Now().UnixMilli())
}
