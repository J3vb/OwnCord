// Package ws provides the WebSocket hub and client management for OwnCord.
package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/stackutil"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// Hub manages all active WebSocket clients and routes messages between them. All
// exported methods are safe to call from multiple goroutines.
type Hub struct {
	// clients maps user id to live connections, one per device session (hub_conns.go).
	clients        map[int64][]*Client
	offlineClaimed map[int64]struct{} // users whose offline teardown is claimed
	mu             syncutil.RankedRW[lockRankHub]
	db             *db.DB
	limiter        *auth.RateLimiter
	broadcast      chan broadcastMsg
	// clientEvents carries register and unregister requests on one channel so a
	// connection's Register-to-Unregister sequence is processed in submission order;
	// with two channels a fast connect/disconnect could unregister first (a no-op)
	// then register, admitting a dead ghost until the stale sweep.
	clientEvents chan clientEvent
	stop         chan struct{}
	// stopUsers: see StoppedUserIDs. Guarded by mu.
	stopUsers   []int64
	livekit     *LiveKitClient
	permChecker *permissions.Checker
	// perms is the cached permission service. Nil in bare test hubs, where every use
	// falls back to the live permChecker. Revocation stays prompt because each
	// mutation site invalidates synchronously (InvalidateUser on role change,
	// InvalidateAll on channel-override change); the cache TTL is a backstop.
	perms *service.PermissionService
	// connGen moves whenever a connection is added or removed (under mu), so a
	// memoised audience can tell the connected set changed (audience_memo.go).
	connGen atomic.Uint64
	// audience memoises channel read audiences and the moderator set (audience_memo.go).
	audience audienceMemo
	pubsub   *PubSub // topic-based pub/sub for O(subscribers) broadcast

	seq         uint64                       // atomic monotonic sequence counter
	seqMu       syncutil.Ranked[lockRankSeq] // seq assignment + replay + delivery order; order: lock_order.go
	timeoutView timeoutViewState             // member_timeouts delivery; lock order in member_timeouts_delivery.go
	replayBuf   *EventRingBuffer             // recent broadcast events for reconnection replay

	// stats groups the hub's drop, backpressure, reject, reconnect-tier and latency counters.
	stats hubStats

	// seams are the services and policy sources the hub calls out to.
	seams hubSeams
	// events is the persistence, replay and plugin fan-out tier.
	events hubEventTier

	// lifecycle is the run, stop and sweep-guard state.
	lifecycle hubLifecycle

	gates contentGates // NSFW content gate reads parked off the dispatch goroutine (hub_content_gate.go)

	readyGate chan struct{} // one slot per concurrent fresh-connect ready build (admitReady)

	// voiceHub is the voice family's registry, reconciler, key-holder state and locks (hub_voice_state.go).
	voiceHub hubVoice

	// voiceResumeChecks are the SFU checks of memberships resumed sockets took over
	// (voice_resume_check.go).
	voiceResumeChecks voiceResumeChecks

	// Sequence watermark of the last channel-visibility change or content shed:
	// neither reaches a client via replay, so a client resuming from a seq at or
	// before it takes the full-ready path. Reset on restart (a fresh connection gets a
	// correctly filtered ready anyway).
	visibilityChangeSeq atomic.Uint64
	targetedFanouts     int // targeted fan-outs in flight (beginTargetedFanout); guarded by seqMu

	// replayPurgeSeq is the watermark of the last account-erasure replay purge
	// (PurgeUserFromReplay): a client resuming at or before it may have missed the
	// purged member_ban and takes the full ready, since the purge left holes replay
	// cannot fill. Ratcheted like visibilityChangeSeq; written under seqMu.
	replayPurgeSeq atomic.Uint64
	// tombstones are the erased users and retention-swept messages whose late frames
	// are dropped, plus the purge/cold-read lock (hub_tombstones.go).
	tombstones replayPurgeState

	// settings is the cache avoiding per-connection DB queries for server_name/motd,
	// with its read seam and the upload-policy and game activity state (hub_settings.go).
	settings hubSettings

	// readers are the hub's remaining read seams (readers.go).
	readers HubReaders

	// presence is the connection lifecycle's two writes (PresenceStamper): the status a
	// session comes online as, and the offline stamp when its last pump exits. Required.
	presence PresenceStamper

	// voice is the voice family's service (VoiceStore): every voice_states read and
	// write. Required: a nil store would fail on the first join rather than at
	// construction.
	voice VoiceStore

	// presenceFeed is the presence coalescer and its repair state (hub_presence_state.go).
	presenceFeed presenceFeedState

	members     memberCache      // the ready payloads' shared member list (serve_ready_members_cache.go)
	activity    activityState    // channel_activity coalescer (channel_activity.go)
	roleRefresh roleRefreshState // role-change fan-out worker (role_refresh.go)
	threadHub   threadHub        // thread service and thread_changed coalescer (thread_coalescer.go); timers guarded by mu
}

// Run starts the hub's dispatch loop and blocks until Stop is called; run it in its
// own goroutine. A panic recovery wrapper restarts the select loop; more than 3
// panics within 60 seconds stops it permanently to avoid a crash loop.
// avoid a tight crash loop.
func (h *Hub) Run() {
	if h.lifecycle.runDone != nil {
		defer h.finishRun()
	}
	h.lifecycle.running.Store(true)
	defer h.lifecycle.dispatchExited.Store(true)
	h.startSweepWorkers()
	var panicCount int
	var lastPanicReset time.Time

	for {
		func() {
			staleTicker := time.NewTicker(30 * time.Second)
			defer staleTicker.Stop()
			sessionSweepTicker := time.NewTicker(30 * time.Second)
			defer sessionSweepTicker.Stop()
			voiceSweepTicker := time.NewTicker(60 * time.Second)
			defer voiceSweepTicker.Stop()

			defer func() {
				if r := recover(); r != nil {
					now := time.Now()
					if lastPanicReset.IsZero() || now.Sub(lastPanicReset) > 60*time.Second {
						panicCount = 0
						lastPanicReset = now
					}
					panicCount++

					slog.Error("hub: panic recovered",
						"panic", r,
						"panic_count", panicCount,
						"stack", stackutil.Capture())

					// A Windows hardware fault (nil deref or invalid address) may have left the heap
					// corrupt, so it exits at once instead of recovering onto damaged memory. Software
					// panics keep the breaker below.
					hardware := stackutil.Recovered(r)
					breaker := panicCount >= 3
					if hardware || breaker {
						// State is unknown and a dead loop is invisible from outside, so exit for a
						// supervisor restart (see fatalFn; tests substitute a no-op and rely on Stop).
						slog.Error("hub: stopping and exiting for supervisor restart",
							"hardware_fault", hardware, "panic_count", panicCount)
						h.Stop()
						h.lifecycle.dispatchExited.Store(true)
						if h.lifecycle.fatalFn != nil {
							h.lifecycle.fatalFn()
						}
						return
					}
				}
			}()

			for {
				select {
				case <-h.stop:
					return
				case ev := <-h.clientEvents:
					h.onClientEvent(ev)
				case bm := <-h.broadcastIn():
					h.dispatch(bm)
				case res := <-h.gates.results:
					h.onGateResolved(res)
				case <-staleTicker.C:
					h.onStaleTick()
				case <-sessionSweepTicker.C:
					// The revoked-session and stale-voice sweeps do per-client DB work, so they run
					// off the dispatch goroutine; a slow sweep must not stall broadcast delivery.
					h.startSweep(&h.lifecycle.sessionSweepInFlight, h.sweepRevokedSessions)
				case <-voiceSweepTicker.C:
					h.startSweep(&h.lifecycle.voiceSweepInFlight, h.sweepStaleVoiceStates)
					// The reconciler and the AFK moves have their own guards: a slow ListParticipants
					// or move never suppresses the ghost sweep.
					h.startSweep(&h.lifecycle.voiceReconcileInFlight, h.reconcileVoiceMembership)
					h.startSweep(&h.lifecycle.afkSweepInFlight, h.sweepAFK)
				}
			}
		}()

		if panicCount >= 3 {
			return
		}
		select {
		case <-h.stop:
			return
		default:
		}
	}
}

// StopLiveKit stops and reaps the owned companion before a restart handoff. Safe
// concurrently with GracefulStopContext; deliberately does not wait on hub/client
// teardown so the restart backstop can use it too.
func (h *Hub) StopLiveKit() {
	if h.voiceHub.lkProcess != nil {
		h.voiceHub.lkProcess.Stop()
	}
}

// GracefulStop stops the hub, announcing a plain shutdown, then the LiveKit process
// (if managed). Safe to call concurrently. Prefer GracefulStopContext where a
// shutdown budget exists; this waits the full client-notice window.
func (h *Hub) GracefulStop() {
	h.GracefulStopContext(context.Background(), RestartReasonShutdown)
}

// GracefulStopContext is GracefulStop bounded by ctx: the client-notice wait ends
// early when ctx expires, so the drain counts against the caller's shutdown
// budget. Order: notice, notice window, socket close, StopLiveKit. reason is what
// the restart notice tells clients (an update, a restore). Safe to call
// concurrently; only the first call's ctx and reason are used.
func (h *Hub) GracefulStopContext(ctx context.Context, reason RestartReason) {
	h.lifecycle.gracefulOnce.Do(func() {
		h.recordStopUsers()
		// The notice window matters only when someone is connected to hear it; an idle
		// server skips straight to teardown.
		hasClients := h.ClientCount() > 0
		if hasClients {
			h.BroadcastServerRestart(reason, 5)
		}

		// Give clients the promised notice window (5s, matching the countdown) to disconnect gracefully.
		if hasClients {
			select {
			case <-time.After(5 * time.Second):
			case <-ctx.Done():
			}
		}

		h.closeClientsForStop()

		// Voice reconnect grace timers stop; a late readPump park arms none.
		h.voiceHub.reg.close()

		// Stop LiveKit after the sockets so clients see a close rather than a dead room.
		// The voice rows stay for the next boot's wipe.
		h.StopLiveKit()

		h.lifecycle.stopOnce.Do(h.closeStop)
	})
}
