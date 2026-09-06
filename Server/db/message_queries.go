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
	}
}

// sanitizeFTSQuery strips FTS5 operator characters from user input to prevent
// query injection. Letters, digits and spaces pass through unchanged; every
// other rune is folded to a space rather than dropped.
//
// Folding, not dropping, is what makes punctuation searchable at all
// (OC-0357). messages_fts uses FTS5's default unicode61 tokenizer, in which
// every non-alphanumeric rune is a token separator: "user_id" is INDEXED as
// the two tokens `user` and `id`. Dropping the underscore asks for the single
// term `userid`, which exists nowhere in the index, so the search returned
// nothing at all — silently, for any query containing '_', '.', '@', '/', an
// apostrophe or a colon. Folding it to a space asks for `user id`, which is
// exactly how the row was indexed. '-' was folded from the start, for the
// narrower reason that it introduces a column filter ("-col: expr") and would
// otherwise make SQLite error; its comment already named the general rule.
//
// Filtering characters alone is not enough: FTS5's MATCH grammar also
// recognizes bareword keywords -- AND, OR, NOT (uppercase only) -- as
// boolean operators rather than search terms. Those are ordinary letters, so
// the character filter lets them through unchanged, and a query that places
// one in an invalid position (e.g. the whole query is "AND", or it starts or
// ends with one) makes SQLite raise "fts5: syntax error" instead of running
// the search. Any such token is dropped below so the result is always a
// plain sequence of bareword terms.
func sanitizeFTSQuery(q string) string {
	var sb strings.Builder
	sb.Grow(len(q))
	for _, r := range q {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			sb.WriteRune(r)
			continue
		}
		// Everything else -- the separators unicode61 tokenizes on, and every
		// character of FTS5's own grammar (quotes, parens, '*', '^', ':') --
		// becomes a separator here too, which is both what the index expects
		// and what keeps the operator syntax inert.
		sb.WriteRune(' ')
	}
	result := strings.TrimSpace(sb.String())
	// Enforce a maximum query length to bound FTS processing.
	// Use rune count to avoid splitting multi-byte characters.
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

// IsMessageDeleted reports the soft-delete flag of one message, and whether the
// row exists at all. found=false is not an error: the attachment-access path
// that asks this treats a missing message as "no tombstone to enforce" and
// leaves the decision to its own ACL.
//
// Deliberately not GetMessage: that wrapper's SELECT list carries every message
// column, and `deleted` is the only one this question needs. Hand-written for
// the same reason the file's other narrow reads are — one column, one row, no
// generated struct to map.
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
//
// OC-0358: the ownership read above is taken before the write, so a delete
// committing in that window would otherwise have its tombstone rewritten and
// reported as a successful edit — the caller then broadcasts chat_edited for a
// message every client has already replaced with "message deleted". The UPDATE
// carries `AND deleted = 0` (the guard SoftDeleteMessage and SetMessagePinned
// were given in OC-0284), so the losing edit matches no row and surfaces here
// as ErrNotFound, the same answer an already-deleted message gets.
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

// DeleteMessage performs a soft delete (sets deleted=1) on the message.
// The calling user must be the message owner or ismod must be true.
//
// OC-0284: the UPDATE is guarded with `AND deleted = 0` (mirroring
// SetMessagePinned) and RowsAffected is checked, so a message already
// soft-deleted — by a prior call, or by one that raced this one to the
// writer — reports ErrNotFound instead of silently succeeding a second time.
// A caller-visible no-op here is what let a repeated delete run the
// mention_count reversal twice upstream in MessageService.DeleteMessage.
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
// ledger row per purge — not one per message (B5-9, plan item 6) — in the
// same transaction: a failure recording the row rolls the purge back too.
// reportID links a report-linked removal.
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
		// The ledger row's target is the acting moderator: a purge is a
		// bulk, channel-scoped action that can span many authors, and
		// moderation_actions.target_id must reference exactly one user
		// (schema FK) — see the B5-9 report's "deviation from the draft"
		// note for the fuller rationale.
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

// purgeChannelMessagesTx is PurgeChannelMessages' body, taking an
// already-open tx so callers can extend the same transaction (the ledger
// row PurgeChannelMessagesWithAction adds).
func purgeChannelMessagesTx(ctx context.Context, tx *sql.Tx, channelID, before int64, limit int) ([]int64, error) {
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
	return ids, nil
}

// DeleteMessageWithRemoval is DeleteMessage plus a removal ledger row, in
// one transaction, when the deleter is not the message's author (B5-9,
// plan item 6): a self-delete or a non-moderator delete writes no row,
// exactly as DeleteMessage always has. authorID is the message's author,
// already resolved by the caller. reportID links a report-linked removal.
func (d *DB) DeleteMessageWithRemoval(ctx context.Context, msgID, deleterID int64, isMod bool, authorID int64, reportID *int64) error {
	if !isMod || deleterID == authorID {
		return d.DeleteMessage(ctx, msgID, deleterID, isMod)
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
	if err := recordLedgerRow(ctx, tx, "removal", authorID, deleterID, reportID, "message removed"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("DeleteMessageWithRemoval commit: %w", err)
	}
	return nil
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

// MaxReactionUsers bounds the who-reacted list. A reaction pill can carry
// thousands of reactors; the tooltip only ever names a handful, so the query is
// capped rather than paginated.
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
			`SELECT m.id, m.channel_id, c.name, u.id, u.username, u.avatar, m.content,
			        m.timestamp, m.mentions_everyone
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
			`SELECT m.id, m.channel_id, c.name, u.id, u.username, u.avatar, m.content,
			        m.timestamp, m.mentions_everyone
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

	results, err := scanSearchResults(rows, "SearchMessages")
	if err != nil {
		return nil, err
	}
	return d.attachSearchMentions(ctx, results)
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
			`SELECT m.id, m.channel_id, c.name, u.id, u.username, u.avatar, m.content,
			        m.timestamp, m.mentions_everyone
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

	results, err := scanSearchResults(rows, "SearchMessagesInChannels")
	if err != nil {
		return nil, err
	}
	return d.attachSearchMentions(ctx, results)
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
			        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp,
			        m.mentions_everyone
			 FROM messages m JOIN users u ON m.user_id = u.id
			 WHERE m.channel_id = ? AND m.id < ? AND m.deleted = 0
			 ORDER BY m.id DESC LIMIT ?`,
			channelID, before, limit,
		)
	} else {
		rows, err = d.reader.QueryContext(ctx,
			`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
			        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp,
			        m.mentions_everyone
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

// GetMessagesAroundForAPI returns a window of messages centred on centerID in
// the API response shape, ordered oldest-first: up to beforeCount messages
// older than the centre, the centre itself, and up to afterCount newer ones.
//
// Callers that need to know whether the channel holds more history on either
// side pass one extra on each count and inspect the returned slice — this
// query does no probing of its own.
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
		        m.mentions_everyone
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

// GetReadState returns the stored read-state row for (userID, channelID).
// found is false when the user has never focused the channel. Runs on the
// reader pool — it exists so HandleChannelFocus can skip the UpdateReadState
// write when the row is already correct.
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

// MarkChannelReadAtLatest marks the channel read at whatever its newest
// message is when the statement runs, rather than at an id the caller read
// moments earlier.
//
// Use it for "mark this channel read" (channel_focus, mark_read).
// UpdateReadState stays for the caller that already holds the exact id it
// means — the send path advancing the sender's own read state past their own
// message — where there is no snapshot to go stale.
//
// OC-0323: a mark-read computed from a stale snapshot cleared mention_count
// while last_message_id still pointed behind a message that had just raised a
// mention, so the badge vanished with nothing to recompute it. Both halves of
// the pair are single-writer statements, so computing the watermark here makes
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

// UpdateReadState upserts the read state for a user in a channel at the id the
// caller names, and clears its mention badge — marking a channel read consumes
// its mentions.
//
// It is for a caller that already holds the exact id it means, which since
// OC-0323 means the send path advancing the sender past their own message.
// A "mark this channel read" caller must use MarkChannelReadAtLatest instead:
// the id it would pass here is a snapshot, and clearing mentions against a
// stale one destroys any raised in the meantime.
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
// channels that have no messages. DM channels are included too, but only the
// ones this user participates in — without them the ready payload carried no
// mention_count for DMs, so a DM mention badge silently reset on every
// reconnect. Correlated subqueries range-scan idx_messages_channel per channel
// instead of the old LEFT JOIN fan-out that touched every message row on every
// WS connect; the DM predicate hits idx_dm_participants_user.
func (d *DB) GetChannelUnreadCounts(ctx context.Context, userID int64) (map[int64]ChannelUnread, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT c.id,
		        (SELECT COALESCE(MAX(m.id), 0) FROM messages m
		          WHERE m.channel_id = c.id AND m.deleted = 0) AS last_msg_id,
		        (SELECT COUNT(*) FROM messages m
		          WHERE m.channel_id = c.id AND m.deleted = 0
		            AND m.id > COALESCE((SELECT rs.last_message_id FROM read_states rs
		                                  WHERE rs.channel_id = c.id AND rs.user_id = ?), 0)) AS unread,
		        COALESCE((SELECT rs.mention_count FROM read_states rs
		                   WHERE rs.channel_id = c.id AND rs.user_id = ?), 0) AS mentions
		 FROM channels c
		 WHERE c.type IN ('text', 'announcement')
		    OR (c.type = 'dm' AND EXISTS (SELECT 1 FROM dm_participants dp
		                                   WHERE dp.channel_id = c.id AND dp.user_id = ?))`,
		userID, userID, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("GetChannelUnreadCounts: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := make(map[int64]ChannelUnread)
	for rows.Next() {
		var chID int64
		var cu ChannelUnread
		if scanErr := rows.Scan(&chID, &cu.LastMessageID, &cu.UnreadCount, &cu.MentionCount); scanErr != nil {
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

// MaxPinnedMessages bounds how many pinned messages a single channel query
// returns. Without a cap, scanAndEnrichMessages feeds every pinned message ID
// into several `IN (?,?,...)` batch lookups (reactions, attachments,
// mentions); past SQLite's ~32766 bound-parameter limit that fails outright
// ("too many SQL variables"), and the pins endpoint then 500s on every call
// for that channel forever. The cap sits far below that ceiling, with room to
// spare across all three batch queries.
const MaxPinnedMessages = 1000

// GetPinnedMessages returns up to MaxPinnedMessages pinned messages in a
// channel, most-recently-pinned first, in the API response shape, including
// user object, reactions (with me flag), and attachments.
func (d *DB) GetPinnedMessages(ctx context.Context, channelID int64, requestingUserID int64) ([]MessageAPIResponse, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
		        m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp,
		        m.mentions_everyone
		 FROM messages m JOIN users u ON m.user_id = u.id
		 WHERE m.channel_id = ? AND m.pinned = 1 AND m.deleted = 0
		 ORDER BY m.id DESC LIMIT ?`,
		channelID, MaxPinnedMessages,
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
		var deleted, pinned, everyone int
		if scanErr := rows.Scan(
			&m.ID, &m.ChannelID, &m.User.ID, &m.User.Username, &m.User.Avatar,
			&m.Content, &m.ReplyTo, &m.EditedAt, &deleted, &pinned, &m.Timestamp,
			&everyone,
		); scanErr != nil {
			return nil, fmt.Errorf("scanAndEnrichMessages scan: %w", scanErr)
		}
		m.Deleted = deleted != 0
		m.Pinned = pinned != 0
		m.MentionsEveryone = everyone != 0
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

	// Batch-fetch resolved mentions for all message IDs.
	mentionMap, err := d.GetMentionsByMessageIDs(ctx, msgIDs)
	if err != nil {
		return nil, fmt.Errorf("scanAndEnrichMessages mentions: %w", err)
	}
	for i := range msgs {
		if mIDs, ok := mentionMap[msgs[i].ID]; ok {
			msgs[i].Mentions = mIDs
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
