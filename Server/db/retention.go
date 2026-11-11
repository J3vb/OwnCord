package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/dbtime"
)

// RetentionDaysKey is the settings row for the server-wide retention window in days; 0
// keeps everything.
const RetentionDaysKey = "retention_days"

// RetentionMaxDays is the largest day count the server and per-channel
// settings accept. Converted into the sweep's cutoff, a larger count overflows
// and the cutoff wraps into the future, matching every unpinned message as
// old. service.RetentionMaxDays mirrors it because the validating write paths
// live in service.
const RetentionMaxDays = 3650

// ChannelRetention is a per-channel policy overriding the server window either way; 0
// keeps forever.
type ChannelRetention struct {
	ChannelID int64  `json:"channel_id"`
	Days      int    `json:"days"`
	UpdatedBy int64  `json:"updated_by"`
	UpdatedAt string `json:"updated_at"`
}

// RetentionWindow is one channel's effective days and where they came from.
type RetentionWindow struct {
	ChannelID   int64  `json:"channel_id"`
	ChannelName string `json:"channel_name"`
	Days        int    `json:"days"`
	Source      string `json:"source"`
}

// ServerRetentionDays reads the server window; a missing, malformed or out-of-range
// row is 0 so a typo never deletes.
func (d *DB) ServerRetentionDays(ctx context.Context) (int, error) {
	v, err := d.GetSetting(ctx, RetentionDaysKey)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return 0, nil
		}
		return 0, err
	}
	days, convErr := strconv.Atoi(strings.TrimSpace(v))
	if convErr != nil || days < 0 || days > RetentionMaxDays {
		return 0, nil //nolint:nilerr // a malformed or out-of-range value keeps everything on purpose; a typo must never start deleting
	}
	return days, nil
}

// ListChannelRetention returns every per-channel policy.
func (d *DB) ListChannelRetention(ctx context.Context) ([]ChannelRetention, error) {
	rows, err := d.reader.QueryContext(ctx, `SELECT channel_id, days, updated_by, updated_at FROM channel_retention ORDER BY channel_id`)
	if err != nil {
		return nil, fmt.Errorf("ListChannelRetention: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	out := []ChannelRetention{}
	for rows.Next() {
		var c ChannelRetention
		if err := rows.Scan(&c.ChannelID, &c.Days, &c.UpdatedBy, &c.UpdatedAt); err != nil {
			return nil, fmt.Errorf("ListChannelRetention scan: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetChannelRetention returns the channel's policy, or nil without one.
func (d *DB) GetChannelRetention(ctx context.Context, channelID int64) (*ChannelRetention, error) {
	var c ChannelRetention
	err := d.reader.QueryRowContext(ctx, `SELECT channel_id, days, updated_by, updated_at FROM channel_retention WHERE channel_id = ?`, channelID).
		Scan(&c.ChannelID, &c.Days, &c.UpdatedBy, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetChannelRetention: %w", err)
	}
	return &c, nil
}

// SetChannelRetention writes the channel's policy (days >= 0; 0 keeps forever,
// overriding the server window).
func (d *DB) SetChannelRetention(ctx context.Context, channelID int64, days int, updatedBy int64) error {
	if days < 0 {
		return fmt.Errorf("SetChannelRetention: days must be >= 0")
	}
	if _, err := d.writer.ExecContext(ctx,
		`INSERT INTO channel_retention (channel_id, days, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
		 ON CONFLICT(channel_id) DO UPDATE SET days = excluded.days, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
		channelID, days, updatedBy); err != nil {
		return fmt.Errorf("SetChannelRetention: %w", err)
	}
	return nil
}

// DeleteChannelRetention removes the policy so the server window applies; it reports
// whether a row existed.
func (d *DB) DeleteChannelRetention(ctx context.Context, channelID int64) (bool, error) {
	res, err := d.writer.ExecContext(ctx, `DELETE FROM channel_retention WHERE channel_id = ?`, channelID)
	if err != nil {
		return false, fmt.Errorf("DeleteChannelRetention: %w", err)
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// RetentionWindows returns the effective policy of every non-DM channel that has one:
// the channel override (a thread inherits its parent's), else the server window.
// Effective 0 is omitted.
func (d *DB) RetentionWindows(ctx context.Context) ([]RetentionWindow, error) {
	serverDays, err := d.ServerRetentionDays(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := d.reader.QueryContext(ctx,
		`SELECT c.id, c.name, cr.days FROM channels c
		   LEFT JOIN channel_retention cr ON cr.channel_id = COALESCE(c.parent_channel_id, c.id)
		  WHERE c.type <> 'dm' AND c.is_group = 0 AND c.import_pending = 0
		  ORDER BY c.id`)
	if err != nil {
		return nil, fmt.Errorf("RetentionWindows: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	out := []RetentionWindow{}
	for rows.Next() {
		var w RetentionWindow
		var override *int
		if err := rows.Scan(&w.ChannelID, &w.ChannelName, &override); err != nil {
			return nil, fmt.Errorf("RetentionWindows scan: %w", err)
		}
		switch {
		case override != nil && *override <= RetentionMaxDays:
			w.Days, w.Source = *override, "channel"
		case override != nil:
			// Out-of-range like ServerRetentionDays: SetChannelRetention has no upper
			// bound, so a direct write or restored row can carry anything. A malformed
			// override fails safe to 0 (keep forever), not a fall-back to the server window.
			w.Days, w.Source = 0, "channel"
		default:
			w.Days, w.Source = serverDays, "server"
		}
		if w.Days > 0 {
			out = append(out, w)
		}
	}
	return out, rows.Err()
}

// retentionCandidates is the WHERE clause of everything retention may remove in a
// channel: older than the cutoff (UTC 'YYYY-MM-DD HH:MM:SS', compared bytewise, so format the cutoff
// the same way), not pinned, tombstones included.
const retentionCandidates = `channel_id = ? AND pinned = 0 AND timestamp < ?`

// CountRetentionCandidates previews how many messages a sweep would remove.
func (d *DB) CountRetentionCandidates(ctx context.Context, channelID int64, cutoff time.Time) (int64, error) {
	var n int64
	if err := d.reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE `+retentionCandidates,
		channelID, cutoff.UTC().Format(dbtime.SQLiteLayout)).Scan(&n); err != nil {
		return 0, fmt.Errorf("CountRetentionCandidates: %w", err)
	}
	return n, nil
}

// SweepRetention hard-deletes up to limit of the oldest messages in channelID
// older than cutoff (pinned exempt) in one transaction: mention counts are
// reversed first, attachment rows go with their stored_as names returned for
// the caller's file journal, and the messages_ad trigger drops the FTS
// entries. It returns the removed ids, whose frames the caller takes out of the
// replay tiers (DeleteEventsForMessages, ws.Hub.PurgeMessagesFromReplay), and
// the files; fewer ids than limit means the channel is swept.
func (d *DB) SweepRetention(ctx context.Context, channelID int64, cutoff time.Time, limit int) ([]int64, []string, error) {
	_, ids, files, err := d.sweepRetention(ctx, 0, channelID, cutoff, limit, false, false)
	return ids, files, err
}

// SweepRetentionJournaled is the crash-safe batch: the run row, deleted ids and
// attachment filenames commit in the same transaction as the deletion. A zero runID
// opens the run lazily, only when the batch finds something; countChannel adds one to
// the run's channel count on its first non-empty batch.
func (d *DB) SweepRetentionJournaled(ctx context.Context, runID, channelID int64, cutoff time.Time, limit int, countChannel bool) (int64, []int64, []string, error) {
	return d.sweepRetention(ctx, runID, channelID, cutoff, limit, true, countChannel)
}

func (d *DB) sweepRetention(ctx context.Context, runID, channelID int64, cutoff time.Time, limit int, journal, countChannel bool) (int64, []int64, []string, error) {
	if limit < 1 {
		return runID, nil, nil, nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return runID, nil, nil, fmt.Errorf("SweepRetention begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	rows, err := tx.QueryContext(ctx, `SELECT id FROM messages WHERE `+retentionCandidates+` ORDER BY id LIMIT ?`,
		channelID, cutoff.UTC().Format(dbtime.SQLiteLayout), limit)
	if err != nil {
		return runID, nil, nil, fmt.Errorf("SweepRetention select: %w", err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close() //nolint:errcheck
			return runID, nil, nil, fmt.Errorf("SweepRetention scan: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close() //nolint:errcheck
	if err := rows.Err(); err != nil {
		return runID, nil, nil, fmt.Errorf("SweepRetention rows: %w", err)
	}
	if len(ids) == 0 {
		return runID, nil, nil, nil
	}
	if journal && runID == 0 {
		res, err := tx.ExecContext(ctx, `INSERT INTO retention_runs DEFAULT VALUES`)
		if err != nil {
			return 0, nil, nil, fmt.Errorf("SweepRetention start run: %w", err)
		}
		runID, err = res.LastInsertId()
		if err != nil {
			return 0, nil, nil, fmt.Errorf("SweepRetention run id: %w", err)
		}
	}
	in, args := placeholdersFor(ids)

	if err := reverseMentionCountsForMessages(ctx, tx, channelID, in, args); err != nil {
		return runID, nil, nil, err
	}
	files, err := collectAndDeleteAttachments(ctx, tx, in, args)
	if err != nil {
		return runID, nil, nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE id IN (`+in+`)`, args...); err != nil { //nolint:gosec // G202: placeholders only
		return runID, nil, nil, fmt.Errorf("SweepRetention delete: %w", err)
	}
	if journal {
		if err := appendRetentionRunBatch(ctx, tx, runID, ids, files, countChannel); err != nil {
			return runID, nil, nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return runID, nil, nil, fmt.Errorf("SweepRetention commit: %w", err)
	}
	return runID, ids, files, nil
}

// appendRetentionRunBatch journals every handle needed after the rows disappear; it
// must stay in the deletion transaction, since a write after Commit leaves a kill
// window with no durable way to purge frames or unlink blobs.
func appendRetentionRunBatch(ctx context.Context, tx *sql.Tx, runID int64, ids []int64, files []string, countChannel bool) error {
	var encodedFiles, encodedPending string
	if err := tx.QueryRowContext(ctx, `SELECT files, purge_pending FROM retention_runs WHERE id = ?`, runID).
		Scan(&encodedFiles, &encodedPending); err != nil {
		return fmt.Errorf("SweepRetention journal run %d: %w", runID, err)
	}
	journalFiles := make([]string, 0, len(files))
	if err := json.Unmarshal([]byte(encodedFiles), &journalFiles); err != nil {
		return fmt.Errorf("SweepRetention decode files for run %d: %w", runID, err)
	}
	purgePending := make([]int64, 0, len(ids))
	if err := json.Unmarshal([]byte(encodedPending), &purgePending); err != nil {
		return fmt.Errorf("SweepRetention decode purge journal for run %d: %w", runID, err)
	}
	journalFiles = append(journalFiles, files...)
	purgePending = append(purgePending, ids...)
	encodedFilesBytes, err := json.Marshal(journalFiles)
	if err != nil {
		return fmt.Errorf("SweepRetention encode files for run %d: %w", runID, err)
	}
	encodedPendingBytes, err := json.Marshal(purgePending)
	if err != nil {
		return fmt.Errorf("SweepRetention encode purge journal for run %d: %w", runID, err)
	}
	channelDelta := 0
	if countChannel {
		channelDelta = 1
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE retention_runs
		    SET channels = channels + ?, messages_deleted = messages_deleted + ?,
		        files = ?, purge_pending = ?
		  WHERE id = ?`, channelDelta, len(ids), string(encodedFilesBytes), string(encodedPendingBytes), runID)
	if err != nil {
		return fmt.Errorf("SweepRetention journal batch for run %d: %w", runID, err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return fmt.Errorf("SweepRetention journal rows for run %d: %w", runID, err)
	} else if n != 1 {
		return fmt.Errorf("SweepRetention journal run %d: %w", runID, ErrNotFound)
	}
	return nil
}

func placeholdersFor(ids []int64) (string, []any) {
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i] = "?"
		args[i] = id
	}
	return strings.Join(ph, ","), args
}

// reverseMentionCountsForMessages is erasureReverseMentionCounts for an explicit
// message set with the same guards, before the rows go.
func reverseMentionCountsForMessages(ctx context.Context, tx *sql.Tx, channelID int64, in string, args []any) error {
	// The placeholder list is spliced by Replace, not concatenation: it holds "?" only and
	// every id is bound.
	query := strings.Replace(`UPDATE read_states
		 SET mention_count = MAX(0, mention_count - (
		     SELECT COUNT(*)
		     FROM mention_receipts r
		     JOIN messages m ON m.id = r.message_id
		     WHERE r.user_id = read_states.user_id
		       AND r.channel_id = read_states.channel_id
		       AND m.deleted = 0
		       AND `+countedReceipt+`
		       AND m.id > read_states.last_message_id
		       AND m.id IN (__IN__)
		       AND NOT EXISTS (
		           SELECT 1 FROM user_blocks b
		           WHERE b.blocker_id = read_states.user_id
		             AND b.blocked_id = m.user_id
		       )
		 ))
		 WHERE channel_id = ? AND mention_count > 0`, "__IN__", in, 1)
	if _, err := tx.ExecContext(ctx, query, append(append([]any{}, args...), channelID)...); err != nil {
		return fmt.Errorf("SweepRetention mention counts: %w", err)
	}
	return nil
}

// collectAndDeleteAttachments returns the stored_as names of the attachments
// on the given messages and deletes their rows; the caller removes the files.
func collectAndDeleteAttachments(ctx context.Context, tx *sql.Tx, in string, args []any) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `DELETE FROM attachments WHERE message_id IN (`+in+`) RETURNING stored_as`, args...) //nolint:gosec // G202: placeholders only
	if err != nil {
		return nil, fmt.Errorf("SweepRetention attachments: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	files := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("SweepRetention scan attachment: %w", err)
		}
		files = append(files, name)
	}
	return files, rows.Err()
}

// EventNamesMessagePredicate is the SQL deciding whether a persisted replay
// event is about one of a set of messages, bound to a JSON array of ids as ?1:
// a message-family frame (chat_message, chat_edited, chat_deleted,
// chat_bulk_deleted, reaction_update, poll_update) whose payload.id,
// payload.referenced_message.id, payload.message_id or one of payload.ids is in
// the set. ws.eventNamesMessage is the same rule over the ring buffer; the two
// must stay in step.
const EventNamesMessagePredicate = `(json_extract(payload, '$.type') IN ('chat_message', 'chat_edited', 'chat_deleted', 'chat_bulk_deleted', 'reaction_update', 'poll_update')
	 AND (json_extract(payload, '$.payload.id') IN (SELECT value FROM json_each(?1))
	   OR json_extract(payload, '$.payload.referenced_message.id') IN (SELECT value FROM json_each(?1))
	   OR json_extract(payload, '$.payload.message_id') IN (SELECT value FROM json_each(?1))
	   OR EXISTS (SELECT 1 FROM json_each(payload, '$.payload.ids') AS named WHERE named.value IN (SELECT value FROM json_each(?1)))))`

// DeleteEventsForMessages removes every persisted replay event about the given
// messages (the sweep's persisted tier), so a swept message's content does not stay
// replayable until the pruner reaches it. Returns rows deleted.
func (d *DB) DeleteEventsForMessages(ctx context.Context, ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	encoded, err := json.Marshal(ids)
	if err != nil {
		return 0, fmt.Errorf("DeleteEventsForMessages encode: %w", err)
	}
	res, err := d.writer.ExecContext(ctx, `DELETE FROM events WHERE `+EventNamesMessagePredicate, string(encoded))
	if err != nil {
		return 0, fmt.Errorf("DeleteEventsForMessages: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("DeleteEventsForMessages RowsAffected: %w", err)
	}
	return n, nil
}

// RetentionSweptCutoff returns the cutoff the channel's retention sweep last
// completed up to in this database, in the messages.timestamp layout, or ""
// when none is recorded (a database from before the record, or a restored older
// backup).
func (d *DB) RetentionSweptCutoff(ctx context.Context, channelID int64) (string, error) {
	var cutoff string
	err := d.reader.QueryRowContext(ctx,
		`SELECT cutoff FROM channel_retention_swept WHERE channel_id = ?`, channelID).Scan(&cutoff)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("RetentionSweptCutoff: %w", err)
	}
	return cutoff, nil
}

// RecordRetentionSwept records that the channel has been swept clean up to
// cutoff (pinned messages exempt). The recorded cutoff only moves forward, and
// a channel that no longer exists records nothing.
func (d *DB) RecordRetentionSwept(ctx context.Context, channelID int64, cutoff time.Time) error {
	if _, err := d.writer.ExecContext(ctx,
		`INSERT INTO channel_retention_swept (channel_id, cutoff)
		 SELECT id, ? FROM channels WHERE id = ?
		 ON CONFLICT(channel_id) DO UPDATE SET cutoff = MAX(cutoff, excluded.cutoff), updated_at = datetime('now')`,
		cutoff.UTC().Format(dbtime.SQLiteLayout), channelID); err != nil {
		return fmt.Errorf("RecordRetentionSwept: %w", err)
	}
	return nil
}
