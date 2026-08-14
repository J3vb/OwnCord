package ws

import (
	"context"
	"time"

	"github.com/owncord/server/db"
)

// EventStore persists broadcast events for cold-tier replay during reconnection
// when the in-memory ring buffer no longer covers the client's last_seq.
// *db.DB satisfies it (the methods moved into the db package when the store
// abstraction was removed in D3).
type EventStore interface {
	PersistEvent(ctx context.Context, seq int64, eventType string, channelID int64, payload []byte) error
	// PersistEvents writes a batch in one transaction, falling back to per-row
	// inserts on tx failure (best-effort). Returns rows persisted and, when any
	// row was lost, the first per-row error.
	PersistEvents(ctx context.Context, events []db.PersistedEvent) (int, error)
	GetEventsSince(ctx context.Context, afterSeq int64, limit int) ([]db.PersistedEvent, error)
	GetEventsSinceForChannels(ctx context.Context, afterSeq int64, channelIDs []int64, limit int) ([]db.PersistedEvent, error)
	// CountEventsInRange returns the unfiltered count of events with
	// afterSeq < seq <= uptoSeq, used to detect an interior gap left by a
	// lost row before a persisted range is trusted as a complete replay.
	CountEventsInRange(ctx context.Context, afterSeq, uptoSeq int64) (int64, error)
	PruneEventsOlderThan(ctx context.Context, cutoff time.Time) (int64, error)
	GetMaxEventSeq(ctx context.Context) (int64, error)
}
