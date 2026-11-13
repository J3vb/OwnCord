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

// Hub manages all active WebSocket clients and routes messages between them. Exported methods are
// safe for concurrent use.
type Hub struct {
	clients        map[int64][]*Client
	offlineClaimed map[int64]struct{} // users whose offline teardown is claimed
	mu             syncutil.RankedRW[lockRankHub]
	db             *db.DB
	limiter        *auth.RateLimiter
	broadcast      chan broadcastMsg
	// clientEvents carries register and unregister on one channel so a connection's Register-to-
	// Unregister order is preserved; with two channels a fast connect/disconnect could unregister
	// first (a no-op) and then admit a dead ghost until the stale sweep.
	clientEvents chan clientEvent
	stop         chan struct{}
	stopUsers    []int64 // see StoppedUserIDs; guarded by mu
	livekit      *LiveKitClient
	permChecker  *permissions.Checker
	// perms is the cached permission service, nil in bare test hubs (live permChecker fallback).
	// Revocation stays prompt because every mutation site invalidates synchronously; the cache TTL
	// is a backstop.
	perms *service.PermissionService
	// connGen moves whenever a connection is added or removed (under mu), so a memoised audience
	// can tell the connected set changed.
	connGen  atomic.Uint64
	audience audienceMemo
	pubsub   *PubSub // topic-based pub/sub for O(subscribers) broadcast

	seq         uint64                       // atomic monotonic sequence counter
	seqMu       syncutil.Ranked[lockRankSeq] // seq assignment + replay + delivery order; order: lock_order.go
	timeoutView timeoutViewState             // member_timeouts delivery; lock order in member_timeouts_delivery.go
	replayBuf   *EventRingBuffer             // recent broadcast events for reconnection replay

	stats hubStats

	seams hubSeams
	// ringPush carries DM call rings to phones; nil means off. Atomic: internal/app installs it after Run.
	ringPush atomic.Pointer[ringPusherBox]
	events   hubEventTier

	lifecycle hubLifecycle

	gates contentGates // NSFW content gate reads parked off the dispatch goroutine (hub_content_gate.go)

	readyGate chan struct{} // one slot per concurrent fresh-connect ready build (admitReady)

	voiceHub hubVoice

	voiceResumeChecks voiceResumeChecks

	// Sequence watermark of the last channel-visibility change or content shed, neither of which
	// reaches a client via replay: a client resuming at or before it takes the full-ready path.
	// Reset on restart.
	visibilityChangeSeq atomic.Uint64
	targetedFanouts     int // targeted fan-outs in flight (beginTargetedFanout); guarded by seqMu

	// replayPurgeSeq is the watermark of the last account-erasure replay purge: a client resuming
	// at or before it may have missed the purged member_ban and takes the full ready. Ratcheted
	// like visibilityChangeSeq; written under seqMu.
	replayPurgeSeq atomic.Uint64
	tombstones     replayPurgeState

	settings hubSettings

	readers HubReaders

	// presence is the connection lifecycle's two writes (online status, offline stamp). Required.
	presence PresenceStamper

	// voice is the voice family's service; required, since a nil store would fail on the first join
	// rather than at construction.
	voice VoiceStore

	presenceFeed presenceFeedState

	members     memberCache      // the ready payloads' shared member list (serve_ready_members_cache.go)
	activity    activityState    // channel_activity coalescer (channel_activity.go)
	roleRefresh roleRefreshState // role-change fan-out worker (role_refresh.go)
	threadHub   threadHub        // thread service and thread_changed coalescer (thread_coalescer.go); timers guarded by mu
}

// Run starts the dispatch loop and blocks until Stop; run it in its own goroutine. A panic restarts
// the select loop, but more than 3 panics within 60 seconds stop it permanently to avoid a crash
// loop.
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

					// A Windows hardware fault (nil deref, invalid address) may have corrupted the
					// heap, so exit at once instead of recovering onto damaged memory.
					hardware := stackutil.Recovered(r)
					breaker := panicCount >= 3
					if hardware || breaker {
						// State is unknown and a dead loop is invisible from outside, so exit for a
						// supervisor restart (fatalFn; tests substitute a no-op).
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
					// The reconciler and AFK moves have their own guards: a slow ListParticipants
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

// StopLiveKit stops and reaps the owned companion before a restart handoff. Safe concurrently with
// GracefulStopContext; does not wait on client teardown so the restart backstop can use it.
func (h *Hub) StopLiveKit() {
	if h.voiceHub.lkProcess != nil {
		h.voiceHub.lkProcess.Stop()
	}
}

// GracefulStop stops the hub with a plain shutdown notice, then LiveKit if managed. Prefer
// GracefulStopContext where a shutdown budget exists; this waits the full client-notice window.
func (h *Hub) GracefulStop() {
	h.GracefulStopContext(context.Background(), RestartReasonShutdown)
}

// GracefulStopContext is GracefulStop bounded by ctx, so the notice wait counts against the
// caller's budget. Order: notice, notice window, socket close, StopLiveKit. Only the first call's
// ctx and reason are used.
func (h *Hub) GracefulStopContext(ctx context.Context, reason RestartReason) {
	h.lifecycle.gracefulOnce.Do(func() {
		h.recordStopUsers()
		// The notice window matters only when someone is connected; an idle server skips to
		// teardown.
		hasClients := h.ClientCount() > 0
		if hasClients {
			h.BroadcastServerRestart(reason, 5)
		}

		if hasClients {
			select {
			case <-time.After(5 * time.Second):
			case <-ctx.Done():
			}
		}

		h.closeClientsForStop()

		h.voiceHub.reg.close()

		// Stop LiveKit after the sockets so clients see a close rather than a dead room; voice rows
		// stay for the next boot's wipe.
		h.StopLiveKit()

		h.lifecycle.stopOnce.Do(h.closeStop)
	})
}
