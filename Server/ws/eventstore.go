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
	GetEventsSince(ctx context.Context, afterSeq int64, limit int) ([]db.PersistedEvent, error)
	GetEventsSinceForChannels(ctx context.Context, afterSeq int64, channelIDs []int64, limit int) ([]db.PersistedEvent, error)
	PruneEventsOlderThan(ctx context.Context, cutoff time.Time) (int64, error)
	GetMaxEventSeq(ctx context.Context) (int64, error)
}
