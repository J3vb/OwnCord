package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/owncord/server/db/dbgen"
)

// messageFromGen maps a generated message row to the domain Message model.
func messageFromGen(m dbgen.Message) *Message {
	return &Message{
		ID:        m.ID,
		ChannelID: m.ChannelID,
		UserID:    m.UserID,
		Content:   m.Content,
		ReplyTo:   m.ReplyTo,
		EditedAt:  m.EditedAt,
		Deleted:   m.Deleted != 0,
		Pinned:    m.Pinned != 0,
		Timestamp: m.Timestamp,
	}
}

// sanitizeFTSQuery strips FTS5 operator characters from user input to prevent
// query injection. Only allows letters, digits, spaces, and hyphens.
func sanitizeFTSQuery(q string) string {
	var sb strings.Builder
	sb.Grow(len(q))
	for _, r := range q {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' || r == '-' {
			sb.WriteRune(r)
		}
	}
	result := strings.TrimSpace(sb.String())
	// Enforce a maximum query length to bound FTS processing.
	// Use rune count to avoid splitting multi-byte characters.
	if runes := []rune(result); len(runes) > 200 {
		result = string(runes[:200])
	}
	return result
}

// CreateMessage inserts a new message and returns the assigned ID.
// Content should already be sanitized before calling this function.
func (d *DB) CreateMessage(ctx context.Context, channelID, userID int64, content string, replyTo *int64) (int64, error) {
	m, err := d.CreateMessageReturning(ctx, channelID, userID, content, replyTo)
	if err != nil {
		return 0, err
	}
	return m.ID, nil
}

// CreateMessageReturning inserts a new message and returns the full inserted
// row via RETURNING, so hot paths (the send fan-out needs the DB-assigned
// timestamp) don't re-read the row they just wrote.
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

// GetMessage returns the message with the given ID, or nil if not found.
// Soft-deleted messages are returned so callers can broadcast the deletion event.
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

// GetMessages returns up to limit messages in a channel, ordered newest-first.
// When before > 0 only messages with id < before are returned (pagination).
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

// EditMessage updates the content and sets edited_at on the message, and
// returns the updated row via RETURNING so callers don't re-read it.
// Returns an error if the message does not exist or userID does not match the owner.
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
	if err != nil {
		return nil, fmt.Errorf("EditMessage: %w", err)
	}
	return messageFromGen(updated), nil
}

// DeleteMessage performs a soft delete (sets deleted=1) on the message.
// The calling user must be the message owner or ismod must be true.
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

	if err := d.q.SoftDeleteMessage(ctx, id); err != nil {
		return fmt.Errorf("DeleteMessage: %w", err)
	}
	return nil
}

// PurgeChannelMessages soft-deletes the newest limit non-deleted messages in a
// channel and returns their IDs, newest first. When before > 0 only messages
// with id < before are considered.
//
// Rows are marked deleted=1 and otherwise left intact, so the tombstones every
// reader already renders (and the reply_to targets pointing at them) survive a
// purge exactly as they do a single delete. Selection and update run in one
// writer transaction so a concurrent single delete cannot make the reported id
// set diverge from what was actually written.
func (d *DB) PurgeChannelMessages(ctx context.Context, channelID, before int64, limit int) ([]int64, error) {
	if limit < 1 {
		return []int64{}, nil
	}

	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("PurgeChannelMessages begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	sel := `SELECT id FROM messages WHERE channel_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?`
	args := []any{channelID, limit}
	if before > 0 {
		sel = `SELECT id FROM messages WHERE channel_id = ? AND id < ? AND deleted = 0 ORDER BY id DESC LIMIT ?`
		args = []any{channelID, before, limit}
	}

	rows, err := tx.QueryContext(ctx, sel, args...)
	if err != nil {
		return nil, fmt.Errorf("PurgeChannelMessages select: %w", err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if scanErr := rows.Scan(&id); scanErr != nil {
			rows.Close() //nolint:errcheck
			return nil, fmt.Errorf("PurgeChannelMessages scan: %w", scanErr)
		}
		ids = append(ids, id)
	}
	rows.Close() //nolint:errcheck
	if rows.Err() != nil {
		return nil, fmt.Errorf("PurgeChannelMessages rows: %w", rows.Err())
	}
	if len(ids) == 0 {
		return []int64{}, nil
	}

	placeholders := make([]string, len(ids))
	updateArgs := make([]any, 0, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		updateArgs = append(updateArgs, id)
	}
	if _, err := tx.ExecContext(ctx,
		fmt.Sprintf(`UPDATE messages SET deleted = 1 WHERE id IN (%s)`, //nolint:gosec // G201: placeholder interpolation, not user input
			strings.Join(placeholders, ",")),
		updateArgs...,
	); err != nil {
		return nil, fmt.Errorf("PurgeChannelMessages update: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("PurgeChannelMessages commit: %w", err)
	}
	return ids, nil
}

// AddReaction inserts a reaction. Returns an error on duplicate (same user+emoji+message).
func (d *DB) AddReaction(ctx context.Context, messageID, userID int64, emoji string) error {
	if err := d.q.AddReaction(ctx, dbgen.AddReactionParams{
		MessageID: messageID,
		UserID:    userID,
		Emoji:     emoji,
	}); err != nil {
		return fmt.Errorf("AddReaction: %w", err)
	}
	return nil
}

// RemoveReaction deletes a reaction. Returns an error if it does not exist.
func (d *DB) RemoveReaction(ctx context.Context, messageID, userID int64, emoji string) error {
	res, err := d.q.RemoveReaction(ctx, dbgen.RemoveReactionParams{
		MessageID: messageID,
		UserID:    userID,
		Emoji:     emoji,
	})
	if err != nil {
		return fmt.Errorf("RemoveReaction: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("RemoveReaction: reaction: %w", ErrNotFound)
	}
	return nil
}

// GetReactions returns aggregated reaction counts for a message.
// MeReacted is always false here (caller passes requesting userID if needed).
func (d *DB) GetReactions(ctx context.Context, messageID int64) ([]ReactionCount, error) {
	rows, err := d.q.GetReactionCounts(ctx, messageID)
	if err != nil {
		return nil, fmt.Errorf("GetReactions: %w", err)
	}
	counts := make([]ReactionCount, 0, len(rows))
	for _, r := range rows {
		counts = append(counts, ReactionCount{Emoji: r.Emoji, Count: int(r.Count)})
	}
	return counts, nil
}

// SearchMessages performs a full-text search against the messages_fts virtual table.
// When channelID is non-nil the search is scoped to that channel.
// Deleted messages are excluded from results.
func (d *DB) SearchMessages(ctx context.Context, query string, channelID *int64, limit int) ([]MessageSearchResult, error) {
	if query == "" {
		return []MessageSearchResult{}, nil
	}
	query = sanitizeFTSQuery(query)
	if query == "" {
		return []MessageSearchResult{}, nil
	}
	if limit < 1 {
		return []MessageSearchResult{}, nil
	}

	var (
		rows *sql.Rows
		err  error
	)

	if channelID != nil {
		rows, err = d.reader.QueryContext(ctx,
			`SELECT m.id, m.channel_id, c.name, u.id, u.username, u.avatar, m.content, m.timestamp
			 FROM messages_fts f
			 JOIN messages m ON f.rowid = m.id
			 JOIN channels c ON m.channel_id = c.id
			 JOIN users u ON m.user_id = u.id
			 WHERE messages_fts MATCH ? AND m.channel_id = ? AND m.deleted = 0
			 ORDER BY rank LIMIT ?`,
			query, *channelID, limit,
		)
	} else {
		rows, err = d.reader.QueryContext(ctx,
			`SELECT m.id, m.channel_id, c.name, u.id, u.username, u.avatar, m.content, m.timestamp
			 FROM messages_fts f
			 JOIN messages m ON f.rowid = m.id
			 JOIN channels c ON m.channel_id = c.id
			 JOIN users u ON m.user_id = u.id
			 WHERE messages_fts MATCH ? AND m.deleted = 0
			 ORDER BY rank LIMIT ?`,
			query, limit,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("SearchMessages: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var results []MessageSearchResult
	for rows.Next() {
		var r MessageSearchResult
		if scanErr := rows.Scan(&r.MessageID, &r.ChannelID, &r.ChannelName,
			&r.User.ID, &r.User.Username, &r.User.Avatar,
			&r.Content, &r.Timestamp); scanErr != nil {
			return nil, fmt.Errorf("SearchMessages scan: %w", scanErr)
		}
		results = append(results, r)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("SearchMessages rows: %w", rows.Err())
	}
	if results == nil {
		results = []MessageSearchResult{}
	}
	return results, nil
}

// SearchMessagesInChannels performs a full-text search scoped to the given
// channel IDs. This prevents information leakage by filtering at the DB level
// rather than post-filtering in application code.
func (d *DB) SearchMessagesInChannels(ctx context.Context, query string, channelIDs []int64, limit int) ([]MessageSearchResult, error) {
	if query == "" || len(channelIDs) == 0 {
		return []MessageSearchResult{}, nil
	}
	query = sanitizeFTSQuery(query)
	if query == "" {
		return []MessageSearchResult{}, nil
	}
	if limit < 1 {
		return []MessageSearchResult{}, nil
	}

	// Build IN clause placeholders.
	placeholders := make([]string, len(channelIDs))
	args := make([]any, 0, len(channelIDs)+2)
	args = append(args, query)
	for i, id := range channelIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}
	args = append(args, limit)

	rows, err := d.reader.QueryContext(ctx,
		fmt.Sprintf(
			`SELECT m.id, m.channel_id, c.name, u.id, u.username, u.avatar, m.content, m.timestamp
			 FROM messages_fts f
			 JOIN messages m ON f.rowid = m.id
			 JOIN channels c ON m.channel_id = c.id
			 JOIN users u ON m.user_id = u.id
			 WHERE messages_fts MATCH ? AND m.channel_id IN (%s) AND m.deleted = 0
			 ORDER BY rank LIMIT ?`,
			strings.Join(placeholders, ",")),
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("SearchMessagesInChannels: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var results []MessageSearchResult
	for rows.Next() {
		var r MessageSearchResult
		if scanErr := rows.Scan(&r.MessageID, &r.ChannelID, &r.ChannelName,
			&r.User.ID, &r.User.Username, &r.User.Avatar,
			&r.Content, &r.Timestamp); scanErr != nil {
			return nil, fmt.Errorf("SearchMessagesInChannels scan: %w", scanErr)
		}
		results = append(results, r)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("SearchMessagesInChannels rows: %w", rows.Err())
	}
	if results == nil {
		results = []MessageSearchResult{}
	}
	return results, nil
}

// GetMessagesForAPI returns messages in the API.md response shape, including
// user object, reactions (with me flag), and attachments.
func (d *DB) GetMessagesForAPI(ctx context.Context, channelID, before int64, limit int, requestingUserID int64) ([]MessageAPIResponse, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if before > 0 {
		rows, err = d.reader.QueryContext(ctx,
			`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
			        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
			 FROM messages m JOIN users u ON m.user_id = u.id
			 WHERE m.channel_id = ? AND m.id < ? AND m.deleted = 0
			 ORDER BY m.id DESC LIMIT ?`,
			channelID, before, limit,
		)
	} else {
		rows, err = d.reader.QueryContext(ctx,
			`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
			        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
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

	return d.scanAndEnrichMessages(ctx, rows, requestingUserID)
}

// getReactionsBatch returns aggregated reactions for multiple messages.
func (d *DB) getReactionsBatch(ctx context.Context, msgIDs []int64, requestingUserID int64) (map[int64][]ReactionInfo, error) {
	if len(msgIDs) == 0 {
		return map[int64][]ReactionInfo{}, nil
	}

	// Build placeholders for IN clause.
	args := make([]any, 0, len(msgIDs)+1)
	var sb strings.Builder
	for i, id := range msgIDs {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteByte('?')
		args = append(args, id)
	}
	placeholders := sb.String()

	// Query: aggregate count + check if requesting user reacted.
	query := fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
		`SELECT r.message_id, r.emoji, COUNT(*) as cnt,
		        MAX(CASE WHEN r.user_id = ? THEN 1 ELSE 0 END) as me
		 FROM reactions r
		 WHERE r.message_id IN (%s)
		 GROUP BY r.message_id, r.emoji`,
		placeholders,
	)
	args = append([]any{requestingUserID}, args...)

	rows, err := d.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("getReactionsBatch: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := make(map[int64][]ReactionInfo)
	for rows.Next() {
		var msgID int64
		var ri ReactionInfo
		var me int
		if scanErr := rows.Scan(&msgID, &ri.Emoji, &ri.Count, &me); scanErr != nil {
			return nil, fmt.Errorf("getReactionsBatch scan: %w", scanErr)
		}
		ri.Me = me != 0
		result[msgID] = append(result[msgID], ri)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("getReactionsBatch rows: %w", rows.Err())
	}
	return result, nil
}

// UpdateReadState upserts the read state for a user in a channel.
func (d *DB) UpdateReadState(ctx context.Context, userID, channelID, lastReadMessageID int64) error {
	if err := d.q.UpdateReadState(ctx, dbgen.UpdateReadStateParams{
		UserID:        userID,
		ChannelID:     channelID,
		LastMessageID: lastReadMessageID,
	}); err != nil {
		return fmt.Errorf("UpdateReadState: %w", err)
	}
	return nil
}

// GetChannelUnreadCounts returns per-channel unread counts and last message IDs
// for a given user. Text and announcement channels are included, with 0,0 for
// channels that have no messages. Correlated subqueries range-scan
// idx_messages_channel per channel instead of the old LEFT JOIN fan-out that
// touched every message row on every WS connect.
func (d *DB) GetChannelUnreadCounts(ctx context.Context, userID int64) (map[int64]ChannelUnread, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT c.id,
		        (SELECT COALESCE(MAX(m.id), 0) FROM messages m
		          WHERE m.channel_id = c.id AND m.deleted = 0) AS last_msg_id,
		        (SELECT COUNT(*) FROM messages m
		          WHERE m.channel_id = c.id AND m.deleted = 0
		            AND m.id > COALESCE((SELECT rs.last_message_id FROM read_states rs
		                                  WHERE rs.channel_id = c.id AND rs.user_id = ?), 0)) AS unread
		 FROM channels c
		 WHERE c.type IN ('text', 'announcement')`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("GetChannelUnreadCounts: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := make(map[int64]ChannelUnread)
	for rows.Next() {
		var chID int64
		var cu ChannelUnread
		if scanErr := rows.Scan(&chID, &cu.LastMessageID, &cu.UnreadCount); scanErr != nil {
			return nil, fmt.Errorf("GetChannelUnreadCounts scan: %w", scanErr)
		}
		result[chID] = cu
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetChannelUnreadCounts rows: %w", rows.Err())
	}
	return result, nil
}

// GetLatestMessageID returns the highest message ID in a channel, or 0 if empty.
func (d *DB) GetLatestMessageID(ctx context.Context, channelID int64) (int64, error) {
	var id int64
	err := d.reader.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ? AND deleted = 0`,
		channelID,
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("GetLatestMessageID: %w", err)
	}
	return id, nil
}

// GetPinnedMessages returns all pinned messages in a channel in the API response shape,
// including user object, reactions (with me flag), and attachments.
func (d *DB) GetPinnedMessages(ctx context.Context, channelID int64, requestingUserID int64) ([]MessageAPIResponse, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
		        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
		 FROM messages m JOIN users u ON m.user_id = u.id
		 WHERE m.channel_id = ? AND m.pinned = 1 AND m.deleted = 0
		 ORDER BY m.id DESC`,
		channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("GetPinnedMessages: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	return d.scanAndEnrichMessages(ctx, rows, requestingUserID)
}

// scanAndEnrichMessages scans rows into MessageAPIResponse slice and
// batch-fetches reactions and attachments. Caller must defer rows.Close().
func (d *DB) scanAndEnrichMessages(ctx context.Context, rows *sql.Rows, requestingUserID int64) ([]MessageAPIResponse, error) {
	var msgs []MessageAPIResponse
	var msgIDs []int64
	for rows.Next() {
		var m MessageAPIResponse
		var deleted, pinned int
		if scanErr := rows.Scan(
			&m.ID, &m.ChannelID, &m.User.ID, &m.User.Username, &m.User.Avatar,
			&m.Content, &m.ReplyTo, &m.EditedAt, &deleted, &pinned, &m.Timestamp,
		); scanErr != nil {
			return nil, fmt.Errorf("scanAndEnrichMessages scan: %w", scanErr)
		}
		m.Deleted = deleted != 0
		m.Pinned = pinned != 0
		m.Attachments = []AttachmentInfo{}
		m.Reactions = []ReactionInfo{}
		msgs = append(msgs, m)
		msgIDs = append(msgIDs, m.ID)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages rows: %w", rows.Err())
	}
	if msgs == nil {
		return []MessageAPIResponse{}, nil
	}

	// Batch-fetch reactions for all message IDs.
	reactMap, err := d.getReactionsBatch(ctx, msgIDs, requestingUserID)
	if err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages reactions: %w", err)
	}
	for i := range msgs {
		if r, ok := reactMap[msgs[i].ID]; ok {
			msgs[i].Reactions = r
		}
	}

	// Batch-fetch attachments for all message IDs.
	attMap, err := d.GetAttachmentsByMessageIDs(ctx, msgIDs)
	if err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages attachments: %w", err)
	}
	for i := range msgs {
		if a, ok := attMap[msgs[i].ID]; ok {
			msgs[i].Attachments = a
		}
	}

	return msgs, nil
}

// SetMessagePinned updates the pinned column on a message.
// Returns ErrNotFound if the message does not exist.
func (d *DB) SetMessagePinned(ctx context.Context, id int64, pinned bool) error {
	res, err := d.q.SetMessagePinned(ctx, dbgen.SetMessagePinnedParams{
		Pinned: b2i64(pinned),
		ID:     id,
	})
	if err != nil {
		return fmt.Errorf("SetMessagePinned: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("SetMessagePinned: message %d: %w", id, ErrNotFound)
	}
	return nil
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// scanMessageWithUser scans a MessageWithUser from *sql.Rows.
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
