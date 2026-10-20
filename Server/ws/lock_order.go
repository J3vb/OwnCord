// Lock order of the ws package: the one written order for every mutex the hub
// owns. Other files carry local fragments of it; where one disagrees with this
// block, this block wins and the fragment is the bug. The order is read from
// the code at the paths cited, not checked: only the -tags deadlock leg
// (go-deadlock) observes it, and it reports an inversion only when one test
// takes the same two lock instances in both orders.
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
// read at origin/dev f4a359e8 and are cites, not contracts.
//
//	rank  lock                       declared                 taken under it
//	1 S   userLockEntry.mu           voice_registry.go:45     DB, broadcasts, seqMu (replay.go:438-441); never a
//	      (voiceRegistry.voiceMember) user_locks.go:40         LiveKit RPC
//	2 S   userLockEntry.mu           hub.go:217               DB and LiveKit RPC (user_locks.go:9-17); never a
//	      (Hub.voiceMod)             user_locks.go:40         membership path
//	3 S   replayPurgeState.mu RW     hub_tombstones.go:53     seqMu (hub_events.go:210), then the persister
//	      (Hub.tombstones)                                    Flush and the DB delete (hub_events.go:218-235).
//	                                                          Cold reads only TryRLock (eventstore.go:46-62)
//	3 S   activityState.flushMu      channel_activity.go:105  DB reads under activityFlushTimeout, then
//	                                                          activityState.mu, then Hub.mu, PubSub.mu and
//	                                                          Client.mu one at a time
//	3 S   Hub.uploadPolicyMu         hub.go:224               a DB read, then Hub.settingsMu, then Hub.mu (R),
//	                                                          then Client.mu (hub_settings.go:93-113)
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
//	                                                          queueDropState.mu, plugin.EventSink.mu
//	                                                          (hub_broadcast.go:440-444), and the leaves below
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
//	9     leaves, ranked together; nothing is taken under any of them:
//	        Client.mu (client.go:81), voiceSlot.voiceMu (voice_registry.go:81),
//	        voiceGraceState.mu (voice_grace.go:54), voiceReconcileState.mu (voice_reconcile.go:42),
//	        voiceRejoinBlockState.mu (voice_rejoin_block.go:34), removedIdentities.mu (voice_removed_watch.go:35),
//	        presenceRepairState.mu (hub_presence.go:92), queueDropState.mu (hub_stats.go:163),
//	        EventRingBuffer.mu (ringbuffer.go:14), memberCache.mu (serve_ready_members_cache.go:33),
//	        activityState.mu (channel_activity.go:95), restartNoticeGate.mu (restart_notice.go:16),
//	        userLocks.mu (user_locks.go:30)
//	-     LiveKitProcess.mu (livekit_process.go:37) and Hub.background (a syncutil.Group, hub.go:110): an
//	      independent subsystem, not ranked
//
// The two rank-3 pairs and the rank-4 and rank-6 pairs are not ordered
// against each other; no path read takes one under the other except
// Hub.uploadPolicyMu, which takes Hub.settingsMu.
//
// # Known exceptions to the rule
//
//   - plugin.EventSink.Dispatch runs under Hub.seqMu (hub_broadcast.go:440-444).
//     It is inert: no production caller of Subscribe exists (plugin/host_events.go).
//   - Hub.settingsMu is held for writing across a DB read (hub_settings.go:27-35).
//     It is the one state lock that does I/O. The read is bounded by a context.
//   - slog on a non-error path under a lock: Hub.seqMu and Hub.mu in registerNow
//     (hub_registry.go:100), Client.mu on overflow (client.go:195,303), and
//     Hub.seqMu in expireReplayTombstones and dropsForTombstones
//     (hub_tombstones.go:169,188,192).
//   - Hub.persistEvent under Hub.seqMu (hub_events.go:305) is a non-blocking
//     channel send with a default (event_persister.go), so it is not I/O.
//
// # Not found, not checked
//
// No inversion was found on the paths read. Whether some Client.mu holder
// calls back into the hub on a path not read is unverified.

package ws
