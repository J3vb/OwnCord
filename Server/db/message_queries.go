package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// messageFromGen maps a generated message row to the domain Message model.
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

// sanitizeFTSQuery strips FTS5 operator characters from user input to prevent
// query injection. Letters, digits and spaces pass through; every other rune
// folds to a space.
//
// Folding, not dropping, is what makes punctuation searchable: messages_fts
// uses the unicode61 tokenizer, so "user_id" is indexed as `user` and `id`,
// and dropping the underscore would ask for the single term `userid`, which
// matches nothing. '-' would otherwise introduce a column filter and make
// SQLite error.
//
// FTS5 also treats bareword AND, OR and NOT (uppercase) as operators, and a
// query that starts or ends with one raises "fts5: syntax error". Such tokens
// are dropped so the result is always plain barewords.
func sanitizeFTSQuery(q string) string {
	var sb strings.Builder
	sb.Grow(len(q))
	for _, r := range q {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			sb.WriteRune(r)
			continue
		}
		// unicode61 keeps the combining diacritics block (U+0300-U+036F) inside the
		// token and strips it, so splitting on one would turn NFD "résumé" into
		// "re sume". Other marks are separators there and stay separators here.
		if r >= 0x0300 && r <= 0x036F {
			continue
		}
		// Everything else (unicode61 separators and FTS5 grammar characters such as
		// quotes, parens, '*', '^', ':') becomes a separator, which keeps the
		// operator syntax inert.
		sb.WriteRune(' ')
	}
	result := strings.TrimSpace(sb.String())
	// Bound FTS processing by rune count, not bytes, to avoid splitting runes.
	if runes := []rune(result); len(runes) > 200 {
		result = string(runes[:200])
	}

	fields := strings.Fields(result)
	kept := fields[:0]
	for _, f := range fields {
		if f == "AND" || f == "OR" || f == "NOT" {
			continue
		}
		kept = append(kept, f)
	}
	return strings.Join(kept, " ")
}

// CreateMessage inserts a new message and returns its ID; content must already
// be sanitized.
func (d *DB) CreateMessage(ctx context.Context, channelID, userID int64, content string, replyTo *int64) (int64, error) {
	m, err := d.CreateMessageReturning(ctx, channelID, userID, content, replyTo)
	if err != nil {
		return 0, err
	}
	return m.ID, nil
}

// CreateMessageReturning inserts a message and returns the full row via
// RETURNING, so the send fan-out gets the DB-assigned timestamp without a
// re-read.
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
// Soft-deleted messages are returned so callers can broadcast the deletion.
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

// IsMessageDeleted reports the soft-delete flag of one message and whether the
// row exists. found=false is not an error: the attachment-access path treats a
// missing message as "no tombstone to enforce" and leaves the decision to its
// own ACL. It is a one-column read rather than GetMessage on purpose.
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

// GetMessages returns up to limit messages in a channel, newest first; before
// > 0 restricts to id < before.
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

// EditMessage updates the content, sets edited_at and returns the updated row
// via RETURNING. It returns ErrNotFound if the message does not exist, is
// deleted, or userID is not the owner.
//
// The UPDATE carries `AND deleted = 0` (like SoftDeleteMessage and
// SetMessagePinned) because a delete can commit between the ownership read and
// the write; without it the tombstone would be rewritten and chat_edited
// broadcast for a message clients already replaced.
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

// DeleteMessage soft-deletes (deleted=1) the message; the caller must be the
// owner or ismod must be true.
//
// The UPDATE is guarded with `AND deleted = 0` and RowsAffected is checked, so
// an already-deleted message (including one that raced to the writer) returns
// ErrNotFound instead of succeeding twice, which would run
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

// PurgeChannelMessages soft-deletes the newest limit non-deleted messages in a
// channel and returns their IDs, newest first; before > 0 restricts to id <
// before. Rows keep their data (only deleted=1) so tombstones and reply_to
// targets survive as with a single delete. Selection and update share one
// writer transaction so a concurrent delete cannot make the id set diverge
// from what was written.
func (d *DB) PurgeChannelMessages(ctx context.Context, channelID, before int64, limit int) ([]int64, error) {
	if limit < 1 {
		return []int64{}, nil
	}

	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("PurgeChannelMessages begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	ids, err := purgeChannelMessagesTx(ctx, tx, channelID, before, limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("PurgeChannelMessages commit: %w", err)
	}
	return ids, nil
}

// PurgeChannelMessagesWithAction is PurgeChannelMessages plus one removal
// ledger row per purge (not per message) in the same transaction, so a failure
// recording it rolls the purge back. reportID links a report-linked removal.
func (d *DB) PurgeChannelMessagesWithAction(ctx context.Context, channelID, before int64, limit int, actorID int64, reportID *int64) ([]int64, error) {
	if limit < 1 {
		return []int64{}, nil
	}

	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("PurgeChannelMessagesWithAction begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	ids, err := purgeChannelMessagesTx(ctx, tx, channelID, before, limit)
	if err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		// The ledger row's target is the acting moderator: a purge can span many
		// authors, and moderation_actions.target_id must reference exactly one user.
		reason := fmt.Sprintf("%d messages purged", len(ids))
		if err := recordLedgerRow(ctx, tx, "removal", actorID, actorID, reportID, reason); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("PurgeChannelMessagesWithAction commit: %w", err)
	}
	return ids, nil
}

// purgeChannelMessagesTx is PurgeChannelMessages' body on an open tx, so
// callers can extend the same transaction.
func purgeChannelMessagesTx(ctx context.Context, tx *sql.Tx, channelID, before int64, limit int) ([]int64, error) {
	sel := `SELECT id FROM messages WHERE channel_id = ? AND deleted = 0 AND kind IN (0, 7, 8) ORDER BY id DESC LIMIT ?`
	args := []any{channelID, limit}
	if before > 0 {
		sel = `SELECT id FROM messages WHERE channel_id = ? AND id < ? AND deleted = 0 AND kind IN (0, 7, 8) ORDER BY id DESC LIMIT ?`
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
	return ids, nil
}

// DeleteMessageWithRemoval is DeleteMessage plus a removal ledger row in one
// transaction when the deleter is not the author; a self-delete or
// non-moderator delete writes no row. authorID is resolved by the caller.
// reportID links a report-linked removal. An empty reason falls back to
// "message removed".
func (d *DB) DeleteMessageWithRemoval(ctx context.Context, msgID, deleterID int64, isMod bool, authorID int64, reportID *int64, reason string) error {
	if !isMod || deleterID == authorID {
		return d.DeleteMessage(ctx, msgID, deleterID, isMod)
	}
	if reason == "" {
		reason = "message removed"
	}

	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("DeleteMessageWithRemoval begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	q := dbgen.New(tx)
	res, err := q.SoftDeleteMessage(ctx, msgID)
	if err != nil {
		return fmt.Errorf("DeleteMessageWithRemoval: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("DeleteMessageWithRemoval: message %d: %w", msgID, ErrNotFound)
	}
	if err := recordLedgerRow(ctx, tx, "removal", authorID, deleterID, reportID, reason); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("DeleteMessageWithRemoval commit: %w", err)
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

// GetReactions returns aggregated reaction counts for a message; MeReacted is
// always false here.
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

// MaxReactionUsers bounds the who-reacted list; the tooltip names only a
// handful, so the query is capped rather than paginated.
const MaxReactionUsers = 100

// GetReactionUsers returns up to limit reactors for one (message, emoji) pair,
// oldest reaction first. limit is clamped to MaxReactionUsers.
func (d *DB) GetReactionUsers(ctx context.Context, messageID int64, emoji string, limit int) ([]ReactionUser, error) {
	if limit <= 0 || limit > MaxReactionUsers {
		limit = MaxReactionUsers
	}
	rows, err := d.q.GetReactionUsers(ctx, dbgen.GetReactionUsersParams{
		MessageID: messageID,
		Emoji:     emoji,
		Limit:     int64(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("GetReactionUsers: %w", err)
	}
	users := make([]ReactionUser, 0, len(rows))
	for _, r := range rows {
		users = append(users, ReactionUser{ID: r.ID, Username: r.Username, Avatar: r.Avatar})
	}
	return users, nil
}

// SearchMessages runs a full-text search over messages_fts, scoped to
// channelID when non-nil and excluding deleted messages. It wraps
// SearchMessagesFiltered, which owns the SQL.
func (d *DB) SearchMessages(ctx context.Context, query string, channelID *int64, page SearchPage) ([]MessageSearchResult, error) {
	if !HasSearchTerms(query) {
		return []MessageSearchResult{}, nil
	}
	var channelIDs []int64
	if channelID != nil {
		channelIDs = []int64{*channelID}
	} else {
		all, err := d.allChannelIDs(ctx)
		if err != nil {
			return nil, fmt.Errorf("SearchMessages: %w", err)
		}
		channelIDs = all
	}
	if len(channelIDs) == 0 {
		return []MessageSearchResult{}, nil
	}
	return d.SearchMessagesFiltered(ctx, SearchQuery{Text: query, ChannelIDs: channelIDs}, page)
}

// SearchMessagesInChannels is a full-text search scoped to channelIDs,
// filtering at the DB level so results never leak across channels. It wraps
// SearchMessagesFiltered.
func (d *DB) SearchMessagesInChannels(ctx context.Context, query string, channelIDs []int64, page SearchPage) ([]MessageSearchResult, error) {
	if len(channelIDs) == 0 || !HasSearchTerms(query) {
		return []MessageSearchResult{}, nil
	}
	return d.SearchMessagesFiltered(ctx, SearchQuery{Text: query, ChannelIDs: channelIDs}, page)
}

// GetMessagesForAPI returns messages in the docs/api.md response shape
// (user, reactions with me flag, attachments).
func (d *DB) GetMessagesForAPI(ctx context.Context, channelID, before int64, limit int, requestingUserID int64) ([]MessageAPIResponse, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if before > 0 {
		rows, err = d.reader.QueryContext(ctx,
			`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
			        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp,
			        m.mentions_everyone, m.kind
			 FROM messages m JOIN users u ON m.user_id = u.id
			 WHERE m.channel_id = ? AND m.id < ? AND m.deleted = 0
			 ORDER BY m.id DESC LIMIT ?`,
			channelID, before, limit,
		)
	} else {
		rows, err = d.reader.QueryContext(ctx,
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

	return d.scanAndEnrichMessages(ctx, rows, requestingUserID)
}

// GetMessagesAfterForAPI returns up to limit messages with id > after in the
// API shape, oldest first (the mirror of GetMessagesForAPI's before-pages).
// Callers needing has_more ask for limit+1 and trim.
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

	return d.scanAndEnrichMessages(ctx, rows, requestingUserID)
}

// GetMessagesAroundForAPI returns a window of messages centred on centerID in
// the API shape, oldest first: up to beforeCount older, the centre, and up to
// afterCount newer. It does no has_more probing; callers pass one extra on
// each count.
func (d *DB) GetMessagesAroundForAPI(ctx context.Context, channelID, centerID int64, beforeCount, afterCount int, requestingUserID int64) ([]MessageAPIResponse, error) {
	if beforeCount < 0 {
		beforeCount = 0
	}
	if afterCount < 0 {
		afterCount = 0
	}
	// SQLite forbids ORDER BY/LIMIT on a compound-SELECT operand, so each half
	// of the window is a nested subquery. The older half includes the centre
	// row itself, hence beforeCount+1.
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

	return d.scanAndEnrichMessages(ctx, rows, requestingUserID)
}

// getReactionsBatch returns aggregated reactions for multiple messages.
func (d *DB) getReactionsBatch(ctx context.Context, msgIDs []int64, requestingUserID int64) (map[int64][]ReactionInfo, error) {
	if len(msgIDs) == 0 {
		return map[int64][]ReactionInfo{}, nil
	}

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

// GetReadState returns the stored read-state row for (userID, channelID);
// found is false when the user never focused the channel. It runs on the
// reader so HandleChannelFocus can skip a redundant write.
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

// GetChannelUnreadCounts returns per-channel unread counts and last message
// IDs for a user, with 0,0 for empty channels. Text, announcement and voice
// channels are included, and DM channels only for this user's participation;
// the ready payload's dm_channels[] takes its mention_count from
// GetUserDMChannels instead. Correlated subqueries range-scan
// idx_messages_channel per channel, and the DM predicate hits
// idx_dm_participants_user.
func (d *DB) GetChannelUnreadCounts(ctx context.Context, userID int64) (map[int64]ChannelUnread, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT c.id,
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
		                                       WHERE dp.channel_id = c.id AND dp.user_id = ?)))`,
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

// MaxPinnedMessages bounds the pinned messages one query returns. Without a
// cap, scanAndEnrichMessages' IN (?,?,...) batch lookups would exceed SQLite's
// ~32766 bound-parameter limit and the pins endpoint would 500 forever for that
// channel.
const MaxPinnedMessages = 1000

// GetPinnedMessages returns up to MaxPinnedMessages+1 pinned messages (the
// extra row signals truncation), most recently pinned first, in the API shape.
func (d *DB) GetPinnedMessages(ctx context.Context, channelID int64, requestingUserID int64) ([]MessageAPIResponse, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
		        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp,
		        m.mentions_everyone, m.kind
		 FROM messages m JOIN users u ON m.user_id = u.id
		 WHERE m.channel_id = ? AND m.pinned = 1 AND m.deleted = 0
		 ORDER BY m.pinned_at DESC, m.id DESC LIMIT ?`,
		channelID, MaxPinnedMessages+1,
	)
	if err != nil {
		return nil, fmt.Errorf("GetPinnedMessages: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	return d.scanAndEnrichMessages(ctx, rows, requestingUserID)
}

// scanAndEnrichMessages scans rows into MessageAPIResponse and batch-fetches
// reactions, attachments and mentions. The caller must defer rows.Close().
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

// scanSearchResults scans FTS search rows. label names the calling query in
// error messages. Never returns a nil slice.
func scanSearchResults(rows *sql.Rows, label string) ([]MessageSearchResult, error) {
	results := []MessageSearchResult{}
	for rows.Next() {
		var r MessageSearchResult
		var everyone int
		if scanErr := rows.Scan(&r.MessageID, &r.ChannelID, &r.ChannelName,
			&r.User.ID, &r.User.Username, &r.User.Avatar,
			&r.Content, &r.Timestamp, &everyone); scanErr != nil {
			return nil, fmt.Errorf("%s scan: %w", label, scanErr)
		}
		r.MentionsEveryone = everyone != 0
		r.Mentions = []int64{}
		results = append(results, r)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("%s rows: %w", label, rows.Err())
	}
	return results, nil
}

// attachSearchMentions fills in the resolved mention ids for search hits in one
// batch query, mirroring how scanAndEnrichMessages enriches history rows.
func (d *DB) attachSearchMentions(ctx context.Context, results []MessageSearchResult) ([]MessageSearchResult, error) {
	if len(results) == 0 {
		return results, nil
	}
	ids := make([]int64, len(results))
	for i := range results {
		ids[i] = results[i].MessageID
	}
	mentionMap, err := d.GetMentionsByMessageIDs(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("attachSearchMentions: %w", err)
	}
	for i := range results {
		if m, ok := mentionMap[results[i].MessageID]; ok {
			results[i].Mentions = m
		}
	}
	return results, nil
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
