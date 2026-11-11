package db

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
)

// checkpointAfterErasure truncates the WAL once, after the finish commit, because the
// WAL still holds the erased bytes until a checkpoint copies them into the main file.
// Best effort: a reader mid-transaction makes it partial. Drain chunks do not
// checkpoint; the start-up checkpoint covers a crash mid-drain. SQLite's
// autocheckpoint is PASSIVE and never truncates, so a partial checkpoint owes one,
// which CheckpointErasureWAL (start-up and the runner tick behind
// FinishOwedErasureCheckpoint) pays.
func (d *DB) checkpointAfterErasure(ctx context.Context, conn *sql.Conn, userID int64) {
	busy, logFrames, checkpointed, err := walCheckpointTRUNCATE(ctx, conn)
	switch {
	case err != nil:
		// Whatever the error was, the log is likely still full; set the flag rather than work
		// out which failures left frames (a no-op retry costs one pragma).
		d.checkpointOwed.Store(true)
		slog.Warn("erasure: WAL checkpoint failed", "user_id", userID, "err", err)
	case !walTruncated(busy, logFrames, checkpointed):
		d.checkpointOwed.Store(true)
		slog.Info("erasure: WAL checkpoint incomplete, a later checkpoint finishes it", "user_id", userID, "busy", busy, "log", logFrames, "checkpointed", checkpointed)
	default:
		d.checkpointOwed.Store(false)
	}
}

// walCheckpointTRUNCATE runs one wal_checkpoint(TRUNCATE) on conn and returns SQLite's
// triple: blocked, frames in the log, frames in the main database. conn is the
// caller's because eraseAccount holds the sole writer connection. It runs under
// WithoutCancel so a cancelled request cannot leave erased frames in the log.
func walCheckpointTRUNCATE(ctx context.Context, conn *sql.Conn) (busy, logFrames, checkpointed int, err error) {
	err = conn.QueryRowContext(context.WithoutCancel(ctx), `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &logFrames, &checkpointed)
	return busy, logFrames, checkpointed, err
}

// walTruncated reports whether the triple says the log is empty: not blocked and
// every frame in the main file (a non-WAL database reports -1 for both).
func walTruncated(busy, logFrames, checkpointed int) bool {
	return busy == 0 && checkpointed >= logFrames
}

// CheckpointErasureWAL runs one wal_checkpoint(TRUNCATE) on the writer and
// reports whether the log is empty afterwards. It runs at start-up before
// anything serves, unconditionally, for the window a crash leaves: an erasure
// committed but never checkpointed (the owed flag is process-local and died),
// and the frames the two marker replays write. Best effort: a blocked
// checkpoint is the tick's to finish, not a reason to refuse a boot. Callers
// read the bool, not the error.
func (d *DB) CheckpointErasureWAL(ctx context.Context) (bool, error) {
	conn, err := d.writer.Conn(ctx)
	if err != nil {
		d.checkpointOwed.Store(true)
		return false, fmt.Errorf("erasure WAL checkpoint: %w", err)
	}
	defer conn.Close() //nolint:errcheck
	return d.checkpointErasureWAL(ctx, conn)
}

// FinishOwedErasureCheckpoint is the runner tick's half: it pays an erasure's
// checkpoint debt, if any.
func (d *DB) FinishOwedErasureCheckpoint(ctx context.Context) (bool, error) {
	if !d.checkpointOwed.Load() {
		return false, nil
	}
	attempt := d.checkpointAttempts.Add(1)
	done, err := d.CheckpointErasureWAL(ctx)
	if err != nil {
		slog.Warn("erasure: the retried WAL checkpoint failed; the next tick tries again", "attempt", attempt, "err", err)
		return false, err
	}
	if !done {
		slog.Info("erasure: the retried WAL checkpoint is still blocked; the next tick tries again", "attempt", attempt)
		return false, nil
	}
	slog.Info("erasure: the retried WAL checkpoint finished; the erased frames are out of the log", "attempts", attempt)
	return true, nil
}

func (d *DB) checkpointErasureWAL(ctx context.Context, conn *sql.Conn) (bool, error) {
	busy, logFrames, checkpointed, err := walCheckpointTRUNCATE(ctx, conn)
	if err != nil {
		d.checkpointOwed.Store(true)
		return false, fmt.Errorf("erasure WAL checkpoint: %w", err)
	}
	done := walTruncated(busy, logFrames, checkpointed)
	d.checkpointOwed.Store(!done)
	return done, nil
}
