package db

import (
	"context"
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
	// the optimize that follows, and the previous value is restored so the
	// pooled connection is not left with a changed setting.
	stmts := []string{
		fmt.Sprintf("PRAGMA analysis_limit=%d;", optimizeAnalysisLimit),
		"PRAGMA optimize;",
		"PRAGMA analysis_limit=0;",
	}
	for _, s := range stmts {
		if _, err := conn.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("optimize: %s: %w", s, err)
		}
	}
	return nil
}

// StartOptimizer runs Optimize every interval until ctx is cancelled. A
// failure is logged, not fatal; the next tick tries again. The returned
// channel closes once the goroutine has exited, so shutdown can order it
// before Close. A non-positive interval uses OptimizeInterval.
func (d *DB) StartOptimizer(ctx context.Context, interval time.Duration) <-chan struct{} {
	return runOptimizeLoop(ctx, interval, d.Optimize, d.closed.Load)
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
