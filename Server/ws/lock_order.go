// Lock order of the ws package: the one written order for every mutex the hub
// owns. Other files carry local fragments of it; where one disagrees with this
// block, this block wins and the fragment is the bug. The order is read from
// the code at the paths cited, and checked two ways. Each ranked lock is a
// syncutil.Ranked[R] or RankedRW[R] whose R is one of the rank types at the
// end of this file; the lock-rank invariant (invariants/lock_rank.go) holds
// the table's rank column to those types. Under -tags deadlock every acquire
// is checked against the ranks its goroutine already holds, and one whose
// rank is not greater than all of them panics with both stacks
// (syncutil/ranked_deadlock.go). go-deadlock runs underneath as before.
//
// # The rule
//
// Under a state lock (every lock below except the serialisers marked S):
//
//   - no database, network or file I/O;
//   - no blocking channel operation (a send must be a select with a default);
//   - no call into code outside ws, except the map-lookup closures listed in
//     the table (the NSFW allow closure under ps.mu);
//   - slog only on an error or overflow path.
//
// Today's known exceptions are listed after the table. A new one is a defect
// to fix, not a precedent.
//
// # Serialisers and state locks
//
// A serialiser (S) orders a multi-step operation that may span bounded DB or
// RPC I/O. It is never taken while holding any lock ranked below it, and the
// hub dispatch goroutine never takes the voice ones. A state lock guards
// in-memory fields only: it is held for a map lookup or a field update and
// then released. A path takes locks in rank order, outermost first. Two locks
// of the same rank are never nested, so a goroutine holds at most one user's
// voiceMember lock and at most one Client.mu.
//
// # Ranks (outermost first)
//
// Lock names are Type.field, the Go declaration. A lock reached through a
// named field of another type says so in the "how" column. Line numbers were
// read at origin/dev f4a359e8 and are cites, not contracts. The table runs in
// rank order, unranked rows last; the lock-rank invariant fails it otherwise.
//
// The lock-inventory invariant (invariants/lock_inventory.go) reads this table.
// Each row starts with a tab, then a rank (a number, or - for no rank), an
// optional S, and the lock named Type.field (a package-level or function-local
// lock is named by its identifier). A row ranked - must carry "unranked:
// <reason>". Every syncutil or sync Mutex/RWMutex declared in a non-test file
// of ws needs a row here, and a row naming a lock that no longer exists fails
// too. Continuation lines are indented past the tab and are not read.
//
//	rank  lock                       declared                 taken under it
//	1 S   userLockEntry.mu           voice_registry.go:45     DB, broadcasts, seqMu (replay.go:438-441); never a
//	      (voiceRegistry.voiceMember) user_locks.go:44         LiveKit RPC
//	2 S   userLockEntry.mu           hub.go:217               DB and LiveKit RPC (user_locks.go:9-17); never a
//	      (Hub.voiceMod)             user_locks.go:44         membership path
//	3 S   replayPurgeState.mu RW     hub_tombstones.go:53     seqMu (hub_events.go:210), then the persister
//	      (Hub.tombstones)                                    Flush and the DB delete (hub_events.go:218-235).
//	                                                          Cold reads only TryRLock (eventstore.go:46-62)
//	3 S   activityState.flushMu      channel_activity.go:105  DB reads under activityFlushTimeout, then
//	                                                          activityState.mu, then Hub.mu, PubSub.mu and
//	                                                          Client.mu one at a time
//	3 S   roleRefreshState.flushMu   role_refresh.go:74       DB reads, then roleRefreshState.mu, then Hub.mu,
//	                                                          PubSub.mu, timeoutViewState.mu and Client.mu one
//	                                                          at a time (role_refresh.go:24-30)
//	3 S   Hub.uploadPolicyMu         hub.go:224               a DB read, then Hub.settingsMu, then Hub.mu (R),
//	                                                          then Client.mu (hub_settings.go:93-113)
//	3 S   gameActivityState.mu       hub_settings.go:128      a DB read, then Hub.presenceMu (the game activity
//	      (Hub.gameActivity)                                  sweep), Hub.mu (R), then Client.mu
//	                                                          (hub_settings.go)
//	3 S   Client.focusMu             client.go:86             Client.mu, PubSub.mu, DB reads (focus_defer.go:21,
//	                                                          focus_defer.go:132, handlers.go:281-325)
//	3 S   admissionMu (local)        serve.go:62              Hub.mu (R) via ClientCount (serve.go:73,83)
//	4     timeoutViewState.mu        member_timeouts_       Hub.mu (R), Client.mu
//	      (Hub.timeoutView)          delivery.go:23
//	4     Hub.presenceMu             hub.go:232               the caller's closure, which only enqueues
//	                                                          (hub_presence.go:211-216), Hub.mu (R), Client.mu,
//	                                                          presenceRepairState.mu, queueDropState.mu
//	5     Hub.seqMu                  hub.go:65                Hub.keyHolderMu (a resume's registerNow ->
//	                                                          updateKeyHolder, hub_registry.go:177,182), Hub.mu,
//	                                                          PubSub.mu, Client.mu (SendToUser, hub_broadcast.go:
//	                                                          294-299,354; registerNow, hub_registry.go:89),
//	                                                          EventRingBuffer.mu, presenceRepairState.mu,
//	                                                          queueDropState.mu, and the leaves below
//	6     Hub.keyHolderMu RW         hub.go:228               Hub.mu (R), voiceSlot.voiceMu
//	                                                          (voice_e2ee.go:44-60)
//	6     Hub.settingsMu RW          hub.go:219               a DB read under the write lock
//	                                                          (hub_settings.go:27-35); see the exceptions
//	7     Hub.mu RW                  hub.go:25                PubSub.mu, Client.mu, voiceSlot.voiceMu,
//	                                                          voiceGraceState.mu (hub_registry.go:60-162,
//	                                                          hub_stats.go:329-355, voice_e2ee.go:268-288)
//	8     PubSub.mu RW               pubsub.go:65             Client.mu (Subscribe -> isSendClosed, pubsub.go:94);
//	                                                          the NSFW allow closure, a map lookup
//	                                                          (hub_visibility.go:195)
//	9     Client.mu                  client.go:81             leaf: nothing is taken under it
//	9     voiceSlot.voiceMu          voice_registry.go:78     leaf
//	9     voiceGraceState.mu         voice_grace.go:54        leaf
//	9     voiceReconcileState.mu     voice_reconcile.go:42    leaf
//	9     voiceRejoinBlockState.mu   voice_rejoin_block.go:34 leaf
//	9     removedIdentities.mu       voice_removed_watch.go:35 leaf
//	9     presenceRepairState.mu     hub_presence.go:92       leaf
//	9     queueDropState.mu          hub_stats.go:163         leaf
//	9     EventRingBuffer.mu RW      ringbuffer.go:14         leaf
//	9     memberCache.mu             serve_ready_members_cache.go:33  leaf
//	9     activityState.mu           channel_activity.go:95   leaf
//	9     roleRefreshState.mu        role_refresh.go:66       leaf; may be taken under Hub.seqMu
//	9     restartNoticeGate.mu       restart_notice.go:16     leaf
//	9     userLocks.mu               user_locks.go:34         leaf, but see userLocks.tryLock below
//	-     LiveKitProcess.mu          livekit_process.go:37    unranked: independent subsystem
//
// Hub.background (hub.go:110) is a syncutil.Group, not a mutex, so it has no row.
//
// Locks of one rank are not ordered against each other, so the checker
// forbids nesting any two of them, two instances of one lock included.
// Hub.uploadPolicyMu (3) taking Hub.settingsMu (6) is not such a pair.
//
// # Known exceptions to the rule
//
//   - Hub.settingsMu is held for writing across a DB read (hub_settings.go:27-35).
//     It is the one state lock that does I/O. The read is bounded by a context.
//   - slog on a non-error path under a lock: Hub.seqMu and Hub.mu in registerNow
//     (hub_registry.go:100), Client.mu on overflow (client.go:195,303), and
//     Hub.seqMu in expireReplayTombstones and dropsForTombstones
//     (hub_tombstones.go:169,188,192).
//   - userLocks.mu is a leaf except in userLocks.tryLock (user_locks.go), which
//     takes a new userLockEntry.mu while holding it. The entry is private until
//     it is inserted, so the acquisition is a TryLock that cannot fail, and the
//     rank check never flags a try.
//   - Hub.persistEvent under Hub.seqMu (hub_events.go:305) is a non-blocking
//     channel send with a default (event_persister.go), so it is not I/O.
//
// # What the first checked run found (WP 5.6c)
//
// The whole -tags deadlock suite, run with the checker reporting instead of
// panicking, found one out-of-order acquire and no production one: a test
// (TestSweepAFK_SkipsMemberWithModerationInFlight) held voiceMod on the
// goroutine that then ran the AFK sweep, which takes voiceMember. In
// production the moderator is another goroutine; the test now holds voiceMod
// on one too. The checker sees only the paths the suite runs: a Client.mu
// holder calling back into the hub on an untested path would still go unseen.

package ws

// Rank types, one per rank of the table. Each is the R of the
// syncutil.Ranked[R] or RankedRW[R] that declares a lock of that rank; the
// lock-rank invariant reads the literal each Rank method returns, so keep it
// a literal.
type (
	lockRankVoiceMember struct{} // userLockEntry.mu of voiceRegistry.voiceMember
	lockRankVoiceMod    struct{} // userLockEntry.mu of Hub.voiceMod
	lockRankSerialiser  struct{} // the rank-3 serialisers
	lockRankFeed        struct{} // timeoutViewState.mu, Hub.presenceMu
	lockRankSeq         struct{} // Hub.seqMu
	lockRankHubCache    struct{} // Hub.keyHolderMu, Hub.settingsMu
	lockRankHub         struct{} // Hub.mu
	lockRankPubSub      struct{} // PubSub.mu
	lockRankLeaf        struct{} // the leaves
)

func (lockRankVoiceMember) Rank() int { return 1 }
func (lockRankVoiceMod) Rank() int    { return 2 }
func (lockRankSerialiser) Rank() int  { return 3 }
func (lockRankFeed) Rank() int        { return 4 }
func (lockRankSeq) Rank() int         { return 5 }
func (lockRankHubCache) Rank() int    { return 6 }
func (lockRankHub) Rank() int         { return 7 }
func (lockRankPubSub) Rank() int      { return 8 }
func (lockRankLeaf) Rank() int        { return 9 }
