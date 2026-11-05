package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ListUnfinishedErasureJobs returns every job whose files are not yet gone,
// oldest first.
func (d *DB) ListUnfinishedErasureJobs(ctx context.Context) ([]ErasureJob, error) {
	rows, err := d.q.ListUnfinishedErasureJobs(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListUnfinishedErasureJobs: %w", err)
	}
	jobs := make([]ErasureJob, 0, len(rows))
	for _, r := range rows {
		job, err := erasureJobFromRow(r.ID, r.UserID, r.State, r.Files, r.FilesRemoved, r.Attempts, r.LastError, r.ReplayPurged)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}

// GetErasureJob returns one job by id, or ErrNotFound.
func (d *DB) GetErasureJob(ctx context.Context, id int64) (*ErasureJob, error) {
	r, err := d.q.GetErasureJob(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("GetErasureJob: %w", err)
	}
	job, err := erasureJobFromRow(r.ID, r.UserID, r.State, r.Files, r.FilesRemoved, r.Attempts, r.LastError, r.ReplayPurged)
	if err != nil {
		return nil, err
	}
	return &job, nil
}

// MarkErasureJobReplayPurged records that the job's replay purge succeeded.
func (d *DB) MarkErasureJobReplayPurged(ctx context.Context, id int64) error {
	if err := d.q.MarkErasureJobReplayPurged(ctx, id); err != nil {
		return fmt.Errorf("MarkErasureJobReplayPurged: %w", err)
	}
	return nil
}

func erasureJobFromRow(id, userID int64, state, files string, removed, attempts int64, lastErr *string, replayPurged int64) (ErasureJob, error) {
	job := ErasureJob{ID: id, UserID: userID, State: state, FilesRemoved: int(removed), Attempts: int(attempts), ReplayPurged: replayPurged != 0}
	if err := json.Unmarshal([]byte(files), &job.Files); err != nil {
		return ErasureJob{}, fmt.Errorf("erasure job %d: decode files: %w", id, err)
	}
	if job.Files == nil {
		job.Files = []string{}
	}
	if lastErr != nil {
		job.LastError = *lastErr
	}
	return job, nil
}

// RecordErasureJobAttempt records a run that left files behind: the count
// removed so far and the last error, and bumps the attempt counter.
func (d *DB) RecordErasureJobAttempt(ctx context.Context, id int64, filesRemoved int, lastError string) error {
	var errText *string
	if lastError != "" {
		errText = &lastError
	}
	if err := d.q.RecordErasureJobAttempt(ctx, dbgen.RecordErasureJobAttemptParams{FilesRemoved: int64(filesRemoved), LastError: errText, ID: id}); err != nil {
		return fmt.Errorf("RecordErasureJobAttempt: %w", err)
	}
	return nil
}

// CompleteErasureJob marks a job done: every listed file is gone.
func (d *DB) CompleteErasureJob(ctx context.Context, id int64, filesRemoved int) error {
	if err := d.q.CompleteErasureJob(ctx, dbgen.CompleteErasureJobParams{FilesRemoved: int64(filesRemoved), ID: id}); err != nil {
		return fmt.Errorf("CompleteErasureJob: %w", err)
	}
	return nil
}
