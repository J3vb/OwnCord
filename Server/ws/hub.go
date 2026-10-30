// Package ws provides the WebSocket hub and client management for OwnCord.
package ws

import (
	"context"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/plugin"
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
	stopOnce     sync.Once
	gracefulOnce sync.Once
	// stopUsers: see StoppedUserIDs. Guarded by mu.
	stopUsers   []int64
	livekit     *LiveKitClient
	lkProcess   *LiveKitProcess
	registry    *HandlerRegistry
	permChecker *permissions.Checker
	// perms is the cached permission service. Nil in bare test hubs, where every use
	// falls back to the live permChecker. Revocation stays prompt because each
	// mutation site invalidates synchronously (InvalidateUser on role change,
	// InvalidateAll on channel-override change); the cache TTL is a backstop.
	perms *service.PermissionService
	// focusDeps is the presence handlers' dependency set; the deferred-focus drain
	// goroutine (focus_defer.go) reuses its limiter and channel service so it meters
	// and authorises like handleChannelFocusV2. ChannelSvc is nil in bare test hubs.
	focusDeps PresenceDeps
	// messageSvc gates plugin broadcasts through the same posting policy as a real
	// send (permissions, DM membership, blocks). Nil only in bare test hubs; the gate
	// then fails closed.
	messageSvc *service.MessageService
	pubsub     *PubSub // topic-based pub/sub for O(subscribers) broadcast

	restartGate restartNoticeGate // dedupes BroadcastServerRestart

	seq            uint64                       // atomic monotonic sequence counter
	seqMu          syncutil.Ranked[lockRankSeq] // seq assignment + replay + delivery order; order: lock_order.go
	timeoutView    timeoutViewState             // member_timeouts delivery; lock order in member_timeouts_delivery.go
	replayBuf      *EventRingBuffer             // recent broadcast events for reconnection replay
	broadcastDrops atomic.Uint64                // counts messages dropped due to full broadcast channel
	queueDrops     queueDropState               // frames the full broadcast queue dropped (hub_stats.go)

	// latency is the shipped in-process metrics surface; the zero value is usable.
	latency hubLatencyMetrics

	// Event persistence; nil means ring buffer only. Atomic because internal/app wires
	// these one lifecycle stage after Run has started, and Run reads them on the
	// broadcast/replay paths.
	eventPersister atomic.Pointer[EventPersister]
	eventStore     atomic.Pointer[EventStore] // read path for cold-tier replay

	pluginRegistry *plugin.Registry                 // slash-command dispatch; nil = no plugins; HubOptions field
	pluginSink     atomic.Pointer[plugin.EventSink] // hub→plugin event fan-out; nil = no plugins

	// running flips when Run starts; tests read it via RunningForTest to wait for the
	// dispatch loop.
	running atomic.Bool

	// dispatchExited flips when Run returns for good (Stop or the panic breaker).
	// /health reads it via DispatchAlive: clients keep registering and appearing
	// online through registerNow even with the loop dead, so nothing else makes the
	// outage observable.
	dispatchExited atomic.Bool

	// runDone closes when Run returns, after dispatchExited is set and its sweeps
	// returned. Stop and GracefulStopContext only signal the loop; whoever started Run
	// joins it here (Done) before releasing what it reads. Made by NewHub; nil on
	// struct-literal hubs in internal tests.
	runDone chan struct{}

	// life is cancelled by closeStop; sweeps and background work (voice-leave cleanup,
	// joined by JoinBackground) run under it. Made by NewHub.
	life       context.Context
	stopLife   context.CancelFunc
	sweeps     sync.WaitGroup
	background *syncutil.Group
	gates      contentGates // NSFW content gate reads parked off the dispatch goroutine (hub_content_gate.go)

	// fatalFn runs when the panic breaker trips (3 panics/60s). A hub that panicked
	// that often has unknown state, so production exits and lets the supervisor
	// restart rather than serve connections that can never receive a broadcast. Tests
	// replace it.
	fatalFn func()

	// Aggregate backpressure counters: the per-client msgsDropped is read once at
	// disconnect and lost; these survive as process totals for the metrics endpoint.
	bpQueueDisconnects atomic.Uint64 // clients disconnected because send (or high+send) overflowed
	bpHighFallbacks    atomic.Uint64 // high-priority sends that fell back to the normal buffer
	bpLowDrops         atomic.Uint64 // low-priority messages silently dropped on overflow

	connRejects atomic.Uint64 // upgrades refused by the max_ws_connections guardrail (ServeWS)
	readyGate   chan struct{} // one slot per concurrent fresh-connect ready build (admitReady)

	// coldReplayLimit caps persisted-event replay per reconnect; 0 = maxColdReplay.
	coldReplayLimit int

	// In-flight guards for the DB-heavy sweeps (startSweep): a tick arriving while the
	// previous sweep runs is skipped, not stacked.
	sessionSweepInFlight                                         atomic.Bool
	voiceSweepInFlight, voiceReconcileInFlight, afkSweepInFlight atomic.Bool

	voiceReconcile voiceReconcileState // polling reconciler (voice_reconcile.go)
	voiceReg       voiceRegistry       // voice membership lock and grace window (voice_registry.go)

	voiceRejoinBlocks voiceRejoinBlockState // voice_rejoin_block.go

	// Reconnection tier metrics, incremented per resume.
	reconnectTierBuf  atomic.Uint64
	reconnectTierDB   atomic.Uint64
	reconnectTierFull atomic.Uint64
	reconnectRingMiss atomic.Uint64 // resumes behind the ring (see noteRingMiss); usually ends in db or full

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

	// Settings cache avoiding per-connection DB queries for server_name/motd; settings
	// is the read seam it refreshes through.
	settings SettingsReader

	// readers are the hub's remaining read seams (readers.go).
	readers HubReaders

	// privacy is the channel-level private flag source (nil: nothing private).
	privacy ChannelPrivacy

	// presence is the connection lifecycle's two writes (PresenceStamper): the status a
	// session comes online as, and the offline stamp when its last pump exits. Required.
	presence PresenceStamper

	// authn is the auth family's service (SocketAuthenticator): bearer-token
	// resolution, the sweep's session verdicts and the connect audit row. Required.
	authn SocketAuthenticator

	// trustedProxyNets is server.trusted_proxies parsed once: the handshake resolves
	// the client address for its log line and ws_connect audit row through it, so a
	// reverse-proxy deployment records the client, not the proxy hop. Empty means
	// RemoteAddr is used and a client-supplied header is ignored.
	trustedProxyNets []*net.IPNet

	// voice is the voice family's service (VoiceStore): every voice_states read and
	// write. Required: a nil store would fail on the first join rather than at
	// construction.
	voice VoiceStore

	// defaultVoiceQuality is the operator-configured voice.quality
	// (HubOptions.VoiceQuality), used by voiceJoinComplete. Always one of
	// voiceQualities' keys (NewHub normalizes it). Set once, never mutated
	// (voice.quality is startup-only), so no mutex guards it.
	defaultVoiceQuality string
	uploadFileTypes     UploadFileTypes // HubOptions.UploadFileTypes; may be nil

	// voiceMod is the per-target-user lock serializing a voice-moderation DB
	// transition with its paired LiveKit call (user_locks.go). Always non-nil (made in
	// NewHub): without it the timeout path and the manual voice-mute endpoint could
	// interleave.
	voiceMod *userLocks[lockRankVoiceMod]

	settingsMu         syncutil.RankedRW[lockRankHubCache]
	settingsName       string
	settingsMotd       string
	settingsUpload     UploadPolicy // auth_ok's upload_policy; the lists refresh with the cache
	settingsLastUpdate time.Time
	uploadPolicyMu     syncutil.Ranked[lockRankSerialiser] // orders BroadcastUploadPolicy's saves (hub_settings.go)
	gameActivity       gameActivityState                   // the game activity switch (hub_settings.go)
	// voiceKeyHolders maps channelID to the current key holder (the connected
	// participant with the lowest userID). Protected by keyHolderMu.
	keyHolderMu     syncutil.RankedRW[lockRankHubCache]
	voiceKeyHolders map[int64]int64
	// Presence coalescer (QueuePresence): latest presence per user, flush armed. Guarded by presenceMu.
	presenceMu         syncutil.Ranked[lockRankFeed]
	presenceQueue      map[int64]pendingPresence
	presenceFlushArmed bool
	presenceRepair     presenceRepairState // dropped presence and its repair (hub_presence.go)
	members            memberCache         // the ready payloads' shared member list (serve_ready_members_cache.go)
	activity           activityState       // channel_activity coalescer (channel_activity.go)
	roleRefresh        roleRefreshState    // role-change fan-out worker (role_refresh.go)
	threadHub          threadHub           // thread service and thread_changed coalescer (thread_coalescer.go); timers guarded by mu
}

// Run starts the hub's dispatch loop and blocks until Stop is called; run it in its
// own goroutine. A panic recovery wrapper restarts the select loop; more than 3
// panics within 60 seconds stops it permanently to avoid a crash loop.
// avoid a tight crash loop.
func (h *Hub) Run() {
	if h.runDone != nil {
		defer h.finishRun()
	}
	h.running.Store(true)
	defer h.dispatchExited.Store(true)
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
						h.dispatchExited.Store(true)
						if h.fatalFn != nil {
							h.fatalFn()
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
					h.startSweep(&h.sessionSweepInFlight, h.sweepRevokedSessions)
				case <-voiceSweepTicker.C:
					h.startSweep(&h.voiceSweepInFlight, h.sweepStaleVoiceStates)
					// The reconciler and the AFK moves have their own guards: a slow ListParticipants
					// or move never suppresses the ghost sweep.
					h.startSweep(&h.voiceReconcileInFlight, h.reconcileVoiceMembership)
					h.startSweep(&h.afkSweepInFlight, h.sweepAFK)
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
	if h.lkProcess != nil {
		h.lkProcess.Stop()
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
	h.gracefulOnce.Do(func() {
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
		h.voiceReg.close()

		// Stop LiveKit after the sockets so clients see a close rather than a dead room.
		// The voice rows stay for the next boot's wipe.
		h.StopLiveKit()

		h.stopOnce.Do(h.closeStop)
	})
}
