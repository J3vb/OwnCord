package ws

import (
	"context"
	"errors"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
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

// errReplayPurgeInProgress is what a cold-tier read returns while a replay
// purge is between dropping the ring's copies and deleting the rows; the
// resume treats it like any failed cold read and takes the full ready.
var errReplayPurgeInProgress = errors.New("replay purge in progress")

// purgeGuardedStore is the EventStore the cold-tier reads go through: each
// read holds replayPurgeState.mu for reading, and fails with
// errReplayPurgeInProgress rather than wait when a purge holds it.
type purgeGuardedStore struct {
	EventStore
	mu *syncutil.RWMutex
}

func (s purgeGuardedStore) GetEventsSince(ctx context.Context, afterSeq int64, limit int) ([]db.PersistedEvent, error) {
	if !s.mu.TryRLock() {
		return nil, errReplayPurgeInProgress
	}
	defer s.mu.RUnlock()
	return s.EventStore.GetEventsSince(ctx, afterSeq, limit)
}

func (s purgeGuardedStore) GetEventsSinceForChannels(ctx context.Context, afterSeq int64, channelIDs []int64, limit int) ([]db.PersistedEvent, error) {
	if !s.mu.TryRLock() {
		return nil, errReplayPurgeInProgress
	}
	defer s.mu.RUnlock()
	return s.EventStore.GetEventsSinceForChannels(ctx, afterSeq, channelIDs, limit)
}

func (s purgeGuardedStore) CountEventsInRange(ctx context.Context, afterSeq, uptoSeq int64) (int64, error) {
	if !s.mu.TryRLock() {
		return 0, errReplayPurgeInProgress
	}
	defer s.mu.RUnlock()
	return s.EventStore.CountEventsInRange(ctx, afterSeq, uptoSeq)
}
