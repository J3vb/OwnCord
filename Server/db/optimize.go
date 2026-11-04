package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// OptimizeInterval is how often StartOptimizer refreshes planner statistics
// on a long-running server. Migrate and Close optimize too, but a server that
// stays up for weeks otherwise plans from whatever it saw at boot.
const OptimizeInterval = 12 * time.Hour

// optimizeAnalysisLimit bounds the rows ANALYZE samples per index, keeping
// each pass cheap enough to run on the writer at any time.
const optimizeAnalysisLimit = 1000

// Optimize refreshes the query planner's statistics with a bounded
// PRAGMA optimize. It writes sqlite_stat rows, so it runs on the writer, and
// it is a no-op once Close has been called.
func (d *DB) Optimize(ctx context.Context) error {
	if d.closed.Load() {
		return nil
	}
	conn, err := d.writer.Conn(ctx)
	if err != nil {
		return fmt.Errorf("optimize: acquiring writer connection: %w", err)
	}
	defer func() { _ = conn.Close() }()
	// analysis_limit is per connection; pinning one connection applies it to
	// the optimize that follows. The reset runs even when optimize fails or ctx
	// is cancelled, so the pooled connection is not left with a changed setting.
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA analysis_limit=%d;", optimizeAnalysisLimit)); err != nil {
		return fmt.Errorf("optimize: setting analysis_limit: %w", err)
	}
	defer func() { _, _ = conn.ExecContext(context.WithoutCancel(ctx), "PRAGMA analysis_limit=0;") }()
	if _, err := conn.ExecContext(ctx, "PRAGMA optimize;"); err != nil {
		return fmt.Errorf("optimize: %w", err)
	}
	return nil
}

// StartOptimizer runs Optimize and a passive WAL checkpoint every interval
// until ctx is cancelled. A failure is logged, not fatal; the next tick tries
// again. The returned channel closes once the goroutine has exited, so
// shutdown can order it before Close. A non-positive interval uses OptimizeInterval.
func (d *DB) StartOptimizer(ctx context.Context, interval time.Duration) <-chan struct{} {
	return runOptimizeLoop(ctx, interval, d.optimizeTick, d.closed.Load)
}

// runOptimizeLoop is StartOptimizer's loop with the work and the closed check
// injected, so a test can drive it with a millisecond interval.
func runOptimizeLoop(ctx context.Context, interval time.Duration, run func(context.Context) error, closed func() bool) <-chan struct{} {
	if interval <= 0 {
		interval = OptimizeInterval
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if closed() {
					return
				}
				if err := run(ctx); err != nil && ctx.Err() == nil {
					slog.Warn("periodic PRAGMA optimize failed", "error", err)
				}
			}
		}
	}()
	return done
}

// statsCacheTTL is how long the whole-table aggregates read by the metrics
// scrape and the admin dashboard are reused.
const statsCacheTTL = 60 * time.Second

// CheckpointWAL runs one wal_checkpoint(PASSIVE) on a reader connection. It
// copies what it can into the main file without waiting on readers or the
// writer, so the next write can restart the log from the start and
// journal_size_limit can truncate it. SQLite's own auto-checkpoint rarely gets
// that chance under a steady read load. A no-op on an in-memory database or
// once Close has been called.
func (d *DB) CheckpointWAL(ctx context.Context) error {
	if d.closed.Load() || d.walPath == "" {
		return nil
	}
	conn, err := d.reader.Conn(ctx)
	if err != nil {
		return fmt.Errorf("wal checkpoint: acquiring reader connection: %w", err)
	}
	defer func() { _ = conn.Close() }()
	var busy, logFrames, checkpointed int
	if err := conn.QueryRowContext(ctx, "PRAGMA wal_checkpoint(PASSIVE)").Scan(&busy, &logFrames, &checkpointed); err != nil {
		return fmt.Errorf("wal checkpoint: %w", err)
	}
	return nil
}

// optimizeTick is one optimizer tick: refresh planner statistics, then give
// the WAL a chance to restart. Both run even if the first fails.
func (d *DB) optimizeTick(ctx context.Context) error {
	return errors.Join(d.Optimize(ctx), d.CheckpointWAL(ctx))
}
