package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

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

// RecordRetentionRunFiles journals the files a run's sweeps unlinked (the only
// handle left on the blobs) and its counts, before any file is removed.
// Idempotent per run: each call replaces the list.
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
// (ring buffer and events rows) is outstanding: written before the purge and
// replaced by the empty list after it, so a failed or interrupted purge is
// retried on the next tick. nil clears it.
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

// ListUnfinishedRetentionRuns returns runs with work outstanding (not
// finished, files_removed short of the journal, or a replay purge pending),
// oldest first, for the resume at start-up and on each tick.
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
