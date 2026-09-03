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
)

// RetentionDaysKey is the settings row holding the server-wide retention
// window in days; 0 (the default, seeded by migration 039) keeps everything.
const RetentionDaysKey = "retention_days"

// ChannelRetention is a per-channel retention policy (B4-11, owner decision
// 4): days overrides the server window in either direction, 0 meaning keep
// forever.
type ChannelRetention struct {
	ChannelID int64  `json:"channel_id"`
	Days      int    `json:"days"`
	UpdatedBy int64  `json:"updated_by"`
	UpdatedAt string `json:"updated_at"`
}

// RetentionWindow is one channel's effective policy: the days that apply
// and where they came from.
type RetentionWindow struct {
	ChannelID   int64  `json:"channel_id"`
	ChannelName string `json:"channel_name"`
	Days        int    `json:"days"`
	// Source is "server" or "channel".
	Source string `json:"source"`
}

// ServerRetentionDays reads the server-wide window; a missing or malformed
// row is 0, keep forever — a typo must never start deleting.
func (d *DB) ServerRetentionDays(ctx context.Context) (int, error) {
	v, err := d.GetSetting(ctx, RetentionDaysKey)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return 0, nil
		}
		return 0, err
	}
	days, convErr := strconv.Atoi(strings.TrimSpace(v))
	if convErr != nil || days < 0 {
		return 0, nil //nolint:nilerr // a malformed value keeps everything on purpose; a typo must never start deleting
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

// SetChannelRetention writes the channel's policy (days >= 0; 0 = keep
// forever, overriding a server window).
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

// DeleteChannelRetention removes the channel's policy; the server window
// applies again. Reports whether a row existed.
func (d *DB) DeleteChannelRetention(ctx context.Context, channelID int64) (bool, error) {
	res, err := d.writer.ExecContext(ctx, `DELETE FROM channel_retention WHERE channel_id = ?`, channelID)
	if err != nil {
		return false, fmt.Errorf("DeleteChannelRetention: %w", err)
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// RetentionWindows returns the effective policy of every non-DM channel that
// has one: the channel override where present, else the server window;
// channels with an effective 0 are omitted. DMs are never in scope (owner
// decision 4).
func (d *DB) RetentionWindows(ctx context.Context) ([]RetentionWindow, error) {
	serverDays, err := d.ServerRetentionDays(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := d.reader.QueryContext(ctx,
		`SELECT c.id, c.name, cr.days FROM channels c
		   LEFT JOIN channel_retention cr ON cr.channel_id = c.id
		  WHERE c.type <> 'dm' AND c.is_group = 0
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
		case override != nil:
			w.Days, w.Source = *override, "channel"
		default:
			w.Days, w.Source = serverDays, "server"
		}
		if w.Days > 0 {
			out = append(out, w)
		}
	}
	return out, rows.Err()
}

// retentionCandidates is the WHERE clause of everything retention may
// remove in a channel: older than the cutoff (messages.timestamp is UTC
// 'YYYY-MM-DD HH:MM:SS', compared bytewise, so the cutoff is formatted the
// same way), never a pinned message (owner decision 4), tombstones included.
const retentionCandidates = `channel_id = ? AND pinned = 0 AND timestamp < ?`

// CountRetentionCandidates is the preview: how many messages a sweep of
// channelID with this cutoff would remove.
func (d *DB) CountRetentionCandidates(ctx context.Context, channelID int64, cutoff time.Time) (int64, error) {
	var n int64
	if err := d.reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE `+retentionCandidates,
		channelID, cutoff.UTC().Format(sqliteTimeLayout)).Scan(&n); err != nil {
		return 0, fmt.Errorf("CountRetentionCandidates: %w", err)
	}
	return n, nil
}

// SweepRetention hard-deletes up to limit of the oldest messages in
// channelID older than cutoff (pinned exempt) in one transaction: the
// mention counts those messages raised are reversed first (OC-0294), their
// attachment rows go and the stored_as names come back for the caller's
// file journal, and the messages_ad trigger drops the FTS entries. Returns
// the ids of the messages removed — the caller takes their frames out of
// the replay tiers (DeleteEventsForMessages, ws.Hub.PurgeMessagesFromReplay)
// — and the files; fewer ids than limit means the channel is swept for this
// cutoff.
func (d *DB) SweepRetention(ctx context.Context, channelID int64, cutoff time.Time, limit int) ([]int64, []string, error) {
	if limit < 1 {
		return nil, nil, nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("SweepRetention begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	rows, err := tx.QueryContext(ctx, `SELECT id FROM messages WHERE `+retentionCandidates+` ORDER BY id LIMIT ?`,
		channelID, cutoff.UTC().Format(sqliteTimeLayout), limit)
	if err != nil {
		return nil, nil, fmt.Errorf("SweepRetention select: %w", err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close() //nolint:errcheck
			return nil, nil, fmt.Errorf("SweepRetention scan: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close() //nolint:errcheck
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("SweepRetention rows: %w", err)
	}
	if len(ids) == 0 {
		return nil, nil, nil
	}
	in, args := placeholdersFor(ids)

	if err := reverseMentionCountsForMessages(ctx, tx, channelID, in, args); err != nil {
		return nil, nil, err
	}
	files, err := collectAndDeleteAttachments(ctx, tx, in, args)
	if err != nil {
		return nil, nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE id IN (`+in+`)`, args...); err != nil { //nolint:gosec // G202: placeholders only
		return nil, nil, fmt.Errorf("SweepRetention delete: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, fmt.Errorf("SweepRetention commit: %w", err)
	}
	return ids, files, nil
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

// reverseMentionCountsForMessages is erasureReverseMentionCounts for an
// explicit message set: the read_states.mention_count bumps these messages
// made are taken back, with the same guards (undeleted, past the reader's
// last_message_id, not from a blocked author), before the rows go.
func reverseMentionCountsForMessages(ctx context.Context, tx *sql.Tx, channelID int64, in string, args []any) error {
	// The placeholder list is spliced by Replace, not concatenation: it
	// holds "?" markers only and every id is bound below.
	query := strings.Replace(`UPDATE read_states
		 SET mention_count = MAX(0, mention_count - (
		     SELECT COUNT(*)
		     FROM message_mentions mm
		     JOIN messages m ON m.id = mm.message_id
		     WHERE mm.mentioned_user_id = read_states.user_id
		       AND m.channel_id = read_states.channel_id
		       AND m.deleted = 0
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

// collectAndDeleteAttachments returns the stored_as names of the
// attachments on the given messages and deletes their rows; the caller
// removes the files from its journal.
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

// ─── retention_runs: the sweep log and its file journal ─────────────────────

// RetentionRun is one sweep's row.
type RetentionRun struct {
	ID              int64
	StartedAt       string
	FinishedAt      *string
	Channels        int
	MessagesDeleted int
	Files           []string
	FilesRemoved    int
	// PurgePending lists swept message ids whose replay purge is still
	// outstanding: journaled before the purge, cleared after it.
	PurgePending []int64
	LastError    string
}

// StartRetentionRun opens a run row and returns its id.
func (d *DB) StartRetentionRun(ctx context.Context) (int64, error) {
	res, err := d.writer.ExecContext(ctx, `INSERT INTO retention_runs DEFAULT VALUES`)
	if err != nil {
		return 0, fmt.Errorf("StartRetentionRun: %w", err)
	}
	return res.LastInsertId()
}

// RecordRetentionRunFiles journals the files a run's sweeps unlinked — the
// only handle left on the blobs — and its counts, before any file is
// removed. Idempotent per run: each call replaces the list.
func (d *DB) RecordRetentionRunFiles(ctx context.Context, runID int64, channels, deleted int, files []string) error {
	if files == nil {
		files = []string{}
	}
	encoded, err := json.Marshal(files)
	if err != nil {
		return fmt.Errorf("RecordRetentionRunFiles encode: %w", err)
	}
	if _, err := d.writer.ExecContext(ctx,
		`UPDATE retention_runs SET channels = ?, messages_deleted = ?, files = ? WHERE id = ?`,
		channels, deleted, string(encoded), runID); err != nil {
		return fmt.Errorf("RecordRetentionRunFiles: %w", err)
	}
	return nil
}

// RecordRetentionRunPurge journals the swept message ids whose replay purge
// is outstanding (the ring buffer and the events rows): written before the
// purge, replaced by the empty list after it, so a purge that fails or is
// interrupted is retried from the run on the next tick. nil clears it.
func (d *DB) RecordRetentionRunPurge(ctx context.Context, runID int64, ids []int64) error {
	if ids == nil {
		ids = []int64{}
	}
	encoded, err := json.Marshal(ids)
	if err != nil {
		return fmt.Errorf("RecordRetentionRunPurge encode: %w", err)
	}
	if _, err := d.writer.ExecContext(ctx,
		`UPDATE retention_runs SET purge_pending = ? WHERE id = ?`, string(encoded), runID); err != nil {
		return fmt.Errorf("RecordRetentionRunPurge: %w", err)
	}
	return nil
}

// EventNamesMessagePredicate is the SQL that decides whether a persisted
// replay event is about one of a set of messages, bound to a JSON array of
// message ids as ?1: a message-family frame (chat_message, chat_edited,
// chat_deleted, chat_bulk_deleted, reaction_update — the ones that carry a
// message's content or name it) whose payload.id, payload.message_id or one
// of payload.ids is in the set. ws.eventNamesMessage is the same rule over
// the bytes in the ring buffer; the two must stay in step.
const EventNamesMessagePredicate = `(json_extract(payload, '$.type') IN ('chat_message', 'chat_edited', 'chat_deleted', 'chat_bulk_deleted', 'reaction_update')
	 AND (json_extract(payload, '$.payload.id') IN (SELECT value FROM json_each(?1))
	   OR json_extract(payload, '$.payload.message_id') IN (SELECT value FROM json_each(?1))
	   OR EXISTS (SELECT 1 FROM json_each(payload, '$.payload.ids') AS named WHERE named.value IN (SELECT value FROM json_each(?1)))))`

// DeleteEventsForMessages removes every persisted replay event about the
// given messages — the retention sweep's persisted tier (B4-11): a swept
// message's chat_message frame would otherwise stay replayable, content
// included, until the events pruner reached it. Returns rows deleted.
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

// FinishRetentionRun closes a run: files_removed, the last error (empty for
// none) and finished_at.
func (d *DB) FinishRetentionRun(ctx context.Context, runID int64, filesRemoved int, lastError string) error {
	var errText *string
	if lastError != "" {
		errText = &lastError
	}
	if _, err := d.writer.ExecContext(ctx,
		`UPDATE retention_runs SET files_removed = ?, last_error = ?, finished_at = datetime('now') WHERE id = ?`,
		filesRemoved, errText, runID); err != nil {
		return fmt.Errorf("FinishRetentionRun: %w", err)
	}
	return nil
}

// ListUnfinishedRetentionRuns returns runs with work outstanding — not
// finished, files_removed short of the journal, or a replay purge still
// pending — oldest first, for the resume at start-up and on each tick.
func (d *DB) ListUnfinishedRetentionRuns(ctx context.Context) ([]RetentionRun, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT id, started_at, finished_at, channels, messages_deleted, files, files_removed, purge_pending, COALESCE(last_error, '')
		   FROM retention_runs
		  WHERE finished_at IS NULL OR files_removed < json_array_length(files) OR json_array_length(purge_pending) > 0
		  ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("ListUnfinishedRetentionRuns: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var out []RetentionRun
	for rows.Next() {
		var r RetentionRun
		var files, purge string
		if err := rows.Scan(&r.ID, &r.StartedAt, &r.FinishedAt, &r.Channels, &r.MessagesDeleted, &files, &r.FilesRemoved, &purge, &r.LastError); err != nil {
			return nil, fmt.Errorf("ListUnfinishedRetentionRuns scan: %w", err)
		}
		if err := decodeRetentionRunLists(&r, files, purge); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetRetentionRun returns one run, or ErrNotFound.
func (d *DB) GetRetentionRun(ctx context.Context, id int64) (*RetentionRun, error) {
	var r RetentionRun
	var files, purge string
	err := d.reader.QueryRowContext(ctx,
		`SELECT id, started_at, finished_at, channels, messages_deleted, files, files_removed, purge_pending, COALESCE(last_error, '') FROM retention_runs WHERE id = ?`, id).
		Scan(&r.ID, &r.StartedAt, &r.FinishedAt, &r.Channels, &r.MessagesDeleted, &files, &r.FilesRemoved, &purge, &r.LastError)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("GetRetentionRun: %w", err)
	}
	if err := decodeRetentionRunLists(&r, files, purge); err != nil {
		return nil, err
	}
	return &r, nil
}

// decodeRetentionRunLists fills a run's journaled lists from their JSON.
func decodeRetentionRunLists(r *RetentionRun, files, purge string) error {
	if err := json.Unmarshal([]byte(files), &r.Files); err != nil {
		return fmt.Errorf("retention run %d: decode files: %w", r.ID, err)
	}
	if err := json.Unmarshal([]byte(purge), &r.PurgePending); err != nil {
		return fmt.Errorf("retention run %d: decode purge_pending: %w", r.ID, err)
	}
	return nil
}
