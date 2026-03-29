package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ─── DM Models ──────────────────────────────────────────────────────────────

// DMChannelInfo holds a DM channel summary for the channel list.
type DMChannelInfo struct {
	ChannelID     int64   `json:"channel_id"`
	Recipient     DMUser  `json:"recipient"`
	LastMessageID *int64  `json:"last_message_id"`
	LastMessage   string  `json:"last_message"`
	LastMessageAt string  `json:"last_message_at"`
	UnreadCount   int     `json:"unread_count"`
}

// DMUser is the public-facing shape for a DM participant.
type DMUser struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
	Status   string `json:"status"`
}

// ─── GetOrCreateDMChannel ───────────────────────────────────────────────────

// GetOrCreateDMChannel finds or creates a DM channel between two users.
// Returns the channel, whether it was newly created, and any error.
// The entire lookup+create is wrapped in a single IMMEDIATE transaction to
// prevent a TOCTOU race where two concurrent requests both see ErrNoRows and
// each create a separate DM channel for the same user pair.
func (d *DB) GetOrCreateDMChannel(user1ID, user2ID int64) (*Channel, bool, error) {
	tx, err := d.sqlDB.BeginTx(context.Background(), &sql.TxOptions{
		Isolation: sql.LevelSerializable,
	})
	if err != nil {
		return nil, false, fmt.Errorf("GetOrCreateDMChannel begin tx: %w", err)
	}

	// Check for an existing DM channel inside the transaction.
	var existingID int64
	err = tx.QueryRow(
		`SELECT dp1.channel_id FROM dm_participants dp1
		 JOIN dm_participants dp2 ON dp1.channel_id = dp2.channel_id
		 JOIN channels c ON c.id = dp1.channel_id
		 WHERE dp1.user_id = ? AND dp2.user_id = ? AND c.type = 'dm'
		 LIMIT 1`,
		user1ID, user2ID,
	).Scan(&existingID)

	if err == nil {
		// Existing channel found — ensure the calling user has it open (re-open
		// is idempotent). Without this, a user who previously closed the DM would
		// not see it in their sidebar after the other party re-initiates.
		_, _ = tx.Exec(
			`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`,
			user1ID, existingID,
		)
		if commitErr := tx.Commit(); commitErr != nil {
			return nil, false, fmt.Errorf("GetOrCreateDMChannel commit existing: %w", commitErr)
		}
		ch, getErr := d.GetChannel(existingID)
		if getErr != nil {
			return nil, false, fmt.Errorf("GetOrCreateDMChannel fetch existing: %w", getErr)
		}
		if ch == nil {
			return nil, false, fmt.Errorf("GetOrCreateDMChannel: channel %d vanished", existingID)
		}
		return ch, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return nil, false, fmt.Errorf("GetOrCreateDMChannel lookup: %w", err)
	}

	// No existing DM — create one inside the same transaction.

	// Insert channel with type 'dm' and empty name.
	res, err := tx.Exec(
		`INSERT INTO channels (name, type) VALUES ('', 'dm')`,
	)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, fmt.Errorf("GetOrCreateDMChannel insert channel: %w", err)
	}
	channelID, err := res.LastInsertId()
	if err != nil {
		_ = tx.Rollback()
		return nil, false, fmt.Errorf("GetOrCreateDMChannel last insert id: %w", err)
	}

	// Insert both participants.
	_, err = tx.Exec(
		`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?), (?, ?)`,
		channelID, user1ID, channelID, user2ID,
	)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, fmt.Errorf("GetOrCreateDMChannel insert participants: %w", err)
	}

	// Open the DM for both users.
	_, err = tx.Exec(
		`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?), (?, ?)`,
		user1ID, channelID, user2ID, channelID,
	)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, fmt.Errorf("GetOrCreateDMChannel open dm: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, false, fmt.Errorf("GetOrCreateDMChannel commit: %w", err)
	}

	ch, err := d.GetChannel(channelID)
	if err != nil {
		return nil, false, fmt.Errorf("GetOrCreateDMChannel fetch new: %w", err)
	}
	return ch, true, nil
}

// ─── GetUserDMChannels ──────────────────────────────────────────────────────

// GetUserDMChannels returns all open DM channels for a user with recipient info,
// last message preview, and unread count. Ordered by most recent activity.
//
// Note: the SQL JOIN on dm_open_state already restricts results to DM channels
// (dm_open_state only contains rows for DM channels), and the explicit
// "c.type = 'dm'" predicate in the JOIN provides a defensive second check.
// No additional channel-type validation is needed at the Go layer.
func (d *DB) GetUserDMChannels(userID int64) ([]DMChannelInfo, error) {
	rows, err := d.sqlDB.Query(
		`SELECT
		    c.id                                          AS channel_id,
		    u.id                                          AS recipient_id,
		    u.username                                    AS recipient_username,
		    COALESCE(u.avatar, '')                        AS recipient_avatar,
		    u.status                                      AS recipient_status,
		    lm.id                                         AS last_message_id,
		    COALESCE(lm.content, '')                      AS last_message,
		    COALESCE(lm.timestamp, '')                    AS last_message_at,
		    COUNT(CASE WHEN m_unread.id > COALESCE(rs.last_message_id, 0)
		               AND m_unread.deleted = 0 THEN 1 END) AS unread_count
		 FROM dm_open_state dos
		 JOIN channels c          ON c.id = dos.channel_id AND c.type = 'dm'
		 JOIN dm_participants dp  ON dp.channel_id = c.id AND dp.user_id != ?
		 JOIN users u             ON u.id = dp.user_id
		 LEFT JOIN messages lm    ON lm.id = (
		     SELECT MAX(id) FROM messages WHERE channel_id = c.id AND deleted = 0
		 )
		 LEFT JOIN messages m_unread ON m_unread.channel_id = c.id
		 LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
		 WHERE dos.user_id = ?
		 GROUP BY c.id
		 ORDER BY COALESCE(lm.timestamp, dos.opened_at) DESC`,
		userID, userID, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("GetUserDMChannels: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var result []DMChannelInfo
	for rows.Next() {
		var info DMChannelInfo
		var lastMsgID sql.NullInt64
		if scanErr := rows.Scan(
			&info.ChannelID,
			&info.Recipient.ID,
			&info.Recipient.Username,
			&info.Recipient.Avatar,
			&info.Recipient.Status,
			&lastMsgID,
			&info.LastMessage,
			&info.LastMessageAt,
			&info.UnreadCount,
		); scanErr != nil {
			return nil, fmt.Errorf("GetUserDMChannels scan: %w", scanErr)
		}
		if lastMsgID.Valid {
			id := lastMsgID.Int64
			info.LastMessageID = &id
		}
		result = append(result, info)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetUserDMChannels rows: %w", rows.Err())
	}
	if result == nil {
		result = []DMChannelInfo{}
	}
	return result, nil
}

// ─── OpenDM / CloseDM ──────────────────────────────────────────────────────

// OpenDM adds a DM channel to a user's open list (idempotent).
func (d *DB) OpenDM(userID, channelID int64) error {
	_, err := d.sqlDB.Exec(
		`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`,
		userID, channelID,
	)
	if err != nil {
		return fmt.Errorf("OpenDM: %w", err)
	}
	return nil
}

// CloseDM removes a DM channel from a user's open list.
func (d *DB) CloseDM(userID, channelID int64) error {
	_, err := d.sqlDB.Exec(
		`DELETE FROM dm_open_state WHERE user_id = ? AND channel_id = ?`,
		userID, channelID,
	)
	if err != nil {
		return fmt.Errorf("CloseDM: %w", err)
	}
	return nil
}

// ─── Participant helpers ────────────────────────────────────────────────────

// IsDMParticipant checks if a user is a participant in a DM channel.
func (d *DB) IsDMParticipant(userID, channelID int64) (bool, error) {
	var id int64
	err := d.sqlDB.QueryRow(
		`SELECT user_id FROM dm_participants WHERE user_id = ? AND channel_id = ?`,
		userID, channelID,
	).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("IsDMParticipant: %w", err)
	}
	return true, nil
}

// GetDMParticipantIDs returns all participant user IDs for a DM channel.
func (d *DB) GetDMParticipantIDs(channelID int64) ([]int64, error) {
	rows, err := d.sqlDB.Query(
		`SELECT user_id FROM dm_participants WHERE channel_id = ?`,
		channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("GetDMParticipantIDs: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var ids []int64
	for rows.Next() {
		var id int64
		if scanErr := rows.Scan(&id); scanErr != nil {
			return nil, fmt.Errorf("GetDMParticipantIDs scan: %w", scanErr)
		}
		ids = append(ids, id)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetDMParticipantIDs rows: %w", rows.Err())
	}
	return ids, nil
}

// GetDMRecipient returns the other participant in a DM channel.
func (d *DB) GetDMRecipient(channelID, requestingUserID int64) (*User, error) {
	var recipientID int64
	err := d.sqlDB.QueryRow(
		`SELECT user_id FROM dm_participants
		 WHERE channel_id = ? AND user_id != ?
		 LIMIT 1`,
		channelID, requestingUserID,
	).Scan(&recipientID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetDMRecipient lookup: %w", err)
	}
	return d.GetUserByID(recipientID)
}
