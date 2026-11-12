package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// erasureDrainSteps are the bulky per-user tables, drained before the finish
// stage in the order erasureStatements deletes them; anything unlisted is small
// and goes in the finish transaction. Indexed predicates delete through
// "rowid IN (SELECT ... LIMIT n)" on the serving index; tables with no index on
// the user column (reactions, events) are walked in key windows.
var erasureDrainSteps = []drainStep{
	limitStep("message_mentions",
		`DELETE FROM message_mentions WHERE rowid IN (SELECT rowid FROM message_mentions WHERE mentioned_user_id = ?1 LIMIT ?2)`),
	limitStep("message_delivery_receipts",
		`DELETE FROM message_delivery_receipts WHERE rowid IN (SELECT rowid FROM message_delivery_receipts WHERE user_id = ?1 LIMIT ?2)`),
	limitStep("mention_receipts",
		`DELETE FROM mention_receipts WHERE (user_id, channel_id, message_id) IN
		   (SELECT user_id, channel_id, message_id FROM mention_receipts WHERE user_id = ?1 LIMIT ?2)`),
	// poll_votes is WITHOUT ROWID, so the chunk is named by its primary key. The
	// polls it touches get their version bumped in the same transaction as the
	// delete, so no reader sees old counts at a newer version.
	pollVotesStep(),
	{label: "attachments uploaded", run: drainUploadedAttachments},
	// Events go before messages: an edit frame names its message, not its author, so
	// the predicate asks the messages table whose it is while the rows still exist.
	windowStep("events", "events", "seq", EventNamesUserPredicate+" OR "+EventNamesOwnMessagePredicate),
	{label: "messages", run: drainMessages},
	windowStep("reactions", "reactions", "id", `user_id = ?1`),
}

func limitStep(label, query string) drainStep {
	return drainStep{label: label, run: func(ctx context.Context, tx *sql.Tx, userID, _ int64) (drainResult, error) {
		res, err := tx.ExecContext(ctx, query, userID, erasureChunk)
		if err != nil {
			return drainResult{}, fmt.Errorf("delete: %w", err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return drainResult{}, fmt.Errorf("rows affected: %w", err)
		}
		return drainResult{done: n < int64(erasureChunk)}, nil
	}}
}

// pollVotesChunk names one chunk of the subject's votes by primary key, in key order
// so the bump and the delete see the same rows.
const pollVotesChunk = `SELECT message_id, user_id, answer_id FROM poll_votes WHERE user_id = ?1
		   ORDER BY message_id, user_id, answer_id LIMIT ?2`

func pollVotesStep() drainStep {
	bump := `UPDATE polls SET version = version + 1 WHERE message_id IN
		   (SELECT message_id FROM poll_votes WHERE (message_id, user_id, answer_id) IN (` + pollVotesChunk + `))`
	del := `DELETE FROM poll_votes WHERE (message_id, user_id, answer_id) IN (` + pollVotesChunk + `)`
	return drainStep{label: "poll_votes", run: func(ctx context.Context, tx *sql.Tx, userID, _ int64) (drainResult, error) {
		if _, err := tx.ExecContext(ctx, bump, userID, erasureChunk); err != nil {
			return drainResult{}, fmt.Errorf("bump poll versions: %w", err)
		}
		res, err := tx.ExecContext(ctx, del, userID, erasureChunk)
		if err != nil {
			return drainResult{}, fmt.Errorf("delete: %w", err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return drainResult{}, fmt.Errorf("rows affected: %w", err)
		}
		return drainResult{done: n < int64(erasureChunk)}, nil
	}}
}

// windowStep walks table by key in windows of erasureScanWindow real keys, deleting
// the rows predicate (?1 the user id) matches; the cursor is the next window's first
// key.
func windowStep(label, table, key, predicate string) drainStep {
	span := "SELECT COALESCE(MAX(" + key + "), 0) FROM (SELECT " + key + " FROM " + table +
		" WHERE " + key + " >= ?1 ORDER BY " + key + " LIMIT ?2)"
	del := "DELETE FROM " + table + " WHERE " + key + " >= ?2 AND " + key + " <= ?3 AND (" + predicate + ")" //nolint:gosec // G202: identifiers and predicate are package constants
	return drainStep{label: label, run: func(ctx context.Context, tx *sql.Tx, userID, cursor int64) (drainResult, error) {
		var hi int64
		if err := tx.QueryRowContext(ctx, span, cursor, erasureScanWindow).Scan(&hi); err != nil {
			return drainResult{}, fmt.Errorf("window: %w", err)
		}
		if hi == 0 {
			return drainResult{done: true}, nil
		}
		if _, err := tx.ExecContext(ctx, del, userID, cursor, hi); err != nil { //nolint:gosec // G202: identifiers are constants, values are bound
			return drainResult{}, fmt.Errorf("delete: %w", err)
		}
		return drainResult{next: hi + 1}, nil
	}}
}

// drainUploadedAttachments removes attachments the subject uploaded (the avatar
// is one) and returns their stored names; those on their messages go with drainMessages.
func drainUploadedAttachments(ctx context.Context, tx *sql.Tx, userID, _ int64) (drainResult, error) {
	rows, err := tx.QueryContext(ctx,
		`DELETE FROM attachments WHERE id IN (SELECT id FROM attachments WHERE uploader_id = ?1 LIMIT ?2) RETURNING stored_as`,
		userID, erasureChunk)
	if err != nil {
		return drainResult{}, fmt.Errorf("delete: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	files := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return drainResult{}, fmt.Errorf("scan: %w", err)
		}
		files = append(files, name)
	}
	if err := rows.Err(); err != nil {
		return drainResult{}, fmt.Errorf("rows: %w", err)
	}
	return drainResult{done: len(files) < erasureChunk, files: files}, nil
}

// drainMessages removes up to erasureChunk of the subject's messages in retention's
// order (reverse badges, delete attachments, delete messages); the caller journals the names.
func drainMessages(ctx context.Context, tx *sql.Tx, userID, _ int64) (drainResult, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM messages WHERE user_id = ?1 ORDER BY id LIMIT ?2`, userID, erasureChunk)
	if err != nil {
		return drainResult{}, fmt.Errorf("select: %w", err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close() //nolint:errcheck
			return drainResult{}, fmt.Errorf("scan: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close() //nolint:errcheck
	if err := rows.Err(); err != nil {
		return drainResult{}, fmt.Errorf("rows: %w", err)
	}
	if len(ids) == 0 {
		return drainResult{done: true}, nil
	}
	in, args := placeholdersFor(ids)
	if err := erasureReverseMentionCountsFor(ctx, tx, in, args); err != nil {
		return drainResult{}, err
	}
	files, err := collectAndDeleteAttachments(ctx, tx, in, args)
	if err != nil {
		return drainResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE id IN (`+in+`)`, args...); err != nil { //nolint:gosec // G202: placeholders only
		return drainResult{}, fmt.Errorf("delete: %w", err)
	}
	return drainResult{done: len(ids) < erasureChunk, files: files}, nil
}

// erasureReverseMentionCountsFor is erasureReverseMentionCounts for an explicit
// message set across channels, computed from the ids outward so cost follows the chunk.
func erasureReverseMentionCountsFor(ctx context.Context, tx *sql.Tx, in string, args []any) error {
	query := strings.Replace(`WITH dec AS (
		SELECT r.user_id AS uid, r.channel_id AS cid, COUNT(*) AS n
		  FROM messages m
		  JOIN mention_receipts r ON r.message_id = m.id AND r.channel_id = m.channel_id
		  JOIN read_states rs ON rs.user_id = r.user_id AND rs.channel_id = r.channel_id
		 WHERE m.id IN (__IN__)
		   AND m.deleted = 0
		   AND `+countedReceipt+`
		   AND m.id > rs.last_message_id
		   AND NOT EXISTS (
		       SELECT 1 FROM user_blocks b
		        WHERE b.blocker_id = r.user_id AND b.blocked_id = m.user_id)
		 GROUP BY r.user_id, r.channel_id)
	UPDATE read_states
	   SET mention_count = MAX(0, mention_count - (
	       SELECT n FROM dec WHERE dec.uid = read_states.user_id AND dec.cid = read_states.channel_id))
	 WHERE mention_count > 0
	   AND (user_id, channel_id) IN (SELECT uid, cid FROM dec)`, "__IN__", in, 1)
	if _, err := tx.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("mention counts: %w", err)
	}
	return nil
}
