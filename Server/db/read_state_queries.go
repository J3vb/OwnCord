package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// GetReadState returns the stored read-state row for (userID, channelID); found is
// false when the user never focused the channel. It runs on the reader so
// HandleChannelFocus can skip a redundant write.
func (d *DB) GetReadState(ctx context.Context, userID, channelID int64) (lastMessageID, mentionCount int64, found bool, err error) {
	row, err := d.q.GetReadState(ctx, dbgen.GetReadStateParams{UserID: userID, ChannelID: channelID})
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, false, nil
	}
	if err != nil {
		return 0, 0, false, fmt.Errorf("GetReadState: %w", err)
	}
	return row.LastMessageID, row.MentionCount, true, nil
}

// MarkChannelReadAtLatest marks the channel read at its newest message as of
// the statement, not at an id the caller read earlier. Use it for "mark this
// channel read"; UpdateReadState is for a caller that already holds the exact
// id (the send path advancing the sender past their own message).
//
// A mark-read from a stale snapshot cleared mention_count while
// last_message_id still pointed behind a newly mentioned message, so the badge
// vanished with nothing to recompute it. Computing the watermark here makes
// the read and the clear atomic with respect to IncrementMentionCounts.
func (d *DB) MarkChannelReadAtLatest(ctx context.Context, userID, channelID int64) error {
	if err := d.q.MarkChannelReadAtLatest(ctx, dbgen.MarkChannelReadAtLatestParams{
		UserID:      userID,
		ChannelID:   channelID,
		ChannelID_2: channelID,
	}); err != nil {
		return fmt.Errorf("MarkChannelReadAtLatest: %w", err)
	}
	return nil
}

// UpdateReadState upserts the read state at the id the caller names and
// clears its mention badge. Only a caller that already holds the exact id may
// use it (the send path, inside its own transaction via
// advanceAuthorReadState); "mark read" callers must use MarkChannelReadAtLatest,
// because clearing mentions against a stale id destroys ones raised since.
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

// channelUnreadCountsSQL reads, per visible channel, the newest live message, up to
// 100 live messages after the read marker, and the mention count, both subqueries from
// idx_messages_channel_live alone.
const channelUnreadCountsSQL = `SELECT c.id,
        (SELECT COALESCE(MAX(m.id), 0) FROM messages m
          WHERE m.channel_id = c.id AND m.deleted = 0) AS last_msg_id,
        (SELECT COUNT(*) FROM (SELECT 1 FROM messages m
          WHERE m.channel_id = c.id AND m.deleted = 0
            AND m.id > COALESCE((SELECT rs.last_message_id FROM read_states rs
                                  WHERE rs.channel_id = c.id AND rs.user_id = ?), 0)
          LIMIT 100)) AS unread,
        COALESCE((SELECT rs.mention_count FROM read_states rs
                   WHERE rs.channel_id = c.id AND rs.user_id = ?), 0) AS mentions,
        COALESCE((SELECT rs.last_message_id FROM read_states rs
                   WHERE rs.channel_id = c.id AND rs.user_id = ?), 0) AS last_read
 FROM channels c
 WHERE c.import_pending = 0
   AND (c.type IN ('text', 'announcement', 'voice')
        OR (c.type = 'dm' AND EXISTS (SELECT 1 FROM dm_participants dp
                                       WHERE dp.channel_id = c.id AND dp.user_id = ?)))`

// GetChannelUnreadCounts returns per-channel unread counts and last message
// IDs for a user, with 0,0 for empty channels. Text, announcement and voice
// channels are included, and DM channels only for this user's participation;
// the ready payload's dm_channels[] takes its mention_count from
// GetUserDMChannels instead. The DM predicate hits idx_dm_participants_user.
func (d *DB) GetChannelUnreadCounts(ctx context.Context, userID int64) (map[int64]ChannelUnread, error) {
	rows, err := d.reader.QueryContext(ctx, channelUnreadCountsSQL,
		userID, userID, userID, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("GetChannelUnreadCounts: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := make(map[int64]ChannelUnread)
	for rows.Next() {
		var chID int64
		var cu ChannelUnread
		if scanErr := rows.Scan(&chID, &cu.LastMessageID, &cu.UnreadCount, &cu.MentionCount, &cu.LastReadMessageID); scanErr != nil {
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
