// Package ws provides the WebSocket hub and client management for OwnCord.
package ws

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
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

// Hub manages all active WebSocket clients and routes messages between them.
// All exported methods are safe to call from multiple goroutines.
type Hub struct {
	clients   map[int64]*Client
	mu        syncutil.RWMutex
	db        *db.DB
	limiter   *auth.RateLimiter
	broadcast chan broadcastMsg
	// clientEvents carries register AND unregister requests on one channel so
	// a connection's Register→Unregister sequence is processed in submission
	// order. With two separate channels, Run's select picked randomly between
	// them when both were ready — a fast connect/disconnect could process the
	// unregister first (a no-op for an unknown client) and then the register,
	// admitting an already-dead client as a ghost until the stale sweep.
	clientEvents chan clientEvent
	stop         chan struct{}
	stopOnce     sync.Once
	gracefulOnce sync.Once
	livekit      *LiveKitClient
	lkProcess    *LiveKitProcess
	registry     *HandlerRegistry
	permChecker  *permissions.Checker
	// perms is the cached permission service (service.PermissionService). Nil in
	// bare test hubs constructed without Services; every use falls back to the
	// live permChecker path then. Revocation stays prompt because each mutation
	// site invalidates synchronously (InvalidateUser on role change,
	// InvalidateAll on channel-override change) — the cache TTL is a backstop.
	perms *service.PermissionService
	// messageSvc gates plugin broadcasts through the same posting policy as a
	// real message send (permissions, DM membership, DM blocks). Nil only in
	// bare test hubs; the broadcast gate fails closed then.
	messageSvc *service.MessageService

	pubsub       *PubSub           // topic-based pub/sub for O(subscribers) broadcast
	topicLimiter *TopicRateLimiter // per-topic throughput caps

	seq            uint64           // atomic monotonic sequence counter
	seqMu          syncutil.Mutex   // serializes seq assignment + replay insertion + delivery order
	replayBuf      *EventRingBuffer // recent broadcast events for reconnection replay
	broadcastDrops atomic.Uint64    // counts messages dropped due to full broadcast channel

	// Phase B Step 7 — event persistence. nil = ring buffer only. Atomic
	// because internal/app wires these one lifecycle stage after Run has
	// started, which reads them on the broadcast/replay paths.
	eventPersister atomic.Pointer[EventPersister]
	eventStore     atomic.Pointer[EventStore] // read path for cold-tier replay

	// Phase C Step 9 — plugin wiring.
	pluginRegistry *plugin.Registry                 // slash-command dispatch; nil = no plugins; HubOptions field (B3-4)
	pluginSink     atomic.Pointer[plugin.EventSink] // hub→plugin event fan-out; nil = no plugins

	// running flips when Run starts. The pre-Run setters that used to check
	// it died in B3-4 (their fields are HubOptions now); tests still read it
	// via RunningForTest to wait for the dispatch loop.
	running atomic.Bool

	// dispatchExited flips when Run returns for good — normal Stop or the
	// panic breaker. /health reads it (via DispatchAlive) because clients keep
	// registering and appearing online through registerNow even with the
	// dispatch loop dead, so nothing else makes the outage observable.
	dispatchExited atomic.Bool

	// fatalFn runs when the panic breaker trips (3 panics/60s). A hub that
	// panicked three times in a minute has unknown state, so production exits
	// the process and lets the supervisor restart it rather than serving
	// connections that can never receive a broadcast. Tests replace it.
	fatalFn func()

	// Aggregate per-client backpressure counters. The per-client msgsDropped
	// field is read once at disconnect and lost; these survive as process
	// totals for the metrics endpoint.
	bpQueueDisconnects atomic.Uint64 // clients disconnected because send (or high+send) overflowed
	bpHighFallbacks    atomic.Uint64 // high-priority sends that fell back to the normal buffer
	bpLowDrops         atomic.Uint64 // low-priority messages silently dropped on overflow

	// connRejects counts upgrade requests refused by the max_ws_connections
	// capacity guardrail (ServeWS).
	connRejects atomic.Uint64

	// coldReplayLimit caps persisted-event replay per reconnect. 0 = the
	// compiled-in default (maxColdReplay). HubOptions.ReplayColdLimit (B3-4).
	coldReplayLimit int

	// In-flight guards for the DB-heavy sweeps Run kicks off in their own
	// goroutines (startSweep): a tick that arrives while the previous sweep
	// is still running is skipped rather than stacked.
	sessionSweepInFlight atomic.Bool
	voiceSweepInFlight   atomic.Bool

	// Phase B Step 7 — reconnection tier metrics. Incremented per resume.
	reconnectTierBuf  atomic.Uint64
	reconnectTierDB   atomic.Uint64
	reconnectTierFull atomic.Uint64

	// Sequence watermark of the last channel-visibility change. Visibility
	// updates are sent as targeted, unsequenced messages, so clients resuming
	// from a seq at or before this point must take the full-ready path to
	// converge (replay cannot deliver them). Reset on restart — a fresh
	// connection always gets a correctly filtered ready payload anyway.
	visibilityChangeSeq atomic.Uint64

	// Settings cache — avoids per-connection DB queries for server_name/motd.
	settingsMu         syncutil.RWMutex
	settingsName       string
	settingsMotd       string
	settingsLastUpdate time.Time

	// voiceKeyHolders maps channelID → userID of the current key holder.
	// The key holder is the connected participant with the lowest userID in the channel.
	// Protected by keyHolderMu.
	keyHolderMu     syncutil.RWMutex
	voiceKeyHolders map[int64]int64

	// Presence coalescer (QueuePresence): latest queued presence per user and
	// whether a flush timer is armed. Guarded by presenceMu.
	presenceMu         syncutil.Mutex
	presenceQueue      map[int64]pendingPresence
	presenceFlushArmed bool
}

// HubOptions carries everything a Hub needs before Run starts (S-11 / B3-4).
// The four pre-Run setters this struct replaced (SetLiveKit,
// SetLiveKitProcess, SetPluginRegistry, ConfigureReplay) were all guarded by
// rejectIfRunning — construction-phase wiring pretending to be mutable state.
// What genuinely IS mutable after Run stays a setter: the event persister,
// event store and plugin event sink are atomic hot-swaps that the app wires
// after the dispatch loop starts (internal/app/persistence.go), and
// SetPendingVoiceModFlags is per-user runtime state.
type HubOptions struct {
	// DB and Limiter are required: every dispatch path reads the database,
	// and the handler deps capture the limiter at registration. NewHub
	// refuses to build a Hub without them.
	DB      *db.DB
	Limiter *auth.RateLimiter

	// Services is the domain layer V2 handlers delegate to. Production
	// always passes it; nil is the degraded fixture many ws tests build,
	// where handlers keep their direct-DB fallback paths.
	Services *service.Services

	// LiveKit is the voice token signer; nil means voice is not configured
	// and every voice join is refused. LiveKitProcess is the supervised
	// companion SFU — it requires LiveKit, because a process no client can
	// sign tokens for is unusable, and the voice_join guard reads a non-nil
	// process's IsRunning to fail closed while it is down.
	LiveKit        *LiveKitClient
	LiveKitProcess *LiveKitProcess

	// PluginRegistry enables plugin slash-command dispatch; nil disables it.
	// The plugin event sink is NOT here: it consumes the built hub's
	// broadcaster, so it stays the two-phase SetPluginEventSink.
	PluginRegistry *plugin.Registry

	// Replay budget (event_persistence.replay_ring_size / replay_cold_limit).
	// Zero keeps the compiled-in defaults; negative is refused rather than
	// silently ignored.
	ReplayRingSize  int
	ReplayColdLimit int
}

// NewHub creates a Hub ready to be started with Run, validating that the
// required collaborators are present — before B3-4, construction always
// succeeded and a missing collaborator surfaced as a later panic or a
// silently refused setter call. It also initializes the settings cache from
// the database. If opts.Services is non-nil, V2 handlers receive service
// references for business logic delegation.
func NewHub(opts HubOptions) (*Hub, error) {
	if opts.DB == nil {
		return nil, errors.New("ws: HubOptions.DB is required (every dispatch path reads it)")
	}
	if opts.Limiter == nil {
		return nil, errors.New("ws: HubOptions.Limiter is required (handler deps capture it at registration)")
	}
	if opts.LiveKitProcess != nil && opts.LiveKit == nil {
		return nil, errors.New("ws: HubOptions.LiveKitProcess without LiveKit — a supervised SFU no client can sign tokens for")
	}
	if opts.ReplayRingSize < 0 || opts.ReplayColdLimit < 0 {
		return nil, fmt.Errorf("ws: negative replay budget (ring %d, cold %d)", opts.ReplayRingSize, opts.ReplayColdLimit)
	}

	database, limiter, svc := opts.DB, opts.Limiter, opts.Services

	ringSize := 1000
	if opts.ReplayRingSize > 0 {
		ringSize = opts.ReplayRingSize
	}

	reg := NewHandlerRegistry()

	h := &Hub{
		clients:         make(map[int64]*Client),
		db:              database,
		limiter:         limiter,
		broadcast:       make(chan broadcastMsg, 1024),
		clientEvents:    make(chan clientEvent, 64),
		stop:            make(chan struct{}),
		pubsub:          NewPubSub(),
		topicLimiter:    NewTopicRateLimiter(topicRateLimitPerSecond, time.Second),
		replayBuf:       NewEventRingBuffer(ringSize),
		registry:        reg,
		permChecker:     permissions.NewChecker(database),
		settingsName:    "OwnCord Server",
		settingsMotd:    "Welcome!",
		voiceKeyHolders: make(map[int64]int64),
		fatalFn:         func() { os.Exit(1) },
		livekit:         opts.LiveKit,
		lkProcess:       opts.LiveKitProcess,
		pluginRegistry:  opts.PluginRegistry,
	}
	if opts.ReplayColdLimit > 0 {
		h.coldReplayLimit = opts.ReplayColdLimit
	}

	// V2 handler registrations (need Hub fields for deps).
	registerPingHandler(reg, PingDeps{Limiter: h.limiter})

	chatDeps := ChatDeps{
		Limiter: h.limiter,
	}
	presenceDeps := PresenceDeps{
		Limiter: h.limiter,
	}
	reactionDeps := ReactionDeps{}
	callDeps := CallDeps{Limiter: h.limiter}
	if svc != nil {
		chatDeps.MessageSvc = svc.Messages
		presenceDeps.ChannelSvc = svc.Channels
		reactionDeps.MessageSvc = svc.Messages
		callDeps.DMSvc = svc.DMs
		h.messageSvc = svc.Messages
		h.perms = svc.Permissions
		// So @here's offline narrowing can tell a disconnected idle/dnd reader
		// (users.status keeps their last *chosen* value across a disconnect)
		// from one who is actually still connected — the same live-connection
		// rule presentableMembers applies to the members array.
		svc.Messages.SetOnlineChecker(h.IsUserConnected)
		// So every DM payload DMService builds (GET/POST /dms, POST
		// /dms/group, PATCH /dms/{id}, and every broadcastDMOpen refresh)
		// applies the same live-connection rule instead of only the ready
		// payload's presentableDMChannels doing so (OC-0304).
		svc.DMs.SetOnlineChecker(h.IsUserConnected)
	}

	registerChatHandlers(reg, chatDeps)
	registerPresenceHandlers(reg, presenceDeps)
	registerReactionHandlers(reg, reactionDeps)
	registerCallHandlers(reg, callDeps)
	// Phase C Step 9 — plugin slash commands. The registry closure predates
	// B3-4 (the registry used to arrive via a post-construction setter); it
	// stays a closure for the nil-interface reason below. MessageSvc gates
	// broadcasts.
	reg.RegisterV2(MsgTypeChatCommand, handleChatCommandV2, PluginDeps{
		// A nil registry must yield a nil interface, not a typed-nil
		// *plugin.Registry — the handler's "no plugins loaded" check is an
		// interface comparison.
		Registry: func() CommandDispatcher {
			if h.pluginRegistry == nil {
				return nil
			}
			return h.pluginRegistry
		},
		MessageSvc: h.messageSvc,
		Limiter:    h.limiter,
	})
	registerVoiceControlsV2(reg, VoiceDeps{
		DB:          h.db,
		Limiter:     h.limiter,
		Permissions: h.permChecker,
		PermSvc:     h.perms,
		LiveKit:     h.livekit,
		TokenGen:    h, // Hub delegates to h.livekit at call time
		KeyHolder:   h,
		Mod:         h,
	})

	h.refreshSettingsLocked(context.Background())
	return h, nil
}

// getCachedSettings returns server_name and motd, refreshing the cache if stale.
func (h *Hub) getCachedSettings(ctx context.Context) (string, string) {
	h.settingsMu.RLock()
	if time.Since(h.settingsLastUpdate) < settingsCacheTTL {
		name, motd := h.settingsName, h.settingsMotd
		h.settingsMu.RUnlock()
		return name, motd
	}
	h.settingsMu.RUnlock()

	h.settingsMu.Lock()
	defer h.settingsMu.Unlock()
	// Double-check after acquiring write lock.
	if time.Since(h.settingsLastUpdate) < settingsCacheTTL {
		return h.settingsName, h.settingsMotd
	}
	h.refreshSettingsLocked(ctx)
	return h.settingsName, h.settingsMotd
}

// refreshSettingsLocked reloads server_name and motd from the DB.
// Caller must hold settingsMu (write lock) or call during init.
func (h *Hub) refreshSettingsLocked(ctx context.Context) {
	if h.db == nil {
		return
	}
	// The refresh serves the hub-wide settings cache, not the connection that
	// happened to trigger it — a dying connection's ctx must not fail the
	// fetches (the TTL stamp below would then pin stale values for 30s).
	ctx = context.WithoutCancel(ctx)
	if name, err := h.db.GetSetting(ctx, "server_name"); err == nil {
		h.settingsName = name
	}
	if motd, err := h.db.GetSetting(ctx, "motd"); err == nil {
		h.settingsMotd = motd
	}
	h.settingsLastUpdate = time.Now()
}

// Run starts the hub's dispatch loop. It blocks until Stop is called.
// Must be called in its own goroutine.
//
// A panic recovery wrapper restarts the select loop automatically. If the hub
// panics more than 3 times within a 60-second window it stops permanently to
// avoid a tight crash loop.
func (h *Hub) Run() {
	h.running.Store(true)
	defer h.dispatchExited.Store(true)
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

					if panicCount >= 3 {
						// The hub's state after three panics in a minute is
						// unknown, and a stopped dispatch loop is invisible from
						// the outside: registerNow keeps admitting clients that
						// can never receive a broadcast. Exit and let the
						// process supervisor restart us (fatalFn is os.Exit(1)
						// in production; tests substitute a no-op and rely on
						// the Stop below).
						slog.Error("hub: too many panics in 60s, stopping and exiting for supervisor restart")
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
					if ev.add {
						// No handshake permission set on this path (and no DB
						// call allowed on the hub goroutine) — nil denies the
						// inherited voice-channel subscription.
						h.registerNow(ev.c, nil)
					} else {
						h.unregisterNow(ev.c)
					}
				case bm := <-h.broadcast:
					h.deliverBroadcast(bm)
				case <-staleTicker.C:
					h.onStaleTick()
				case <-sessionSweepTicker.C:
					// The revoked-session and stale-voice sweeps do per-client
					// DB work, so they run off the dispatch goroutine — a slow
					// sweep must not stall broadcast delivery.
					h.startSweep(&h.sessionSweepInFlight, h.sweepRevokedSessions)
				case <-voiceSweepTicker.C:
					h.startSweep(&h.voiceSweepInFlight, h.sweepStaleVoiceStates)
				}
			}
		}()

		// If we reach here without a panic recovery continuing, stop.
		if panicCount >= 3 {
			return
		}
		// If stop was signaled, exit.
		select {
		case <-h.stop:
			return
		default:
		}
	}
}

// Stop signals Run to exit. Safe to call multiple times.
func (h *Hub) Stop() {
	h.stopOnce.Do(func() { close(h.stop) })
}

// GracefulStop stops the LiveKit process (if managed) and then stops the hub.
// Safe to call multiple times concurrently. Prefer GracefulStopContext where a
// shutdown budget exists — this variant waits the full client-notice window.
func (h *Hub) GracefulStop() {
	h.GracefulStopContext(context.Background())
}

// GracefulStopContext is GracefulStop bounded by ctx: the client-notice wait
// ends early when ctx expires, so the hub's drain counts against the caller's
// shutdown budget instead of extending it. Safe to call multiple times
// concurrently (only the first call's ctx is used).
func (h *Hub) GracefulStopContext(ctx context.Context) {
	h.gracefulOnce.Do(func() {
		// The notice window matters only when someone is connected to hear
		// it — an idle server (and every early-return startup path) skips
		// straight to teardown.
		hasClients := h.ClientCount() > 0
		if hasClients {
			// Broadcast restart notice to all connected clients.
			h.BroadcastServerRestart("shutdown", 5)
		}

		// Stop LiveKit process.
		if h.lkProcess != nil {
			h.lkProcess.Stop()
		}

		// Give clients the promised notice window to disconnect gracefully —
		// the 5s matches the countdown BroadcastServerRestart told them.
		if hasClients {
			select {
			case <-time.After(5 * time.Second):
			case <-ctx.Done():
			}
		}

		// Close all remaining client connections.
		h.mu.Lock()
		for _, c := range h.clients {
			c.closeSend()
		}
		h.mu.Unlock()

		// Stop the hub dispatch loop.
		h.stopOnce.Do(func() { close(h.stop) })
	})
}

// IsUserConnected returns true if a client with the given userID is already
// registered in the hub. Safe to call from any goroutine.
func (h *Hub) IsUserConnected(userID int64) bool {
	h.mu.RLock()
	_, ok := h.clients[userID]
	h.mu.RUnlock()
	return ok
}

// GetClient returns the client for userID, or nil if not connected.
// Safe to call from any goroutine.
func (h *Hub) GetClient(userID int64) *Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.clients[userID]
}

// clientEvent is a register (add=true) or unregister (add=false) request.
// Both kinds share one channel so per-connection ordering is preserved.
type clientEvent struct {
	c   *Client
	add bool
}

// ClientCount returns the number of currently registered clients (test helper).
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// BroadcastDropCount returns the cumulative number of messages dropped due to a
// full broadcast channel. Safe to call from any goroutine.
func (h *Hub) BroadcastDropCount() uint64 {
	return h.broadcastDrops.Load()
}

// DispatchAlive reports whether the hub's dispatch loop is still running.
// It is true before Run starts (so a health probe racing startup does not
// flap) and false once Run has returned — normal shutdown or the panic
// breaker. Safe to call from any goroutine.
func (h *Hub) DispatchAlive() bool {
	return !h.dispatchExited.Load()
}

// BackpressureStats returns the process-lifetime per-client backpressure
// counters: connections closed due to send-buffer overflow, high-priority
// sends that fell back to the normal buffer, and low-priority messages
// silently dropped. Safe to call from any goroutine.
func (h *Hub) BackpressureStats() (queueDisconnects, highFallbacks, lowDrops uint64) {
	return h.bpQueueDisconnects.Load(), h.bpHighFallbacks.Load(), h.bpLowDrops.Load()
}

// ConnRejectCount returns how many WebSocket upgrade requests were refused by
// the max_ws_connections capacity guardrail. Safe to call from any goroutine.
func (h *Hub) ConnRejectCount() uint64 {
	return h.connRejects.Load()
}

// maxColdReplayLimit returns the effective persisted-replay cap. The budget
// arrives via HubOptions (B3-4): the dispatch loop reads replayBuf unlocked,
// so the ring is sized exactly once, at construction.
func (h *Hub) maxColdReplayLimit() int {
	if h.coldReplayLimit > 0 {
		return h.coldReplayLimit
	}
	return maxColdReplay
}

// EventPersisterStats returns the attached persister's lifetime counters.
// ok is false when event persistence is disabled (no persister attached).
func (h *Hub) EventPersisterStats() (persisted, dropped, flushes, errs uint64, ok bool) {
	p := h.eventPersister.Load()
	if p == nil {
		return 0, 0, 0, 0, false
	}
	persisted, dropped, flushes, errs = p.Stats()
	return persisted, dropped, flushes, errs, true
}

// topicRateLimitPerSecond is the default maximum messages per second for any
// single channel topic. Prevents a busy channel from saturating the broadcast
// loop and starving other channels.
const topicRateLimitPerSecond = 100
