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

// notBannedClause is the mention resolution's "is this user reachable" test.
// A raw `banned = 0` reads a temp-banned user as unreachable forever: nothing
// clears the column when ban_expires lapses (that happens lazily, at login,
// via auth.IsEffectivelyBanned — see db/account.go's anonymiseUser comment on
// the same split), so a reinstated user could log in and post yet never
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

// mentionCountChunkSize bounds how many recipients IncrementMentionCounts
// upserts in a single multi-row INSERT, keeping the per-exec bound-parameter
// count (2 per row) far below SQLite's limit. Mirrors the IN-list chunking in
// GetSessionsWithBanStatusBatch.
const mentionCountChunkSize = 500

// IncrementMentionCounts bumps read_states.mention_count by one for each user
// in a channel, creating the read-state row when the user has none yet.
// last_message_id stays 0 for a created row: the user has read nothing, and the
// mention they were just given is unread by definition.
//
// msgID is the id of the message that triggered this fan-out. The increment
// is skipped for a recipient whose read state already covers msgID
// (last_message_id >= msgID): a mark_read that lands between the message
// commit and this deferred call already zeroed their mention_count, and an
// unconditional increment would leave a permanent phantom badge on a channel
// with zero unread — nothing else ever zeroes it again. The guard is atomic
// with the increment itself (part of the same ON CONFLICT ... DO UPDATE ...
// WHERE), so there is no separate check-then-write race window.
//
// Batched into one multi-row INSERT per chunk of mentionCountChunkSize
// recipients instead of one exec per recipient: an @everyone mention fans out
// to every reader of a channel, and the writer txn used to pay one round trip
// per reader for that. The caller has already excluded the author, so
// semantics are unchanged — each listed user id still gets exactly one
// increment (or a fresh row seeded at 1), unless the guard above skips it.
func (d *DB) IncrementMentionCounts(ctx context.Context, channelID, msgID int64, userIDs []int64) error {
	if len(userIDs) == 0 {
		return nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("IncrementMentionCounts begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	for start := 0; start < len(userIDs); start += mentionCountChunkSize {
		chunk := userIDs[start:min(start+mentionCountChunkSize, len(userIDs))]

		rowPlaceholders := make([]string, len(chunk))
		args := make([]any, 0, len(chunk)*2)
		for i, uid := range chunk {
			rowPlaceholders[i] = "(?, ?, 0, 1)"
			args = append(args, uid, channelID)
		}
		// msgID is a bound parameter of the WHERE clause, not a VALUES column:
		// every conflicting row in this chunk shares the one message that
		// triggered the fan-out, so one trailing arg covers the whole batch.
		args = append(args, msgID)

		query := fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
			`INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count)
			 VALUES %s
			 ON CONFLICT(user_id, channel_id) DO UPDATE SET
			     mention_count = mention_count + 1
			 WHERE read_states.last_message_id < ?`,
			strings.Join(rowPlaceholders, ","),
		)
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return fmt.Errorf("IncrementMentionCounts: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("IncrementMentionCounts commit: %w", err)
	}
	return nil
}

// DecrementMentionCounts reverses the read_states.mention_count increments
// IncrementMentionCounts made for msgIDs, when those messages are deleted or
// purged. Without this, mention_count is a stored counter with no decrementer
// on the delete path at all: DeleteMessage and PurgeChannelMessages soft-delete
// the row and leave read_states untouched, while the sibling unread count is
// computed live and excludes deleted rows — so deleting the only mentioning
// message in a channel leaves a mention badge pointing at nothing.
//
// Each message is decremented separately, guarded exactly like
// IncrementMentionCounts guarded its own increment (last_message_id < msgID):
// a recipient who has since marked the channel read already had mention_count
// zeroed by that read, so this must not decrement it into a negative count
// that a later, unrelated mention would then have to climb back out of.
// mention_count > 0 keeps every step monotonic for the same reason.
//
// @everyone/@here recipients are not stored per user — message_mentions only
// holds resolved @user mentions, and the everyone/here fan-out is filtered by
// presence at send time (OC-0223) rather than persisted — so this reverses
// only stored direct mentions. That is a smaller, but never wrong, correction.
//
// message_mentions stores every resolved mention id, blockers of the author
// included (insertMentionRows deliberately does not filter — the fan-out,
// not storage, is what excludes them). But the increment side
// (applyMentionCounts in service/mentions.go) deletes the author's blockers
// from the recipient set before ever calling IncrementMentionCounts, so a
// blocker's read_states row was never bumped for this message. The NOT
// EXISTS below mirrors that same exclusion here (OC-0293): without it, a
// blocker who happens to have an unrelated, genuine mention badge on this
// same channel — from some other message — has that real badge wiped out
// when the blocked author's message is deleted, because the UPDATE cannot
// otherwise tell "never counted" apart from "counted, now reversing".
func (d *DB) DecrementMentionCounts(ctx context.Context, channelID int64, msgIDs []int64) error {
	if len(msgIDs) == 0 {
		return nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("DecrementMentionCounts begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	for _, msgID := range msgIDs {
		if _, err := tx.ExecContext(ctx,
			`UPDATE read_states
			 SET mention_count = mention_count - 1
			 WHERE channel_id = ?
			   AND mention_count > 0
			   AND last_message_id < ?
			   AND user_id IN (SELECT mentioned_user_id FROM message_mentions WHERE message_id = ?)
			   AND NOT EXISTS (
			       SELECT 1 FROM user_blocks b
			       WHERE b.blocker_id = read_states.user_id
			         AND b.blocked_id = (SELECT user_id FROM messages WHERE id = ?)
			   )`,
			channelID, msgID, msgID, msgID,
		); err != nil {
			return fmt.Errorf("DecrementMentionCounts: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("DecrementMentionCounts commit: %w", err)
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
		fmt.Sprintf( //nolint:gosec // G201: placeholders plus a named-type column constant, not user input
			`SELECT id, status, role_id FROM users WHERE %s AND %s IN (%s)`,
			notBannedClause, string(column), strings.Join(placeholders, ",")),
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", caller, err)
	}
	defer rows.Close() //nolint:errcheck

	targets := []MentionTarget{}
	for rows.Next() {
		var t MentionTarget
		if scanErr := rows.Scan(&t.UserID, &t.Status, &t.RoleID); scanErr != nil {
			return nil, fmt.Errorf("%s scan: %w", caller, scanErr)
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
