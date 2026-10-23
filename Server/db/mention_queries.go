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

// maxMentionsPerMessage bounds how many resolved mentions a single message may
// store. The service caps its resolution at the same number; this is the
// storage-side backstop so a caller cannot widen the fan-out.
const maxMentionsPerMessage = 20

// notBannedClause is the mention resolution's "is this user reachable" test.
// A raw `banned = 0` reads a temp-banned user as unreachable forever: nothing
// clears the column when ban_expires lapses (that happens lazily, at login,
// via auth.IsEffectivelyBanned — see db/account_test.go's lapsed-temp-ban
// row on the same split), so a reinstated user could log in and post yet never
// resolve as an @mention target or appear in an @everyone/@here fan-out. This
// mirrors IsEffectivelyBanned's own rule (permanent when ban_expires is NULL,
// lapsed once ban_expires is in the past) so the two never disagree.
//
// The comparison is lexical, so the two ban_expires spellings
// IsEffectivelyBanned accepts must both sort correctly against the reference
// string. BanUser writes ISO-8601 'Z' ("2006-01-02T15:04:05Z"), but the
// SQLite space form ("2006-01-02 15:04:05") is equally accepted there and
// test-locked (auth/helpers_test.go), and a bare ' ' sorts BELOW 'T' — so an
// unnormalised space-form expiry later on the same day would compare as
// already lapsed and fail OPEN, un-hiding a genuinely banned user. replace()
// normalises the separator first; the trailing 'Z' only ever makes the
// reference string longer at an equal instant, which the `<=` already treats
// as lapsed. Those two are the only spellings any writer produces.
const notBannedClause = `(banned = 0 OR (ban_expires IS NOT NULL AND replace(ban_expires, ' ', 'T') <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`

// MentionTarget is a candidate recipient of a mention fan-out: the user id, the
// presence status @here filters on, and the roles the user holds (so the caller
// can apply the ADMINISTRATOR bypass when a per-user channel override would
// otherwise drop them). RoleID is the top role (the users.role_id mirror),
// RoleIDs every held role: the bypass applies when ANY held role has it.
type MentionTarget struct {
	UserID  int64
	Status  string
	RoleID  int64
	RoleIDs []int64
}

// CreateMessageWithMentions inserts a message and its resolved mentions in one
// writer transaction, so a reader can never observe a message whose mention set
// is still half-written. mentionedUserIDs is truncated to
// maxMentionsPerMessage and duplicates are ignored. The same transaction
// advances the author's read state past the message (advanceAuthorReadState).
// replyPingUserID (0 = none) is the replied-to author a reply_ping adds on top
// of the capped content mentions; see insertMentionRows. mentionedRoleIDs land
// in message_role_mentions in the same transaction.
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
// its mentions_everyone flag in one writer transaction. Used by edits, which
// re-resolve mentions from the new content. A row flagged reply_ping is not
// content-derived: it survives the rewrite (a content mention of the same user
// leaves it in place) and its user id is returned, 0 when the message holds
// none, so the edit broadcast keeps the highlight.
func (d *DB) ReplaceMessageMentions(ctx context.Context, messageID int64, mentionedUserIDs []int64, mentionsEveryone bool, mentionedRoleIDs []int64) (int64, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("ReplaceMessageMentions begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.ExecContext(ctx, `DELETE FROM message_mentions WHERE message_id = ? AND reply_ping = 0`, messageID); err != nil {
		return 0, fmt.Errorf("ReplaceMessageMentions delete: %w", err)
	}
	// Guarded so an edit that does not change the flag skips the write — an
	// UPDATE on messages re-indexes the row through the messages_fts triggers.
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
// Self-mentions are stored like any other: the fan-out, not storage, is what
// excludes the author. The content ids are capped at maxMentionsPerMessage
// after the reply-ping user is removed from them, then the reply-ping row is
// upserted on top, so the target is never displaced and a message holds at
// most maxMentionsPerMessage+1 rows. When the content also names the target
// the one row ends up flagged reply_ping = 1.
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

// mentionCountChunkSize bounds how many recipients IncrementMentionCounts
// upserts in a single multi-row INSERT, keeping the per-exec bound-parameter
// count (2 per row) far below SQLite's limit. Mirrors the IN-list chunking in
// GetSessionsWithBanStatusBatch.
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

// LowerASCII lowercases only ASCII letters ('A'-'Z'), matching the fold
// SQLite's COLLATE NOCASE applies to users.username (see notBannedClause's
// sibling comment above and the migration that declares the column). Go's
// strings.ToLower is Unicode-aware and would fold a non-ASCII uppercase
// letter (e.g. 'É' -> 'é') that NOCASE does not touch, desyncing a Go-side
// lookup key from a query bound against the same column. Every mention
// lookup that builds a key or a query argument from a username must fold
// through this instead of strings.ToLower, or the two folds silently
// disagree on any non-ASCII-uppercase username.
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
// username (see LowerASCII). Matching is case-insensitive because
// users.username is UNIQUE COLLATE NOCASE, which makes the column's
// comparisons case-insensitive too -- but ASCII-only, which is why the map
// key folds no harder than that.
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
// id list against. It is a named type rather than a bare string so that every
// call site has to name one of the two constants below instead of passing an
// arbitrary string into the SELECT. Go named types are not closed, so this is
// a convention the type makes visible, not one it enforces: do not introduce a
// mentionTargetColumn(x) conversion from a runtime value.
type mentionTargetColumn string

const (
	mentionTargetsByRole mentionTargetColumn = "role_id"
	mentionTargetsByUser mentionTargetColumn = "id"
)

// mentionTargetFilter is the WHERE predicate for a column, over users aliased u.
// Matching a role walks user_roles, so a member holding several roles is
// listed once and counted for any of them.
func mentionTargetFilter(column mentionTargetColumn, placeholders string) string {
	if column == mentionTargetsByRole {
		return `EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id IN (` + placeholders + `))`
	}
	return `u.id IN (` + placeholders + `)`
}

// listMentionTargets returns non-banned users whose column is in ids, with the
// presence status @here filters on. It is the shared body of
// ListMentionTargetsByRoles and ListMentionTargetsByUserIDs, which differ only
// in the column they match and the name they report in errors.
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
// same fields ListMentionTargetsByRoles returns. It backs the additive half of
// the per-user channel override layer: a member whose user override ALLOWs
// READ_MESSAGES can read a channel their role cannot, so the role walk alone
// would leave them out of an @everyone fan-out they are entitled to.
func (d *DB) ListMentionTargetsByUserIDs(ctx context.Context, userIDs []int64) ([]MentionTarget, error) {
	return d.listMentionTargets(ctx, mentionTargetsByUser, "ListMentionTargetsByUserIDs", userIDs)
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
