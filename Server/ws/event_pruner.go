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
	go func() {
		// Run once shortly after startup so a tiny dataset stays small.
		startupDelay := time.NewTimer(time.Minute)
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
