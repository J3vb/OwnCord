package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// mentionExecer is the subset of *sql.Tx insertMentionRows needs, so the same
// row-writing loop serves both the insert and the edit transaction.
type mentionExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// maxMentionsPerMessage bounds the resolved mentions one message may store; the
// service caps at the same number and this is the storage-side backstop.
const maxMentionsPerMessage = 20

// notBannedClause is the mention resolution's "is this user reachable" test.
// A raw `banned = 0` would read a temp-banned user as unreachable forever,
// because nothing clears the column when ban_expires lapses (that happens
// lazily at login via auth.IsEffectivelyBanned). This mirrors that rule:
// permanent when ban_expires is NULL, lapsed once it is past.
//
// The comparison is lexical, and IsEffectivelyBanned accepts two spellings:
// BanUser's ISO-8601 'Z' form and the SQLite space form (test-locked in
// auth/helpers_test.go). A bare ' ' sorts below 'T', so an unnormalised
// space-form expiry later the same day would compare as lapsed and fail open,
// un-hiding a banned user; replace() normalises the separator first. The
// trailing 'Z' only makes the reference longer at an equal instant, which `<=`
// already treats as lapsed.
const notBannedClause = `(banned = 0 OR (ban_expires IS NOT NULL AND replace(ban_expires, ' ', 'T') <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`

// MentionTarget is a candidate recipient of a mention fan-out: the user id, the
// presence status @here filters on, and the held roles so the caller can apply
// the ADMINISTRATOR bypass when a per-user channel override would drop them.
// RoleID is the top role (the users.role_id mirror), RoleIDs every held role;
// the bypass applies when any has it.
type MentionTarget struct {
	UserID  int64
	Status  string
	RoleID  int64
	RoleIDs []int64
}

// CreateMessageWithMentions inserts a message and its resolved mentions in one
// writer transaction, so a reader never sees a half-written mention set.
// mentionedUserIDs is truncated to maxMentionsPerMessage with duplicates
// ignored. The same transaction advances the author's read state
// (advanceAuthorReadState). replyPingUserID (0 = none) is the replied-to author
// a reply_ping adds on top of the capped mentions (see insertMentionRows);
// mentionedRoleIDs land in message_role_mentions.
func (d *DB) CreateMessageWithMentions(ctx context.Context, channelID, userID int64, content string, replyTo *int64, mentionedUserIDs []int64, replyPingUserID int64, mentionsEveryone bool, mentionedRoleIDs []int64) (*Message, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("CreateMessageWithMentions begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	if err := refuseWhileErasing(ctx, tx, userID); err != nil {
		return nil, fmt.Errorf("CreateMessageWithMentions: %w", err)
	}

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

	if err := insertAllMentionRows(ctx, tx, m.ID, mentionedUserIDs, replyPingUserID, mentionedRoleIDs, false); err != nil {
		return nil, err
	}
	advanceAuthorReadState(ctx, d.q.WithTx(tx), userID, channelID, m.ID)
	joined, err := threadPostEffects(ctx, d.q.WithTx(tx), channelID, userID, mentionedUserIDs, replyPingUserID)
	if err != nil {
		return nil, fmt.Errorf("CreateMessageWithMentions: %w", err)
	}
	m.ThreadJoined = joined
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("CreateMessageWithMentions commit: %w", err)
	}
	return &m, nil
}

// ReplaceMessageMentions rewrites a message's content-derived mention set and
// mentions_everyone flag in one writer transaction, for edits. A reply_ping row
// is not content-derived and survives the rewrite; its user id is returned (0
// when none) so the edit broadcast keeps the highlight.
func (d *DB) ReplaceMessageMentions(ctx context.Context, messageID int64, mentionedUserIDs []int64, mentionsEveryone bool, mentionedRoleIDs []int64) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("ReplaceMessageMentions begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.ExecContext(ctx, `DELETE FROM message_mentions WHERE message_id = ? AND reply_ping = 0`, messageID); err != nil {
		return 0, fmt.Errorf("ReplaceMessageMentions delete: %w", err)
	}
	// Guarded so an unchanged flag skips the write: an UPDATE on messages
	// re-indexes the row through the messages_fts triggers.
	if _, err := tx.ExecContext(ctx,
		`UPDATE messages SET mentions_everyone = ? WHERE id = ? AND mentions_everyone != ?`,
		b2i64(mentionsEveryone), messageID, b2i64(mentionsEveryone),
	); err != nil {
		return 0, fmt.Errorf("ReplaceMessageMentions flag: %w", err)
	}
	var replyPingUserID int64
	switch err := tx.QueryRowContext(ctx,
		`SELECT mentioned_user_id FROM message_mentions WHERE message_id = ? AND reply_ping = 1`, messageID,
	).Scan(&replyPingUserID); {
	case errors.Is(err, sql.ErrNoRows):
		replyPingUserID = 0
	case err != nil:
		return 0, fmt.Errorf("ReplaceMessageMentions reply row: %w", err)
	}
	// Passing the kept target lets the content cap skip it, the same as on send.
	if err := insertAllMentionRows(ctx, tx, messageID, mentionedUserIDs, replyPingUserID, mentionedRoleIDs, true); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("ReplaceMessageMentions commit: %w", err)
	}
	return replyPingUserID, nil
}

// insertMentionRows writes the mention rows for one message inside tx.
// Self-mentions are stored like any other; the fan-out excludes the author.
// Content ids are capped at maxMentionsPerMessage after the reply-ping user is
// removed, then the reply-ping row is upserted on top, so the target is never
// displaced and a message holds at most maxMentionsPerMessage+1 rows. If the
// content also names the target, the one row is flagged reply_ping = 1.
func insertMentionRows(ctx context.Context, tx mentionExecer, messageID int64, mentionedUserIDs []int64, replyPingUserID int64) error {
	for _, uid := range contentMentionIDs(mentionedUserIDs, replyPingUserID) {
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO message_mentions (message_id, mentioned_user_id) VALUES (?, ?)`,
			messageID, uid,
		); err != nil {
			return fmt.Errorf("insertMentionRows: %w", err)
		}
	}
	if replyPingUserID != 0 {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO message_mentions (message_id, mentioned_user_id, reply_ping) VALUES (?, ?, 1)
			 ON CONFLICT(message_id, mentioned_user_id) DO UPDATE SET reply_ping = 1`,
			messageID, replyPingUserID,
		); err != nil {
			return fmt.Errorf("insertMentionRows reply ping: %w", err)
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

// mentionCountChunkSize bounds the recipients IncrementMentionCounts upserts
// per multi-row INSERT, keeping bound parameters (2 per row) far below SQLite's
// limit.
const mentionCountChunkSize = 500

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

// LowerASCII lowercases only 'A'-'Z', matching the fold SQLite's COLLATE NOCASE
// applies to users.username. strings.ToLower is Unicode-aware and would fold
// letters NOCASE leaves alone (e.g. 'É'), desyncing a Go-side key from a query
// against the column, so every mention lookup key must fold through this.
func LowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

// GetUserIDsByUsernames resolves usernames to ids, keyed by the ASCII-lowered
// username (see LowerASCII). users.username is UNIQUE COLLATE NOCASE, which is
// case-insensitive but ASCII-only, so the key folds no harder than that.
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
			`SELECT id, username FROM users WHERE %s AND username IN (%s)`,
			notBannedClause, strings.Join(placeholders, ",")),
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
		result[LowerASCII(name)] = id
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetUserIDsByUsernames rows: %w", rows.Err())
	}
	return result, nil
}

// mentionTargetColumn is the users column a mention-target lookup matches its
// id list against. A named type makes call sites name one of the constants
// below rather than pass an arbitrary string into the SELECT; Go named types
// are not closed, so do not convert a runtime value into it.
type mentionTargetColumn string

const (
	mentionTargetsByRole mentionTargetColumn = "role_id"
	mentionTargetsByUser mentionTargetColumn = "id"
)

// mentionTargetFilter is the WHERE predicate for a column, over users aliased
// u. Matching a role walks user_roles, so a member with several roles is
// listed once.
func mentionTargetFilter(column mentionTargetColumn, placeholders string) string {
	if column == mentionTargetsByRole {
		return `EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id IN (` + placeholders + `))`
	}
	return `u.id IN (` + placeholders + `)`
}

// listMentionTargets returns non-banned users whose column is in ids, with the
// presence status @here filters on; the shared body of the two
// ListMentionTargetsBy functions, which differ in column and error name.
func (d *DB) listMentionTargets(ctx context.Context, column mentionTargetColumn, caller string, ids []int64) ([]MentionTarget, error) {
	if len(ids) == 0 {
		return []MentionTarget{}, nil
	}

	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}

	rows, err := d.reader.QueryContext(ctx,
		fmt.Sprintf( //nolint:gosec // G201: placeholders plus a closed filter chosen by a named-type constant, not user input
			`SELECT u.id, u.status, u.role_id,
			        COALESCE((SELECT group_concat(ur2.role_id) FROM user_roles ur2 WHERE ur2.user_id = u.id), '')
			 FROM users u WHERE %s AND %s`,
			notBannedClause, mentionTargetFilter(column, strings.Join(placeholders, ","))),
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", caller, err)
	}
	defer rows.Close() //nolint:errcheck

	targets := []MentionTarget{}
	for rows.Next() {
		var t MentionTarget
		var held string
		if scanErr := rows.Scan(&t.UserID, &t.Status, &t.RoleID, &held); scanErr != nil {
			return nil, fmt.Errorf("%s scan: %w", caller, scanErr)
		}
		for f := range strings.SplitSeq(held, ",") {
			if id, perr := strconv.ParseInt(f, 10, 64); perr == nil {
				t.RoleIDs = append(t.RoleIDs, id)
			}
		}
		targets = append(targets, t)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("%s rows: %w", caller, rows.Err())
	}
	return targets, nil
}

// ListMentionTargetsByRoles returns non-banned users holding any of the given
// roles, with the presence status @here filters on.
func (d *DB) ListMentionTargetsByRoles(ctx context.Context, roleIDs []int64) ([]MentionTarget, error) {
	return d.listMentionTargets(ctx, mentionTargetsByRole, "ListMentionTargetsByRoles", roleIDs)
}

// ListMentionTargetsByUserIDs returns non-banned users by explicit id, with the
// same fields as ListMentionTargetsByRoles. It backs the per-user channel
// override layer: a member whose override ALLOWs READ_MESSAGES can read a
// channel their role cannot, and the role walk alone would miss them in an
// @everyone fan-out.
func (d *DB) ListMentionTargetsByUserIDs(ctx context.Context, userIDs []int64) ([]MentionTarget, error) {
	return d.listMentionTargets(ctx, mentionTargetsByUser, "ListMentionTargetsByUserIDs", userIDs)
}

// ListBlockersOf returns the ids of users who blocked the given user; a
// mention from a blocked user must not raise the blocker's badge.
func (d *DB) ListBlockersOf(ctx context.Context, blockedID int64) ([]int64, error) {
	ids, err := d.q.ListBlockersOfUser(ctx, blockedID)
	if err != nil {
		return nil, fmt.Errorf("ListBlockersOf: %w", err)
	}
	return ids, nil
}

// GetChannelOverrides returns every role override on a channel, keyed by role
// id, for the @everyone fan-out that needs every role's verdict. The per-role
// reverse (GetAllChannelPermissionsForRole) backs the permission cache.
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
