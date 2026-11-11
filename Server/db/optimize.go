package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// OptimizeInterval is how often StartOptimizer refreshes planner statistics on a
// long-running server.
const OptimizeInterval = 12 * time.Hour

// optimizeAnalysisLimit bounds the rows ANALYZE samples per index, so each pass is
// cheap enough for the writer.
const optimizeAnalysisLimit = 1000

// Optimize runs a bounded PRAGMA optimize on the writer (it writes sqlite_stat rows);
// a no-op after Close.
func (d *DB) Optimize(ctx context.Context) error {
	if d.closed.Load() {
		return nil
	}
	conn, err := d.writer.Conn(ctx)
	if err != nil {
		return fmt.Errorf("optimize: acquiring writer connection: %w", err)
	}
	defer func() { _ = conn.Close() }()
	// analysis_limit is per connection, so pin one for the optimize. The reset runs even
	// if optimize fails or ctx is cancelled, so the pooled connection keeps no changed
	// setting.
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA analysis_limit=%d;", optimizeAnalysisLimit)); err != nil {
		return fmt.Errorf("optimize: setting analysis_limit: %w", err)
	}
	defer func() { _, _ = conn.ExecContext(context.WithoutCancel(ctx), "PRAGMA analysis_limit=0;") }()
	if _, err := conn.ExecContext(ctx, "PRAGMA optimize;"); err != nil {
		return fmt.Errorf("optimize: %w", err)
	}
	return nil
}

// StartOptimizer runs Optimize and a passive WAL checkpoint every interval until ctx
// is cancelled; a failure is logged and retried next tick. The returned channel closes
// once the goroutine exits, so shutdown can order it before Close. A non-positive
// interval uses OptimizeInterval.
func (d *DB) StartOptimizer(ctx context.Context, interval time.Duration) <-chan struct{} {
	return runOptimizeLoop(ctx, interval, d.optimizeTick, d.closed.Load)
}

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

const statsCacheTTL = 60 * time.Second

// CheckpointWAL runs one wal_checkpoint(PASSIVE) on a reader connection. It
// copies what it can without waiting on readers or the writer, so the next
// write can restart the log and journal_size_limit can truncate it; SQLite's
// auto-checkpoint rarely gets that chance under steady read load. No-op in
// memory or after Close.
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

// optimizeTick refreshes planner statistics, then gives the WAL a chance to restart;
// both run even if the first fails.
func (d *DB) optimizeTick(ctx context.Context) error {
	return errors.Join(d.Optimize(ctx), d.CheckpointWAL(ctx))
}
