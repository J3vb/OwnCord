package ws

import (
	"context"
	"errors"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// EventStore persists broadcast events for cold-tier replay when the in-memory
// ring no longer covers a client's last_seq. *db.DB satisfies it.
type EventStore interface {
	PersistEvent(ctx context.Context, seq int64, eventType string, channelID int64, payload []byte) error
	// PersistEvents writes a batch in one transaction, falling back to per-row
	// inserts on failure. Returns rows persisted and, if any row was lost, the
	// first per-row error.
	PersistEvents(ctx context.Context, events []db.PersistedEvent) (int, error)
	GetEventsSince(ctx context.Context, afterSeq int64, limit int) ([]db.PersistedEvent, error)
	GetEventsSinceForChannels(ctx context.Context, afterSeq int64, channelIDs []int64, limit int) ([]db.PersistedEvent, error)
	// CountEventsInRange counts events with afterSeq < seq <= uptoSeq, to detect
	// an interior gap before a persisted range is trusted as a complete replay.
	CountEventsInRange(ctx context.Context, afterSeq, uptoSeq int64) (int64, error)
	PruneEventsOlderThan(ctx context.Context, cutoff time.Time) (int64, error)
	GetMaxEventSeq(ctx context.Context) (int64, error)
}

// errReplayPurgeInProgress is returned by a cold-tier read while a replay purge
// sits between dropping the ring's copies and deleting rows; the resume takes the
// full ready.
var errReplayPurgeInProgress = errors.New("replay purge in progress")

// purgeGuardedStore is the EventStore cold-tier reads go through: each read holds
// replayPurgeState.mu for reading and fails with errReplayPurgeInProgress rather
// than wait on a purge.
type purgeGuardedStore struct {
	EventStore
	purge *replayPurgeState
}

func (s purgeGuardedStore) GetEventsSince(ctx context.Context, afterSeq int64, limit int) ([]db.PersistedEvent, error) {
	if !s.purge.tryColdRead() {
		return nil, errReplayPurgeInProgress
	}
	defer s.purge.mu.RUnlock()
	return s.EventStore.GetEventsSince(ctx, afterSeq, limit)
}

func (s purgeGuardedStore) GetEventsSinceForChannels(ctx context.Context, afterSeq int64, channelIDs []int64, limit int) ([]db.PersistedEvent, error) {
	if !s.purge.tryColdRead() {
		return nil, errReplayPurgeInProgress
	}
	defer s.purge.mu.RUnlock()
	return s.EventStore.GetEventsSinceForChannels(ctx, afterSeq, channelIDs, limit)
}

func (s purgeGuardedStore) CountEventsInRange(ctx context.Context, afterSeq, uptoSeq int64) (int64, error) {
	if !s.purge.tryColdRead() {
		return 0, errReplayPurgeInProgress
	}
	defer s.purge.mu.RUnlock()
	return s.EventStore.CountEventsInRange(ctx, afterSeq, uptoSeq)
}
