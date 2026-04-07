// Phase B Step 7 — Event Persistence Layer (pruner).
//
// StartEventPruner runs a background goroutine that deletes events older than
// the configured retention window. It is the bounded-storage half of the
// event persistence design: the persister appends, the pruner trims.
package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/owncord/server/store"
)

// maxStartupDelay caps how long StartEventPruner waits before its first
// prune pass. We want a short delay so a freshly started server with a
// tiny dataset doesn't keep stale rows around for a full interval, but we
// don't want the delay to exceed the interval itself (otherwise a server
// running with interval=5s would wait longer than its own tick).
const maxStartupDelay = time.Minute

// StartEventPruner launches a goroutine that wakes every interval and deletes
// events older than retention. The goroutine exits when ctx is cancelled.
func StartEventPruner(ctx context.Context, s store.EventStore, retention, interval time.Duration) {
	if s == nil {
		return
	}
	if retention <= 0 {
		retention = 24 * time.Hour
	}
	if interval <= 0 {
		interval = time.Hour
	}
	// Bound the startup delay by the interval so short test intervals
	// (e.g. 100ms in event_pruner_test.go) don't wait a full minute.
	startupDelayDuration := maxStartupDelay
	if interval < startupDelayDuration {
		startupDelayDuration = interval
	}
	go func() {
		// Run once shortly after startup so a tiny dataset stays small.
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
}

func runPrune(ctx context.Context, s store.EventStore, retention time.Duration) {
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
