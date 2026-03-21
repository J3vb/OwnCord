package db

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// CreateMessage inserts a new message and returns the assigned ID.
// Content should already be sanitized before calling this function.
func (d *DB) CreateMessage(channelID, userID int64, content string, replyTo *int64) (int64, error) {
	res, err := d.sqlDB.Exec(
		`INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES (?, ?, ?, ?)`,
		channelID, userID, content, replyTo,
	)
	if err != nil {
		return 0, fmt.Errorf("CreateMessage: %w", err)
	}
	return res.LastInsertId()
}

// GetMessage returns the message with the given ID, or nil if not found.
// Soft-deleted messages are returned so callers can broadcast the deletion event.
func (d *DB) GetMessage(id int64) (*Message, error) {
	row := d.sqlDB.QueryRow(
		`SELECT id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned, timestamp
		 FROM messages WHERE id = ?`,
		id,
	)
	return scanMessage(row)
}

// GetMessages returns up to limit messages in a channel, ordered newest-first.
// When before > 0 only messages with id < before are returned (pagination).
func (d *DB) GetMessages(channelID, before int64, limit int) ([]MessageWithUser, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if before > 0 {
		rows, err = d.sqlDB.Query(
			`SELECT m.id, m.channel_id, m.user_id, m.content, m.reply_to,
			        m.edited_at, m.deleted, m.pinned, m.timestamp,
			        u.username, u.avatar
			 FROM messages m JOIN users u ON m.user_id = u.id
			 WHERE m.channel_id = ? AND m.id < ? AND m.deleted = 0
			 ORDER BY m.id DESC LIMIT ?`,
			channelID, before, limit,
		)
	} else {
		rows, err = d.sqlDB.Query(
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

// EditMessage updates the content and sets edited_at on the message.
// Returns an error if the message does not exist or userID does not match the owner.
func (d *DB) EditMessage(id, userID int64, content string) error {
	msg, err := d.GetMessage(id)
	if err != nil {
		return err
	}
	if msg == nil {
		return fmt.Errorf("EditMessage: message %d: %w", id, ErrNotFound)
	}
	if msg.UserID != userID {
		return fmt.Errorf("EditMessage: user %d does not own message %d: %w", userID, id, ErrForbidden)
	}

	_, err = d.sqlDB.Exec(
		`UPDATE messages SET content = ?, edited_at = datetime('now') WHERE id = ?`,
		content, id,
	)
	if err != nil {
		return fmt.Errorf("EditMessage: %w", err)
	}
	return nil
}

// DeleteMessage performs a soft delete (sets deleted=1) on the message.
// The calling user must be the message owner or ismod must be true.
func (d *DB) DeleteMessage(id, userID int64, ismod bool) error {
	msg, err := d.GetMessage(id)
	if err != nil {
		return err
	}
	if msg == nil {
		return fmt.Errorf("DeleteMessage: message %d: %w", id, ErrNotFound)
	}
	if !ismod && msg.UserID != userID {
		return fmt.Errorf("DeleteMessage: user %d does not own message %d: %w", userID, id, ErrForbidden)
	}

	_, err = d.sqlDB.Exec(`UPDATE messages SET deleted = 1 WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("DeleteMessage: %w", err)
	}
	return nil
}

// AddReaction inserts a reaction. Returns an error on duplicate (same user+emoji+message).
func (d *DB) AddReaction(messageID, userID int64, emoji string) error {
	_, err := d.sqlDB.Exec(
		`INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)`,
		messageID, userID, emoji,
	)
	if err != nil {
		return fmt.Errorf("AddReaction: %w", err)
	}
	return nil
}

// RemoveReaction deletes a reaction. Returns an error if it does not exist.
func (d *DB) RemoveReaction(messageID, userID int64, emoji string) error {
	res, err := d.sqlDB.Exec(
		`DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
		messageID, userID, emoji,
	)
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
func (d *DB) GetReactions(messageID int64) ([]ReactionCount, error) {
	rows, err := d.sqlDB.Query(
		`SELECT emoji, COUNT(*) FROM reactions WHERE message_id = ? GROUP BY emoji`,
		messageID,
	)
	if err != nil {
		return nil, fmt.Errorf("GetReactions: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var counts []ReactionCount
	for rows.Next() {
		var rc ReactionCount
		if scanErr := rows.Scan(&rc.Emoji, &rc.Count); scanErr != nil {
			return nil, fmt.Errorf("GetReactions scan: %w", scanErr)
		}
		counts = append(counts, rc)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetReactions rows: %w", rows.Err())
	}
	if counts == nil {
		counts = []ReactionCount{}
	}
	return counts, nil
}

// SearchMessages performs a full-text search against the messages_fts virtual table.
// When channelID is non-nil the search is scoped to that channel.
// Deleted messages are excluded from results.
func (d *DB) SearchMessages(query string, channelID *int64, limit int) ([]MessageSearchResult, error) {
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
		rows, err = d.sqlDB.Query(
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
		rows, err = d.sqlDB.Query(
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

// GetMessagesForAPI returns messages in the API.md response shape, including
// user object, reactions (with me flag), and attachments.
func (d *DB) GetMessagesForAPI(channelID, before int64, limit int, requestingUserID int64) ([]MessageAPIResponse, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if before > 0 {
		rows, err = d.sqlDB.Query(
			`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
			        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
			 FROM messages m JOIN users u ON m.user_id = u.id
			 WHERE m.channel_id = ? AND m.id < ? AND m.deleted = 0
			 ORDER BY m.id DESC LIMIT ?`,
			channelID, before, limit,
		)
	} else {
		rows, err = d.sqlDB.Query(
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

	var msgs []MessageAPIResponse
	var msgIDs []int64
	for rows.Next() {
		var m MessageAPIResponse
		var deleted, pinned int
		if scanErr := rows.Scan(
			&m.ID, &m.ChannelID, &m.User.ID, &m.User.Username, &m.User.Avatar,
			&m.Content, &m.ReplyTo, &m.EditedAt, &deleted, &pinned, &m.Timestamp,
		); scanErr != nil {
			return nil, fmt.Errorf("GetMessagesForAPI scan: %w", scanErr)
		}
		m.Deleted = deleted != 0
		m.Pinned = pinned != 0
		m.Attachments = []AttachmentInfo{}
		m.Reactions = []ReactionInfo{}
		msgs = append(msgs, m)
		msgIDs = append(msgIDs, m.ID)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetMessagesForAPI rows: %w", rows.Err())
	}
	if msgs == nil {
		return []MessageAPIResponse{}, nil
	}

	// Batch-fetch reactions for all message IDs.
	reactMap, err := d.getReactionsBatch(msgIDs, requestingUserID)
	if err != nil {
		return nil, fmt.Errorf("GetMessagesForAPI reactions: %w", err)
	}
	for i := range msgs {
		if r, ok := reactMap[msgs[i].ID]; ok {
			msgs[i].Reactions = r
		}
	}

	// Batch-fetch attachments for all message IDs.
	attMap, err := d.GetAttachmentsByMessageIDs(msgIDs)
	if err != nil {
		return nil, fmt.Errorf("GetMessagesForAPI attachments: %w", err)
	}
	for i := range msgs {
		if a, ok := attMap[msgs[i].ID]; ok {
			msgs[i].Attachments = a
		}
	}

	return msgs, nil
}

// getReactionsBatch returns aggregated reactions for multiple messages.
func (d *DB) getReactionsBatch(msgIDs []int64, requestingUserID int64) (map[int64][]ReactionInfo, error) {
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
	query := fmt.Sprintf(
		`SELECT r.message_id, r.emoji, COUNT(*) as cnt,
		        MAX(CASE WHEN r.user_id = ? THEN 1 ELSE 0 END) as me
		 FROM reactions r
		 WHERE r.message_id IN (%s)
		 GROUP BY r.message_id, r.emoji`,
		placeholders,
	)
	args = append([]any{requestingUserID}, args...)

	rows, err := d.sqlDB.Query(query, args...)
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
func (d *DB) UpdateReadState(userID, channelID, lastReadMessageID int64) error {
	_, err := d.sqlDB.Exec(
		`INSERT INTO read_states (user_id, channel_id, last_message_id)
		 VALUES (?, ?, ?)
		 ON CONFLICT(user_id, channel_id) DO UPDATE SET last_message_id = excluded.last_message_id`,
		userID, channelID, lastReadMessageID,
	)
	if err != nil {
		return fmt.Errorf("UpdateReadState: %w", err)
	}
	return nil
}

// GetChannelUnreadCounts returns per-channel unread counts and last message IDs
// for a given user. Only text channels with at least one message are included.
func (d *DB) GetChannelUnreadCounts(userID int64) (map[int64]ChannelUnread, error) {
	rows, err := d.sqlDB.Query(
		`SELECT c.id,
		        COALESCE(MAX(m.id), 0) AS last_msg_id,
		        COUNT(CASE WHEN m.id > COALESCE(rs.last_message_id, 0) AND m.deleted = 0 THEN 1 END) AS unread
		 FROM channels c
		 LEFT JOIN messages m ON m.channel_id = c.id AND m.deleted = 0
		 LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
		 WHERE c.type = 'text'
		 GROUP BY c.id`,
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
func (d *DB) GetLatestMessageID(channelID int64) (int64, error) {
	var id int64
	err := d.sqlDB.QueryRow(
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
func (d *DB) GetPinnedMessages(channelID int64, requestingUserID int64) ([]MessageAPIResponse, error) {
	rows, err := d.sqlDB.Query(
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

	var msgs []MessageAPIResponse
	var msgIDs []int64
	for rows.Next() {
		var m MessageAPIResponse
		var deleted, pinned int
		if scanErr := rows.Scan(
			&m.ID, &m.ChannelID, &m.User.ID, &m.User.Username, &m.User.Avatar,
			&m.Content, &m.ReplyTo, &m.EditedAt, &deleted, &pinned, &m.Timestamp,
		); scanErr != nil {
			return nil, fmt.Errorf("GetPinnedMessages scan: %w", scanErr)
		}
		m.Deleted = deleted != 0
		m.Pinned = pinned != 0
		m.Attachments = []AttachmentInfo{}
		m.Reactions = []ReactionInfo{}
		msgs = append(msgs, m)
		msgIDs = append(msgIDs, m.ID)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetPinnedMessages rows: %w", rows.Err())
	}
	if msgs == nil {
		return []MessageAPIResponse{}, nil
	}

	// Batch-fetch reactions for all message IDs.
	reactMap, err := d.getReactionsBatch(msgIDs, requestingUserID)
	if err != nil {
		return nil, fmt.Errorf("GetPinnedMessages reactions: %w", err)
	}
	for i := range msgs {
		if r, ok := reactMap[msgs[i].ID]; ok {
			msgs[i].Reactions = r
		}
	}

	// Batch-fetch attachments for all message IDs.
	attMap, err := d.GetAttachmentsByMessageIDs(msgIDs)
	if err != nil {
		return nil, fmt.Errorf("GetPinnedMessages attachments: %w", err)
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
func (d *DB) SetMessagePinned(id int64, pinned bool) error {
	msg, err := d.GetMessage(id)
	if err != nil {
		return err
	}
	if msg == nil {
		return fmt.Errorf("SetMessagePinned: message %d: %w", id, ErrNotFound)
	}

	val := 0
	if pinned {
		val = 1
	}
	_, err = d.sqlDB.Exec(`UPDATE messages SET pinned = ? WHERE id = ?`, val, id)
	if err != nil {
		return fmt.Errorf("SetMessagePinned: %w", err)
	}
	return nil
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// scanMessage scans a single message from *sql.Row.
func scanMessage(row *sql.Row) (*Message, error) {
	m := &Message{}
	var deleted, pinned int
	err := row.Scan(
		&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.ReplyTo,
		&m.EditedAt, &deleted, &pinned, &m.Timestamp,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("scanMessage: %w", err)
	}
	m.Deleted = deleted != 0
	m.Pinned = pinned != 0
	return m, nil
}

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
