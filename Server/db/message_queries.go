package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

func messageFromGen(m dbgen.Message) *Message {
	return &Message{
		ID:               m.ID,
		ChannelID:        m.ChannelID,
		UserID:           m.UserID,
		Content:          m.Content,
		ReplyTo:          m.ReplyTo,
		EditedAt:         m.EditedAt,
		Deleted:          m.Deleted != 0,
		Pinned:           m.Pinned != 0,
		Timestamp:        m.Timestamp,
		MentionsEveryone: m.MentionsEveryone != 0,
		Kind:             m.Kind,
	}
}

// CreateMessage inserts a message and returns its ID; content must already be sanitized.
func (d *DB) CreateMessage(ctx context.Context, channelID, userID int64, content string, replyTo *int64) (int64, error) {
	m, err := d.CreateMessageReturning(ctx, channelID, userID, content, replyTo)
	if err != nil {
		return 0, err
	}
	return m.ID, nil
}

// CreateMessageReturning inserts a message and returns the full row, with the
// DB-assigned timestamp.
func (d *DB) CreateMessageReturning(ctx context.Context, channelID, userID int64, content string, replyTo *int64) (*Message, error) {
	m, err := d.q.CreateMessage(ctx, dbgen.CreateMessageParams{
		ChannelID: channelID,
		UserID:    userID,
		Content:   content,
		ReplyTo:   replyTo,
	})
	if err != nil {
		return nil, fmt.Errorf("CreateMessage: %w", err)
	}
	return messageFromGen(m), nil
}

// GetMessage returns the message, or nil; soft-deleted ones are returned so the
// deletion can be broadcast.
func (d *DB) GetMessage(ctx context.Context, id int64) (*Message, error) {
	m, err := d.q.GetMessage(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetMessage: %w", err)
	}
	return messageFromGen(m), nil
}

// IsMessageDeleted reports the soft-delete flag of one message and whether the row
// exists; found=false is not an error (the attachment-access path leaves a missing
// message to its own ACL).
func (d *DB) IsMessageDeleted(ctx context.Context, id int64) (deleted, found bool, err error) {
	var flag bool
	scanErr := d.reader.QueryRowContext(ctx, `SELECT deleted FROM messages WHERE id = ?`, id).Scan(&flag)
	if errors.Is(scanErr, sql.ErrNoRows) {
		return false, false, nil
	}
	if scanErr != nil {
		return false, false, fmt.Errorf("IsMessageDeleted: %w", scanErr)
	}
	return flag, true, nil
}

// GetMessages returns up to limit messages, newest first; before > 0 restricts to id < before.
func (d *DB) GetMessages(ctx context.Context, channelID, before int64, limit int) ([]MessageWithUser, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if before > 0 {
		rows, err = d.reader.QueryContext(ctx,
			`SELECT m.id, m.channel_id, m.user_id, m.content, m.reply_to,
			        m.edited_at, m.deleted, m.pinned, m.timestamp,
			        u.username, u.avatar
			 FROM messages m JOIN users u ON m.user_id = u.id
			 WHERE m.channel_id = ? AND m.id < ? AND m.deleted = 0
			 ORDER BY m.id DESC LIMIT ?`,
			channelID, before, limit,
		)
	} else {
		rows, err = d.reader.QueryContext(ctx,
			`SELECT m.id, m.channel_id, m.user_id, m.content, m.reply_to,
			        m.edited_at, m.deleted, m.pinned, m.timestamp,
			        u.username, u.avatar
			 FROM messages m JOIN users u ON m.user_id = u.id
			 WHERE m.channel_id = ? AND m.deleted = 0
			 ORDER BY m.id DESC LIMIT ?`,
			channelID, limit,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("GetMessages: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var msgs []MessageWithUser
	for rows.Next() {
		mwu, scanErr := scanMessageWithUser(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("GetMessages scan: %w", scanErr)
		}
		msgs = append(msgs, mwu)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetMessages rows: %w", rows.Err())
	}
	if msgs == nil {
		msgs = []MessageWithUser{}
	}
	return msgs, nil
}

// EditMessage updates the content, sets edited_at and returns the row via
// RETURNING. ErrNotFound if the message does not exist, is deleted, cannot be
// edited, or the content is empty and the message has no attachment;
// ErrForbidden if userID is not the owner. The UPDATE carries `AND deleted = 0`
// because a delete can commit between the ownership read and the write;
// otherwise the tombstone would be rewritten and chat_edited broadcast for a
// replaced message.
func (d *DB) EditMessage(ctx context.Context, id, userID int64, content string) (*Message, error) {
	msg, err := d.GetMessage(ctx, id)
	if err != nil {
		return nil, err
	}
	if msg == nil {
		return nil, fmt.Errorf("EditMessage: message %d: %w", id, ErrNotFound)
	}
	if msg.UserID != userID {
		return nil, fmt.Errorf("EditMessage: user %d does not own message %d: %w", userID, id, ErrForbidden)
	}

	updated, err := d.q.EditMessageContent(ctx, dbgen.EditMessageContentParams{
		Content: content,
		ID:      id,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("EditMessage: message %d: %w", id, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("EditMessage: %w", err)
	}
	return messageFromGen(updated), nil
}

// DeleteMessage soft-deletes the message; the caller must be the owner or ismod. The
// UPDATE is guarded with `AND deleted = 0` and RowsAffected is checked, so an
// already-deleted message returns ErrNotFound instead of running
// MessageService.DeleteMessage's mention_count reversal twice.
func (d *DB) DeleteMessage(ctx context.Context, id, userID int64, ismod bool) error {
	msg, err := d.GetMessage(ctx, id)
	if err != nil {
		return err
	}
	if msg == nil {
		return fmt.Errorf("DeleteMessage: message %d: %w", id, ErrNotFound)
	}
	if !ismod && msg.UserID != userID {
		return fmt.Errorf("DeleteMessage: user %d does not own message %d: %w", userID, id, ErrForbidden)
	}

	res, err := d.q.SoftDeleteMessage(ctx, id)
	if err != nil {
		return fmt.Errorf("DeleteMessage: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("DeleteMessage: message %d: %w", id, ErrNotFound)
	}
	return nil
}

// GetMessagesForAPI returns messages in the docs/api.md shape.
func (d *DB) GetMessagesForAPI(ctx context.Context, channelID, before int64, limit int, requestingUserID int64) ([]MessageAPIResponse, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if before > 0 {
		rows, err = d.queryCached(ctx,
			`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
			        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp,
			        m.mentions_everyone, m.kind
			 FROM messages m JOIN users u ON m.user_id = u.id
			 WHERE m.channel_id = ? AND m.id < ? AND m.deleted = 0
			 ORDER BY m.id DESC LIMIT ?`,
			channelID, before, limit,
		)
	} else {
		rows, err = d.queryCached(ctx,
			`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
			        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp,
			        m.mentions_everyone, m.kind
			 FROM messages m JOIN users u ON m.user_id = u.id
			 WHERE m.channel_id = ? AND m.deleted = 0
			 ORDER BY m.id DESC LIMIT ?`,
			channelID, limit,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("GetMessagesForAPI: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	return d.scanAndEnrichMessages(withCachedReads(ctx), rows, requestingUserID)
}

// GetMessagesAfterForAPI returns up to limit messages with id > after, oldest first;
// has_more callers ask for limit+1.
func (d *DB) GetMessagesAfterForAPI(ctx context.Context, channelID, after int64, limit int, requestingUserID int64) ([]MessageAPIResponse, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
		        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp,
		        m.mentions_everyone, m.kind
		 FROM messages m JOIN users u ON m.user_id = u.id
		 WHERE m.channel_id = ? AND m.id > ? AND m.deleted = 0
		 ORDER BY m.id ASC LIMIT ?`,
		channelID, after, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("GetMessagesAfterForAPI: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	return d.scanAndEnrichMessages(withCachedReads(ctx), rows, requestingUserID)
}

// GetMessagesAroundForAPI returns a window centred on centerID, oldest first: up to
// beforeCount older, the centre, up to afterCount newer. Callers pass one extra on
// each count for has_more.
func (d *DB) GetMessagesAroundForAPI(ctx context.Context, channelID, centerID int64, beforeCount, afterCount int, requestingUserID int64) ([]MessageAPIResponse, error) {
	if beforeCount < 0 {
		beforeCount = 0
	}
	if afterCount < 0 {
		afterCount = 0
	}
	// SQLite forbids ORDER BY/LIMIT on a compound-SELECT operand, so each half is a nested
	// subquery; the older half includes the centre, hence beforeCount+1.
	rows, err := d.reader.QueryContext(ctx,
		`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
		        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp,
		        m.mentions_everyone, m.kind
		 FROM messages m JOIN users u ON m.user_id = u.id
		 WHERE m.id IN (
		     SELECT id FROM (
		         SELECT id FROM messages
		          WHERE channel_id = ? AND deleted = 0 AND id <= ?
		          ORDER BY id DESC LIMIT ?
		     )
		     UNION ALL
		     SELECT id FROM (
		         SELECT id FROM messages
		          WHERE channel_id = ? AND deleted = 0 AND id > ?
		          ORDER BY id ASC LIMIT ?
		     )
		 )
		 ORDER BY m.id ASC`,
		channelID, centerID, beforeCount+1,
		channelID, centerID, afterCount,
	)
	if err != nil {
		return nil, fmt.Errorf("GetMessagesAroundForAPI: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	return d.scanAndEnrichMessages(withCachedReads(ctx), rows, requestingUserID)
}

// scanAndEnrichMessages scans rows into MessageAPIResponse and batch-fetches
// reactions, attachments and mentions; the caller defers rows.Close() and passes
// withCachedReads(ctx).
func (d *DB) scanAndEnrichMessages(ctx context.Context, rows *sql.Rows, requestingUserID int64) ([]MessageAPIResponse, error) {
	var msgs []MessageAPIResponse
	var msgIDs []int64
	for rows.Next() {
		var m MessageAPIResponse
		var deleted, pinned, everyone int
		var kind int64
		if scanErr := rows.Scan(
			&m.ID, &m.ChannelID, &m.User.ID, &m.User.Username, &m.User.Avatar,
			&m.Content, &m.ReplyTo, &m.EditedAt, &deleted, &pinned, &m.Timestamp,
			&everyone, &kind,
		); scanErr != nil {
			return nil, fmt.Errorf("scanAndEnrichMessages scan: %w", scanErr)
		}
		m.Deleted = deleted != 0
		m.Pinned = pinned != 0
		m.MentionsEveryone = everyone != 0
		m.Kind = MessageKindName(kind)
		m.Attachments = []AttachmentInfo{}
		m.Reactions = []ReactionInfo{}
		m.Mentions = []int64{}
		msgs = append(msgs, m)
		msgIDs = append(msgIDs, m.ID)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages rows: %w", rows.Err())
	}
	if msgs == nil {
		return []MessageAPIResponse{}, nil
	}

	reactMap, err := d.getReactionsBatch(ctx, msgIDs, requestingUserID)
	if err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages reactions: %w", err)
	}
	for i := range msgs {
		if r, ok := reactMap[msgs[i].ID]; ok {
			msgs[i].Reactions = r
		}
	}

	attMap, err := d.GetAttachmentsByMessageIDs(ctx, msgIDs)
	if err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages attachments: %w", err)
	}
	for i := range msgs {
		if a, ok := attMap[msgs[i].ID]; ok {
			msgs[i].Attachments = a
		}
	}

	if err := d.attachMentions(ctx, msgs, msgIDs); err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages mentions: %w", err)
	}

	if err := d.attachCalls(ctx, msgs); err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages calls: %w", err)
	}

	if err := d.attachGroupEvents(ctx, msgs); err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages group events: %w", err)
	}

	if err := d.attachForwards(ctx, msgs); err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages forwards: %w", err)
	}

	if err := d.attachPolls(ctx, msgs, requestingUserID); err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages polls: %w", err)
	}
	if err := d.attachStickers(ctx, msgs); err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages stickers: %w", err)
	}
	if err := d.attachThreads(ctx, msgs); err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages threads: %w", err)
	}
	if err := d.attachImportedAuthors(ctx, msgs); err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages imported authors: %w", err)
	}

	return d.attachReferencedMessages(ctx, msgs)
}

func scanMessageWithUser(rows *sql.Rows) (MessageWithUser, error) {
	var mwu MessageWithUser
	var deleted, pinned int
	err := rows.Scan(
		&mwu.ID, &mwu.ChannelID, &mwu.UserID, &mwu.Content, &mwu.ReplyTo,
		&mwu.EditedAt, &deleted, &pinned, &mwu.Timestamp,
		&mwu.Username, &mwu.Avatar,
	)
	if err != nil {
		return MessageWithUser{}, err
	}
	mwu.Deleted = deleted != 0
	mwu.Pinned = pinned != 0
	return mwu, nil
}
