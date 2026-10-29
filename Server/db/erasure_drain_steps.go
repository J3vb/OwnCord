package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// erasureDrainSteps are the bulky per-user tables, drained before the finish
// stage in the order erasureStatements deletes them. Anything not listed is
// small by construction and goes in the finish transaction.
//
// Indexed predicates delete through "rowid IN (SELECT ... LIMIT n)" on the
// index that serves the predicate (idx_message_mentions_user, the
// message_delivery_receipts and mention_receipts primary keys,
// idx_attachments_uploader, idx_messages_user). Tables with no index on the
// user column are walked in key windows instead: reactions and events.
var erasureDrainSteps = []drainStep{
	limitStep("message_mentions",
		`DELETE FROM message_mentions WHERE rowid IN (SELECT rowid FROM message_mentions WHERE mentioned_user_id = ?1 LIMIT ?2)`),
	limitStep("message_delivery_receipts",
		`DELETE FROM message_delivery_receipts WHERE rowid IN (SELECT rowid FROM message_delivery_receipts WHERE user_id = ?1 LIMIT ?2)`),
	// mention_receipts is WITHOUT ROWID, so the chunk is named by its primary key.
	limitStep("mention_receipts",
		`DELETE FROM mention_receipts WHERE (user_id, channel_id, message_id) IN
		   (SELECT user_id, channel_id, message_id FROM mention_receipts WHERE user_id = ?1 LIMIT ?2)`),
	// poll_votes is WITHOUT ROWID, so the chunk is named by its primary key. The
	// polls the chunk's votes belong to get their version bumped in the same
	// transaction as the delete, so no reader sees the old counts at a newer
	// version.
	pollVotesStep(),
	{label: "attachments uploaded", run: drainUploadedAttachments},
	{label: "messages", run: drainMessages},
	windowStep("reactions", "reactions", "id", `user_id = ?1`),
	windowStep("events", "events", "seq", EventNamesUserPredicate),
}

// limitStep deletes at most erasureChunk rows with query (?1 the user id, ?2
// the limit); a chunk that deleted fewer than the limit was the last.
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

// pollVotesChunk names one chunk of the subject's votes by primary key, in key
// order so the bump and the delete in one transaction see the same rows.
const pollVotesChunk = `SELECT message_id, user_id, answer_id FROM poll_votes WHERE user_id = ?1
		   ORDER BY message_id, user_id, answer_id LIMIT ?2`

// pollVotesStep deletes a chunk of the subject's poll votes. Before it does,
// it bumps polls.version for each poll the chunk touches, so a
// client refetch sees counts fresher than any copy it holds.
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

// windowStep walks table by key column in windows of erasureScanWindow real
// keys, deleting the rows predicate (bound to the user id as ?1) matches in
// each. The cursor is the first key of the next window, so gaps left by
// earlier deletes cost nothing.
func windowStep(label, table, key, predicate string) drainStep {
	// The identifiers are package constants above; only values are bound.
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

// drainUploadedAttachments removes attachments the subject uploaded (the
// avatar is one) and returns their stored names. Those on the subject's own
// messages are taken with the messages below.
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

// drainMessages removes up to erasureChunk of the subject's messages in
// retention's order (SweepRetention): reverse the mention badges those
// messages raised, collect and delete their attachments, delete the messages.
// The attachment names are appended to the job by the caller in the same
// transaction.
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

// erasureReverseMentionCountsFor is erasureReverseMentionCounts for an
// explicit set of the subject's messages, across channels
// (reverseMentionCountsForMessages is per channel and cannot be reused). The
// decrements are computed from the message ids outward, so the cost follows
// the chunk and not the size of read_states; the guards are the same as the
// whole-account statement's — counted per mention_receipts, undeleted, past the reader's last_message_id,
// not from an author the reader blocked.
func erasureReverseMentionCountsFor(ctx context.Context, tx *sql.Tx, in string, args []any) error {
	// The placeholder list is spliced by Replace and holds "?" markers only;
	// every id is bound below.
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
