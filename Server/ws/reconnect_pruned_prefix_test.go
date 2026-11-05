package ws_test

// reconnect_pruned_prefix_test.go — regression test for the retention-pruning
// gap (finding v000): PruneEventsOlderThan deletes cold-tier rows purely by
// created_at with no seq-floor coordination, so a client whose last_seq
// predates the retention cutoff can see a channel-filtered cold-tier query
// return a non-empty *suffix* of rows that starts well after last_seq+1.
// handleReconnect must detect that gap with an unfiltered oldest-seq probe
// and force a full ready re-sync rather than replaying the surviving suffix
// as if it were a complete resume.

import (
	"testing"
)

// TestReconnect_PrunedPrefix_ForcesFullReady locks the guard added in
// handleReconnect's cold-tier branch: when retention pruning has deleted the
// events immediately after last_seq, the surviving suffix returned by
// GetEventsSinceForChannels must NOT be accepted as a complete resume.
//
// Setup mirrors TestReconnect_BufferMiss_FallsBackToDBTier, but simulates a
// pruned prefix: only seqs 1000..1100 are persisted (as if 1..999 were
// pruned by PruneEventsOlderThan), and the ring buffer only covers the same
// range (as if it, too, has rolled past the pruned events). A client
// reconnecting with last_seq=500 has a store that is unfiltered-non-empty but
// whose oldest surviving seq (1000) is far past last_seq+1 (501) — the exact
// condition the oldest-seq probe (es.GetEventsSince(ctx, 0, 1)) must catch.
func TestReconnect_PrunedPrefix_ForcesFullReady(t *testing.T) {
	// Only seqs 1000..1100 survive in the cold-tier store — everything from
	// 1..999 has already been pruned by PruneEventsOlderThan, which deletes by
	// created_at with no seq-floor coordination.
	store := openEventStoreDB(t)
	persistBroadcasts(t, store, 1000, 1100)
	rig := newWSRigWithStore(t, store)
	_, token := rig.seedUser(t, "reconnect-pruned-user", 1)

	// The ring buffer has also rolled past the pruned range: only 1000..1100
	// are present, so a client at last_seq=500 misses the buffer entirely and
	// the cold tier is consulted.
	fillRingBuffer(t, rig.hub, 1000, 1100)

	// The first message back must be the full ready payload (type "ready"),
	// NOT auth_ok with replay_source="db" — accepting the surviving suffix as
	// a complete resume would silently skip every event between last_seq and
	// the pruning cutoff.
	requireColdResumeRefused(t, rig, token, 500,
		"reconnect accepted a pruned-prefix suffix as a complete db-tier resume",
		"a suffix left behind by retention pruning was delivered as a complete resume",
		"a gap before last_seq left by retention pruning must force a full ready re-sync")
}
