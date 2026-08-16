// Package ws provides the WebSocket hub and client management for OwnCord.
package ws

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/plugin"
	"github.com/owncord/server/service"
	"github.com/owncord/server/stackutil"
	"github.com/owncord/server/syncutil"
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
	// because main.go wires these after NewRouter has already started the
	// Run loop, which reads them on the broadcast/replay paths.
	eventPersister atomic.Pointer[EventPersister]
	eventStore     atomic.Pointer[EventStore] // read path for cold-tier replay

	// Phase C Step 9 — plugin wiring.
	pluginRegistry *plugin.Registry                 // slash-command dispatch; nil = no plugins; wire before Run
	pluginSink     atomic.Pointer[plugin.EventSink] // hub→plugin event fan-out; nil = no plugins

	// running flips when Run starts; plain-field setters check it so a late
	// call fails loudly instead of racing the dispatch loop.
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
	// compiled-in default (maxColdReplay). Set via ConfigureReplay before Run.
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

// NewHub creates a Hub ready to be started with Run.
// It also initializes the settings cache from the database.
// If svc is non-nil, V2 handlers receive service references for business logic delegation.
func NewHub(database *db.DB, limiter *auth.RateLimiter, svc *service.Services) *Hub {
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
		replayBuf:       NewEventRingBuffer(1000),
		registry:        reg,
		permChecker:     permissions.NewChecker(database),
		settingsName:    "OwnCord Server",
		settingsMotd:    "Welcome!",
		voiceKeyHolders: make(map[int64]int64),
		fatalFn:         func() { os.Exit(1) },
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
	}

	registerChatHandlers(reg, chatDeps)
	registerPresenceHandlers(reg, presenceDeps)
	registerReactionHandlers(reg, reactionDeps)
	registerCallHandlers(reg, callDeps)
	// Phase C Step 9 — plugin slash commands. Registry is read live because
	// SetPluginRegistry wires it after NewHub; MessageSvc gates broadcasts.
	reg.RegisterV2(MsgTypeChatCommand, handleChatCommandV2, PluginDeps{
		Registry:   func() *plugin.Registry { return h.pluginRegistry },
		MessageSvc: h.messageSvc,
		Limiter:    h.limiter,
	})
	registerVoiceControlsV2(reg, VoiceDeps{
		DB:          h.db,
		Limiter:     h.limiter,
		Permissions: h.permChecker,
		PermSvc:     h.perms,
		LiveKit:     h.livekit,
		TokenGen:    h, // Hub delegates to h.livekit at call time (set via SetLiveKit)
		KeyHolder:   h,
		Mod:         h,
	})

	h.refreshSettingsLocked(context.Background())
	return h
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

// bumpVisibilityWatermark ratchets visibilityChangeSeq up to the current seq,
// never down. All three writers (RefreshChannelVisibility,
// revokeUnreadableChannels, DMChannelOpenEvent in emit.go) must go through
// this instead of a plain Store: a plain Store(Load(&h.seq)) lets a writer
// that read an older h.seq — e.g. one that spent time in a per-topic DB loop
// — finish and overwrite a concurrently stored higher watermark with its
// stale value, silently regressing the forced-full-resync boundary mustFullResync
// depends on being monotonic. Mirrors SeedSeq's CAS-max pattern.
func (h *Hub) bumpVisibilityWatermark() {
	for {
		cur := h.visibilityChangeSeq.Load()
		next := atomic.LoadUint64(&h.seq)
		if next <= cur {
			return
		}
		if h.visibilityChangeSeq.CompareAndSwap(cur, next) {
			return
		}
	}
}

// MarkVisibilityChanged bumps the visibility watermark. It is the exported
// entry point REST handlers (api.markDMVisibilityChanged, reached via a
// dmVisibilityMarker type assertion) use to force the same full-resync
// guarantee for an unsequenced, targeted DM event that the WS-side emitter of
// the same event (emit.go DMChannelOpenEvent) already gets via
// bumpVisibilityWatermark directly.
func (h *Hub) MarkVisibilityChanged() {
	h.bumpVisibilityWatermark()
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

// Register queues a client for registration with the hub.
func (h *Hub) Register(c *Client) {
	h.clientEvents <- clientEvent{c: c, add: true}
}

// Unregister queues a client for removal from the hub.
func (h *Hub) Unregister(c *Client) {
	h.clientEvents <- clientEvent{c: c}
}

// clientEvent is a register (add=true) or unregister (add=false) request.
// Both kinds share one channel so per-connection ordering is preserved.
type clientEvent struct {
	c   *Client
	add bool
}

// registerNow adds c to the hub and subscribes it to its topics.
//
// readableChannelIDs is the set of channels the user holds READ_MESSAGES on,
// as computed by the handshake (serve.go). It gates the inherited voice-channel
// subscription only; a nil set denies it (fail closed).
//
// Replacing an existing connection strips its subscriptions (UnsubscribeAll)
// and re-subscribes the new one (Subscribe) as two separate PubSub-lock
// acquisitions — back to back, but not atomic. A caller that must not lose a
// broadcast concurrently racing the replacement (i.e. one deliverBroadcast
// could deliver in the gap between those two acquisitions) has to call this
// while holding h.seqMu, the same lock deliverBroadcast holds for its entire
// critical section (seq allocation, replay-buffer push, and publish) — that
// serializes the two entirely, rather than merely narrowing the window. See
// serve.go's handleReconnect, which re-reads the replay tail and calls
// registerNow inside one h.seqMu section for exactly this reason.
func (h *Hub) registerNow(c *Client, readableChannelIDs map[int64]bool) {
	// Voice channel the replaced connection was in, if any. Re-elected below,
	// after the hub lock is released.
	var replacedVoiceChID int64

	h.mu.Lock()
	if old, exists := h.clients[c.userID]; exists {
		oldE2EEKey, oldE2EESig := old.getE2EEPubKey()
		oldVoiceChID, oldVoiceJoinToken := old.clearVoiceState()
		replacedVoiceChID = oldVoiceChID
		if c.lastSeq > 0 {
			// Network reconnect — preserve voice state so the user stays
			// in voice during brief WS drops.
			if c.getVoiceChID() == 0 {
				c.setVoiceState(oldVoiceChID, oldVoiceJoinToken)
				// The announced ECDH key must survive with the voice state:
				// the client keeps its keypair across a WS blip and only
				// re-announces on a LiveKit-room reconnect, so without the
				// transfer voice_join replays nothing for this user and new
				// joiners' key exchanges time out.
				c.setE2EEPubKey(oldE2EEKey, oldE2EESig)
			}
			// The focused channel must transfer too: the client never
			// re-sends channel_focus on a resume (mountChannel early-returns
			// on the same channel), so without it the ChannelTopic
			// re-subscribe below is a no-op and the message stream dies
			// silently. READ-gated like every ChannelTopic subscription;
			// a nil set denies (fail closed).
			if oldChID := old.getChannelID(); oldChID != 0 &&
				c.getChannelID() == 0 && readableChannelIDs[oldChID] {
				c.mu.Lock()
				c.channelID = oldChID
				c.mu.Unlock()
			}
		}
		// Fresh connections (lastSeq == 0): do NOT transfer voice state.
		// Stale voice cleanup (DB + broadcast + LiveKit) is owned entirely
		// by the handshake path in serve.go, which runs before registerNow.
		// registerNow only handles in-memory client replacement.

		// Kick the stale connection atomically before registering
		// the new one — prevents TOCTOU races on duplicate login.
		// closeSend MUST precede UnsubscribeAll: Subscribe refuses clients
		// whose send is closed, so this ordering leaves the old connection's
		// in-flight handlers no window to re-take a stripped topic.
		slog.Warn("hub: kicking stale connection for re-registering user",
			"user_id", c.userID, "last_seq", c.lastSeq)
		old.closeSend()

		// Remove the old client from all pub/sub topics before replacing.
		h.pubsub.UnsubscribeAll(old)
	}
	h.clients[c.userID] = c

	// Subscribe the new client to its default pub/sub topics immediately
	// after UnsubscribeAll(old) above, with nothing in between.
	//
	// This does NOT make strip+resubscribe atomic, and must not be read as
	// doing so: the two are separate ps.mu acquisitions, and PublishGlobal
	// takes ps.mu alone (never h.mu), so a deliverBroadcast landing between
	// them still finds no subscriber for this user. That frame is
	// unrecoverable — its seq was already allocated and pushed to the replay
	// buffer, the resuming client's replay snapshot was taken even earlier,
	// and the client tracks only max(seq), so the next frame silently
	// advances past the hole. Only a caller holding h.seqMu closes that
	// window; see this function's doc comment and serve.go's handleReconnect.
	//
	// What the ordering does buy is the smallest possible gap for the callers
	// that cannot hold seqMu — the fresh-connect path, whose buildReady
	// rebuilds state from the DB afterwards, and the clientEvents path, which
	// runs on the hub goroutine and so cannot race deliverBroadcast at all.
	// The registration log line (a syscall-backed slog call) and
	// updateKeyHolder (keyHolderMu plus a full h.clients scan under
	// h.mu.RLock) both used to sit in that gap; both now run after the
	// subscribes. Keeping the subscribes under h.mu is incidental but free:
	// pubsub uses its own independent lock and never calls back into the hub,
	// so h.mu → ps.mu adds no lock-ordering risk.
	h.pubsub.Subscribe(c, TopicGlobal)
	h.pubsub.Subscribe(c, UserTopic(c.userID))
	// If the client already has a focused channel (e.g. test clients created with
	// NewTestClientWithChannel, or reconnecting clients), subscribe immediately so
	// deliverBroadcast can reach them without waiting for a channel_focus message.
	if chID := c.getChannelID(); chID != 0 {
		h.pubsub.Subscribe(c, ChannelTopic(chID))
	}
	// If the client is already in a voice channel (e.g. reconnect), restore its
	// subscriptions without a new voice_join (a same-channel rejoin is rejected
	// with ALREADY_JOINED) or channel_focus.
	if voiceChID := c.getVoiceChID(); voiceChID != 0 {
		// VoiceTopic is the only transport for voice_e2ee_announce relays and
		// carries nothing else, for a channel the user already joined via the
		// CONNECT_VOICE-gated voice_join — so no READ gate.
		h.pubsub.Subscribe(c, VoiceTopic(voiceChID))
		// Voice membership is gated on CONNECT_VOICE alone, so it must not by
		// itself grant a channel's message stream: subscribe only when the
		// handshake confirmed READ_MESSAGES on that channel.
		if readableChannelIDs[voiceChID] {
			h.pubsub.Subscribe(c, ChannelTopic(voiceChID))
		}
	}
	total := len(h.clients)
	h.mu.Unlock()

	slog.Info("hub: client registered", "user_id", c.userID, "total_clients", total)

	// A fresh connect (lastSeq == 0) drops the replaced connection's voice state
	// without transferring it, so that channel just lost a participant and the
	// E2EE key holder may need to move. handleVoiceLeave never runs on this path
	// — readPump skips it when replaced, and it early-returns on already-cleared
	// state — so re-elect here. Must be outside h.mu: updateKeyHolder takes
	// keyHolderMu and then h.mu.RLock. The recompute reads live client voice
	// state, so it is idempotent and also correct when the state was transferred.
	// It runs after the subscribe block above; updateKeyHolder only reads
	// h.clients' voice state and writes voiceKeyHolders, so it has no
	// ordering dependency on pub/sub subscriptions.
	if replacedVoiceChID != 0 {
		h.updateKeyHolder(replacedVoiceChID)
	}
}

func (h *Hub) unregisterNow(c *Client) bool {
	h.mu.Lock()
	current, exists := h.clients[c.userID]
	if exists && current == c {
		delete(h.clients, c.userID)
		slog.Info("hub: client unregistered", "user_id", c.userID, "total_clients", len(h.clients))
		h.mu.Unlock()
		h.pubsub.UnsubscribeAll(c)
		return false // not replaced
	}
	h.mu.Unlock()
	// exists means a *different* client holds the slot — a genuine replacement,
	// whose teardown must not mark the live connection's user offline. An absent
	// entry means this client was already kicked (every kick path deletes it via
	// kickClient), which is a real disconnect and still needs the offline
	// presence broadcast and voice cleanup in readPump's defer.
	return exists
}

// shouldMarkOffline reports whether a disconnect teardown should run
// MarkUserDisconnected and broadcast an offline presence for c's user.
//
// `replaced` (unregisterNow's return, sampled once at the start of teardown)
// is necessary but not sufficient: both readPump's defer and
// unregisterFailedHandshake sample it BEFORE handleVoiceLeave, which can
// block for seconds (DB delete, audience scan, a LiveKit call bounded by
// lkTimeout=5s). A reconnect landing during that window registers a new
// client for the same user and is invisible to the stale boolean, so the
// dead connection's teardown would otherwise mark the live session offline
// (OC-0019). Re-checking h.clients at decision time closes that gap: any
// entry present once c has been removed is necessarily a newer connection —
// unregisterNow only ever deletes c's own slot, never someone else's.
func (h *Hub) shouldMarkOffline(c *Client, replaced bool) bool {
	return !replaced && h.GetClient(c.userID) == nil
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

// ConfigureReplay resizes the reconnect replay budget: the in-memory ring and
// the persisted-event cap per reconnect (event_persistence.replay_ring_size /
// replay_cold_limit). Zero or negative values keep the compiled-in defaults.
// Must be called before Run — the dispatch loop reads replayBuf unlocked.
func (h *Hub) ConfigureReplay(ringSize, coldLimit int) {
	if h.rejectIfRunning("ConfigureReplay") {
		return
	}
	if ringSize > 0 {
		h.replayBuf = NewEventRingBuffer(ringSize)
	}
	if coldLimit > 0 {
		h.coldReplayLimit = coldLimit
	}
}

// maxColdReplayLimit returns the effective persisted-replay cap.
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

// VoiceSessionCount returns the number of clients currently in a voice channel.
func (h *Hub) VoiceSessionCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	count := 0
	for _, c := range h.clients {
		if c.getVoiceChID() != 0 {
			count++
		}
	}
	return count
}

// rejectIfRunning reports whether Run has already started, logging an error
// when it has. Plain-field setters must be wired before Run: the dispatch
// loop and connection goroutines read those fields without synchronization,
// so a late set would be a data race. Late calls are dropped.
func (h *Hub) rejectIfRunning(setter string) bool {
	if h.running.Load() {
		slog.Error("ws: setter called after Hub.Run started; ignoring (must be wired before Run)",
			"setter", setter)
		return true
	}
	return false
}

// topicRateLimitPerSecond is the default maximum messages per second for any
// single channel topic. Prevents a busy channel from saturating the broadcast
// loop and starving other channels.
const topicRateLimitPerSecond = 100
