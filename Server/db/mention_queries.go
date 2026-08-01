package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// mentionExecer is the subset of *sql.Tx insertMentionRows needs, so the same
// row-writing loop serves both the insert and the edit transaction.
type mentionExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// maxMentionsPerMessage bounds how many resolved mentions a single message may
// store. The service caps its resolution at the same number; this is the
// storage-side backstop so a caller cannot widen the fan-out.
const maxMentionsPerMessage = 20

// MentionTarget is a candidate recipient of a mention fan-out: the user id, the
// presence status @here filters on, and the role the user holds (so the caller
// can apply the ADMINISTRATOR bypass when a per-user channel override would
// otherwise drop them).
type MentionTarget struct {
	UserID int64
	Status string
	RoleID int64
}

// CreateMessageWithMentions inserts a message and its resolved mentions in one
// writer transaction, so a reader can never observe a message whose mention set
// is still half-written. mentionedUserIDs is truncated to
// maxMentionsPerMessage and duplicates are ignored.
func (d *DB) CreateMessageWithMentions(ctx context.Context, channelID, userID int64, content string, replyTo *int64, mentionedUserIDs []int64, mentionsEveryone bool) (*Message, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("CreateMessageWithMentions begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	var m Message
	var deleted, pinned, everyone int64
	if scanErr := tx.QueryRowContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content, reply_to, mentions_everyone)
		 VALUES (?, ?, ?, ?, ?)
		 RETURNING id, channel_id, user_id, content, reply_to, edited_at, deleted, pinned,
		           timestamp, mentions_everyone`,
		channelID, userID, content, replyTo, b2i64(mentionsEveryone),
	).Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.ReplyTo, &m.EditedAt,
		&deleted, &pinned, &m.Timestamp, &everyone); scanErr != nil {
		return nil, fmt.Errorf("CreateMessageWithMentions insert: %w", scanErr)
	}
	m.Deleted = deleted != 0
	m.Pinned = pinned != 0
	m.MentionsEveryone = everyone != 0

	if err := insertMentionRows(ctx, tx, m.ID, mentionedUserIDs); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("CreateMessageWithMentions commit: %w", err)
	}
	return &m, nil
}

// ReplaceMessageMentions rewrites a message's mention set and its
// mentions_everyone flag in one writer transaction. Used by edits, which
// re-resolve mentions from the new content.
func (d *DB) ReplaceMessageMentions(ctx context.Context, messageID int64, mentionedUserIDs []int64, mentionsEveryone bool) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("ReplaceMessageMentions begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.ExecContext(ctx, `DELETE FROM message_mentions WHERE message_id = ?`, messageID); err != nil {
		return fmt.Errorf("ReplaceMessageMentions delete: %w", err)
	}
	// Guarded so an edit that does not change the flag skips the write — an
	// UPDATE on messages re-indexes the row through the messages_fts triggers.
	if _, err := tx.ExecContext(ctx,
		`UPDATE messages SET mentions_everyone = ? WHERE id = ? AND mentions_everyone != ?`,
		b2i64(mentionsEveryone), messageID, b2i64(mentionsEveryone),
	); err != nil {
		return fmt.Errorf("ReplaceMessageMentions flag: %w", err)
	}
	if err := insertMentionRows(ctx, tx, messageID, mentionedUserIDs); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("ReplaceMessageMentions commit: %w", err)
	}
	return nil
}

// insertMentionRows writes the mention rows for one message inside tx.
// Self-mentions are stored like any other: the fan-out, not storage, is what
// excludes the author.
func insertMentionRows(ctx context.Context, tx mentionExecer, messageID int64, mentionedUserIDs []int64) error {
	if len(mentionedUserIDs) > maxMentionsPerMessage {
		mentionedUserIDs = mentionedUserIDs[:maxMentionsPerMessage]
	}
	for _, uid := range mentionedUserIDs {
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO message_mentions (message_id, mentioned_user_id) VALUES (?, ?)`,
			messageID, uid,
		); err != nil {
			return fmt.Errorf("insertMentionRows: %w", err)
		}
	}
	return nil
}

// GetMentionsByMessageIDs returns the mentioned user ids per message id.
// Messages with no mentions are absent from the map.
func (d *DB) GetMentionsByMessageIDs(ctx context.Context, msgIDs []int64) (map[int64][]int64, error) {
	result := make(map[int64][]int64)
	if len(msgIDs) == 0 {
		return result, nil
	}

	placeholders := make([]string, len(msgIDs))
	args := make([]any, len(msgIDs))
	for i, id := range msgIDs {
		placeholders[i] = "?"
		args[i] = id
	}

	rows, err := d.reader.QueryContext(ctx,
		fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
			`SELECT message_id, mentioned_user_id FROM message_mentions
			 WHERE message_id IN (%s) ORDER BY message_id, mentioned_user_id`,
			strings.Join(placeholders, ",")),
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("GetMentionsByMessageIDs: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	for rows.Next() {
		var msgID, userID int64
		if scanErr := rows.Scan(&msgID, &userID); scanErr != nil {
			return nil, fmt.Errorf("GetMentionsByMessageIDs scan: %w", scanErr)
		}
		result[msgID] = append(result[msgID], userID)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetMentionsByMessageIDs rows: %w", rows.Err())
	}
	return result, nil
}

// IncrementMentionCounts bumps read_states.mention_count by one for each user
// in a channel, creating the read-state row when the user has none yet.
// last_message_id stays 0 for a created row: the user has read nothing, and the
// mention they were just given is unread by definition.
func (d *DB) IncrementMentionCounts(ctx context.Context, channelID int64, userIDs []int64) error {
	if len(userIDs) == 0 {
		return nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("IncrementMentionCounts begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	for _, uid := range userIDs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count)
			 VALUES (?, ?, 0, 1)
			 ON CONFLICT(user_id, channel_id) DO UPDATE SET
			     mention_count = mention_count + 1`,
			uid, channelID,
		); err != nil {
			return fmt.Errorf("IncrementMentionCounts: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("IncrementMentionCounts commit: %w", err)
	}
	return nil
}

// GetMentionCount returns the unread mention count for a user in a channel.
func (d *DB) GetMentionCount(ctx context.Context, userID, channelID int64) (int, error) {
	var count int
	err := d.reader.QueryRowContext(ctx,
		`SELECT COALESCE((SELECT mention_count FROM read_states
		                   WHERE user_id = ? AND channel_id = ?), 0)`,
		userID, channelID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("GetMentionCount: %w", err)
	}
	return count, nil
}

// GetUserIDsByUsernames resolves usernames to ids, keyed by the lowercased
// username. Matching is case-insensitive because users.username is UNIQUE
// COLLATE NOCASE, which makes the column's comparisons case-insensitive too.
func (d *DB) GetUserIDsByUsernames(ctx context.Context, usernames []string) (map[string]int64, error) {
	result := make(map[string]int64)
	if len(usernames) == 0 {
		return result, nil
	}

	placeholders := make([]string, len(usernames))
	args := make([]any, len(usernames))
	for i, name := range usernames {
		placeholders[i] = "?"
		args[i] = name
	}

	rows, err := d.reader.QueryContext(ctx,
		fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
			`SELECT id, username FROM users WHERE banned = 0 AND username IN (%s)`,
			strings.Join(placeholders, ",")),
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("GetUserIDsByUsernames: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	for rows.Next() {
		var id int64
		var name string
		if scanErr := rows.Scan(&id, &name); scanErr != nil {
			return nil, fmt.Errorf("GetUserIDsByUsernames scan: %w", scanErr)
		}
		result[strings.ToLower(name)] = id
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetUserIDsByUsernames rows: %w", rows.Err())
	}
	return result, nil
}

// ListMentionTargetsByRoles returns non-banned users holding any of the given
// roles, with the presence status @here filters on.
func (d *DB) ListMentionTargetsByRoles(ctx context.Context, roleIDs []int64) ([]MentionTarget, error) {
	if len(roleIDs) == 0 {
		return []MentionTarget{}, nil
	}

	placeholders := make([]string, len(roleIDs))
	args := make([]any, len(roleIDs))
	for i, id := range roleIDs {
		placeholders[i] = "?"
		args[i] = id
	}

	rows, err := d.reader.QueryContext(ctx,
		fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
			`SELECT id, status, role_id FROM users WHERE banned = 0 AND role_id IN (%s)`,
			strings.Join(placeholders, ",")),
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("ListMentionTargetsByRoles: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	targets := []MentionTarget{}
	for rows.Next() {
		var t MentionTarget
		if scanErr := rows.Scan(&t.UserID, &t.Status, &t.RoleID); scanErr != nil {
			return nil, fmt.Errorf("ListMentionTargetsByRoles scan: %w", scanErr)
		}
		targets = append(targets, t)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("ListMentionTargetsByRoles rows: %w", rows.Err())
	}
	return targets, nil
}

// ListMentionTargetsByUserIDs returns non-banned users by explicit id, with the
// same fields ListMentionTargetsByRoles returns. It backs the additive half of
// the per-user channel override layer: a member whose user override ALLOWs
// READ_MESSAGES can read a channel their role cannot, so the role walk alone
// would leave them out of an @everyone fan-out they are entitled to.
func (d *DB) ListMentionTargetsByUserIDs(ctx context.Context, userIDs []int64) ([]MentionTarget, error) {
	if len(userIDs) == 0 {
		return []MentionTarget{}, nil
	}

	placeholders := make([]string, len(userIDs))
	args := make([]any, len(userIDs))
	for i, id := range userIDs {
		placeholders[i] = "?"
		args[i] = id
	}

	rows, err := d.reader.QueryContext(ctx,
		fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
			`SELECT id, status, role_id FROM users WHERE banned = 0 AND id IN (%s)`,
			strings.Join(placeholders, ",")),
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("ListMentionTargetsByUserIDs: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	targets := []MentionTarget{}
	for rows.Next() {
		var t MentionTarget
		if scanErr := rows.Scan(&t.UserID, &t.Status, &t.RoleID); scanErr != nil {
			return nil, fmt.Errorf("ListMentionTargetsByUserIDs scan: %w", scanErr)
		}
		targets = append(targets, t)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("ListMentionTargetsByUserIDs rows: %w", rows.Err())
	}
	return targets, nil
}

// ListBlockersOf returns the ids of users who have blocked the given user.
// A mention from a blocked user must not raise the blocker's mention badge.
func (d *DB) ListBlockersOf(ctx context.Context, blockedID int64) ([]int64, error) {
	ids, err := d.q.ListBlockersOfUser(ctx, blockedID)
	if err != nil {
		return nil, fmt.Errorf("ListBlockersOf: %w", err)
	}
	return ids, nil
}

// GetChannelOverrides returns every role override on a channel, keyed by role
// id. The per-role reverse (GetAllChannelPermissionsForRole) backs the
// per-user permission cache; this direction backs the @everyone fan-out, which
// needs every role's verdict on one channel.
func (d *DB) GetChannelOverrides(ctx context.Context, channelID int64) (map[int64]ChannelOverride, error) {
	rows, err := d.q.GetChannelOverrides(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("GetChannelOverrides: %w", err)
	}
	result := make(map[int64]ChannelOverride, len(rows))
	for _, r := range rows {
		result[r.RoleID] = ChannelOverride{Allow: r.Allow, Deny: r.Deny}
	}
	return result, nil
}
