// StartEventPruner deletes events older than the retention window: the bounded-
// storage half of event persistence (the persister appends, the pruner trims).

package ws

import (
	"context"
	"log/slog"
	"time"
)

// maxStartupDelay caps the wait before the first prune so a fresh server does not
// keep stale rows for a full interval, and never exceeds the interval itself.
const maxStartupDelay = time.Minute

type eventPruneStore interface {
	PruneEventsOlderThan(ctx context.Context, cutoff time.Time) (int64, error)
}

// StartEventPruner prunes events older than retention every interval until ctx is
// cancelled. The returned channel closes when it has fully exited, so shutdown
// can order it before the database closes (like EventPersister.Stop).
func StartEventPruner(ctx context.Context, s eventPruneStore, retention, interval time.Duration) <-chan struct{} {
	done := make(chan struct{})
	if s == nil {
		close(done)
		return done
	}
	if retention <= 0 {
		retention = 24 * time.Hour
	}
	if interval <= 0 {
		interval = time.Hour
	}
	startupDelayDuration := min(interval, maxStartupDelay)
	go func() {
		defer close(done)
		startupDelay := time.NewTimer(startupDelayDuration)
		defer startupDelay.Stop()
		select {
		case <-ctx.Done():
			return
		case <-startupDelay.C:
		}
		runPrune(ctx, s, retention)

		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				runPrune(ctx, s, retention)
			}
		}
	}()
	return done
}

func runPrune(ctx context.Context, s eventPruneStore, retention time.Duration) {
	cutoff := time.Now().Add(-retention)
	deleted, err := s.PruneEventsOlderThan(ctx, cutoff)
	if err != nil {
		slog.Warn("event pruner: PruneEventsOlderThan failed", "err", err)
		return
	}
	if deleted > 0 {
		slog.Info("event pruner: pruned old events", "deleted", deleted, "cutoff", cutoff.Format(time.RFC3339))
	}
}
