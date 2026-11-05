package ws_test

// reconnect_interior_gap_test.go — regression test for OC-0062: the cold-tier
// replay path checked only for a *prefix* gap (retention pruning ahead of
// last_seq) and a *tail* gap (ring buffer not covering the post-flush tail),
// but never checked for a *hole in the middle* of the persisted range. The
// EventPersister can lose an individual row (a full queue drops silently in
// Enqueue, and a per-row insert failure inside a batch flush is logged but
// never surfaced to the replay path — see event_persister.go), leaving the
// events table with an interior gap. handleReconnect's cold tier must not
// accept that as a complete resume: the client tracks only max(seq), so a
// silently skipped seq can never be requested again.

import (
	"testing"
)

// TestReconnect_InteriorGap_ForcesFullReady locks the guard that must be added
// to handleReconnect's cold-tier branch: when the persisted rows above
// last_seq have a hole somewhere in the middle (not at the very start, which
// the oldest-seq probe already catches), the cold-tier replay must not be
// delivered as a complete "db" resume.
//
// Setup mirrors TestReconnect_BufferMiss_FallsBackToDBTier, but seq 550 is
// never persisted — simulating a single row the EventPersister lost — while
// every other seq in 501..600 is present. The channel-filtered query
// (channelIDs empty, so only channel_id=0 rows are considered — all of ours
// are global) returns a 99-row result that:
//   - is not at the maxColdReplay cap (so the truncation guard doesn't fire)
//   - starts at seq 501, i.e. oldest[0].Seq(501) == lastSeq+1(501), so the
//     prefix-gap probe passes
//   - has its newest row (600) fully covered by the ring buffer tail, so the
//     tail-coverage guard passes
//
// Only an unfiltered contiguity check over (last_seq, max_persisted_seq]
// catches the missing 550.
func TestReconnect_InteriorGap_ForcesFullReady(t *testing.T) {
	// Persist 501..600 EXCEPT 550 — simulating one row the EventPersister
	// lost (full-queue drop or a per-row insert failure during flush).
	store := openEventStoreDB(t)
	persistBroadcasts(t, store, 501, 600, 550)
	rig := newWSRigWithStore(t, store)
	_, token := rig.seedUser(t, "reconnect-gap-user", 1)

	// Ring buffer holds 501..1500, so last_seq=500 misses it and the cold
	// tier is consulted; the buffer fully covers everything above the
	// newest persisted row (600), so the tail-coverage guard alone would
	// wrongly let this replay through.
	fillRingBuffer(t, rig.hub, 501, 1500)

	// The first message back must NOT be auth_ok with replay_source="db" —
	// accepting the 99-row result as a complete resume silently skips seq
	// 550 forever, since the client only ever tracks max(seq).
	requireColdResumeRefused(t, rig, token, 500,
		"reconnect accepted a cold-tier replay with an interior gap (missing seq 550) as a complete db-tier resume",
		"a persisted range with an interior gap was delivered as a complete resume",
		"an interior gap in the persisted range must force a full ready re-sync")
}
