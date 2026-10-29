package db

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
)

// checkpointAfterErasure truncates the WAL once, after the finish commit.
//
// The WAL still holds the transaction's frames, erased bytes included,
// until a checkpoint copies them into the main file and TRUNCATE drops
// the log. Best effort: a reader mid-transaction makes the checkpoint
// partial and the next one finishes it. Drain chunks do not checkpoint; a
// crash mid-drain is covered by the unconditional start-up checkpoint.
//
// "The next one" is not left to SQLite. The autocheckpoint
// that follows is PASSIVE: it copies frames into the main file and never
// truncates the log, so the erased bytes stay in the -wal until something
// runs TRUNCATE again — and nothing does. So a checkpoint that comes back
// blocked or partial owes one, and CheckpointErasureWAL (start-up, and the
// runner tick behind FinishOwedErasureCheckpoint) is what pays it.
func (d *DB) checkpointAfterErasure(ctx context.Context, conn *sql.Conn, userID int64) {
	busy, logFrames, checkpointed, err := walCheckpointTRUNCATE(ctx, conn)
	switch {
	case err != nil:
		// Whatever the error was, the log is very likely still full. Set the
		// flag rather than work out which failures left frames behind: a
		// retry that finds nothing to do costs one pragma.
		d.checkpointOwed.Store(true)
		slog.Warn("erasure: WAL checkpoint failed", "user_id", userID, "err", err)
	case !walTruncated(busy, logFrames, checkpointed):
		d.checkpointOwed.Store(true)
		slog.Info("erasure: WAL checkpoint incomplete, a later checkpoint finishes it", "user_id", userID, "busy", busy, "log", logFrames, "checkpointed", checkpointed)
	default:
		d.checkpointOwed.Store(false)
	}
}

// walCheckpointTRUNCATE runs one wal_checkpoint(TRUNCATE) on conn and reports
// SQLite's own triple: whether the checkpoint was blocked, how many frames the
// log held, and how many of them are in the main database.
//
// conn is the caller's because the caller that matters most — eraseAccount —
// is already holding the sole writer connection. It runs under WithoutCancel:
// the frames being copied are the erased ones, and a cancelled request context
// must not be what leaves them in the log.
func walCheckpointTRUNCATE(ctx context.Context, conn *sql.Conn) (busy, logFrames, checkpointed int, err error) {
	err = conn.QueryRowContext(context.WithoutCancel(ctx), `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &logFrames, &checkpointed)
	return busy, logFrames, checkpointed, err
}

// walTruncated reports whether the triple says the log is now empty: the
// checkpoint was not blocked, and every frame it held is in the main file. A
// database that is not in WAL mode reports -1 for both counts, which this
// reads as empty — there is no log to hold anything.
func walTruncated(busy, logFrames, checkpointed int) bool {
	return busy == 0 && checkpointed >= logFrames
}

// CheckpointErasureWAL runs one wal_checkpoint(TRUNCATE) on the writer and
// reports whether the log is empty afterwards.
//
// It is called at start-up, before anything serves, and it is unconditional
// for the window a crash leaves behind: an erasure whose transaction committed
// and whose checkpoint never ran. The owed flag cannot cover that window,
// because it is process-local and died with the process that set it — only a
// pass that runs on every boot can finish what the last one could not. It also
// runs over the frames the two marker replays write on their way here.
//
// Best effort in the same sense eraseAccount's checkpoint is: a reader
// mid-transaction can block it again, which is the tick's to finish rather
// than a reason to refuse a boot. Callers read the bool, not the error, to
// decide whether anything is still owed.
func (d *DB) CheckpointErasureWAL(ctx context.Context) (bool, error) {
	conn, err := d.writer.Conn(ctx)
	if err != nil {
		d.checkpointOwed.Store(true)
		return false, fmt.Errorf("erasure WAL checkpoint: %w", err)
	}
	defer conn.Close() //nolint:errcheck
	return d.checkpointErasureWAL(ctx, conn)
}

// FinishOwedErasureCheckpoint is the runner tick's half of the same job: it
// pays the debt an erasure left behind, and does nothing at all on a tick
// where there is none — which is every tick but the ones right after a
// checkpoint came back blocked.
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

// checkpointErasureWAL is the shared body of the two above: one TRUNCATE on
// conn, with the outcome recorded in the owed flag — set when the log is not
// empty afterwards, cleared when it is.
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
