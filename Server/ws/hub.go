// Package ws provides the WebSocket hub and client management for OwnCord.
package ws

import (
	"context"
	"log/slog"
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
	keyHolderMu     sync.RWMutex
	voiceKeyHolders map[int64]int64
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
						slog.Error("hub: too many panics in 60s, stopping")
						h.Stop()
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
					h.sweepStaleClients()
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
// Safe to call multiple times concurrently.
func (h *Hub) GracefulStop() {
	h.gracefulOnce.Do(func() {
		// Broadcast restart notice to all connected clients.
		h.BroadcastServerRestart("shutdown", 5)

		// Stop LiveKit process.
		if h.lkProcess != nil {
			h.lkProcess.Stop()
		}

		// Give clients 5 seconds to disconnect gracefully.
		time.Sleep(5 * time.Second)

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
		}
		// Fresh connections (lastSeq == 0): do NOT transfer voice state.
		// Stale voice cleanup (DB + broadcast + LiveKit) is owned entirely
		// by the handshake path in serve.go, which runs before registerNow.
		// registerNow only handles in-memory client replacement.

		// Remove the old client from all pub/sub topics before replacing.
		h.pubsub.UnsubscribeAll(old)

		// Kick the stale connection atomically before registering
		// the new one — prevents TOCTOU races on duplicate login.
		slog.Warn("hub: kicking stale connection for re-registering user",
			"user_id", c.userID, "last_seq", c.lastSeq)
		old.closeSend()
	}
	h.clients[c.userID] = c
	slog.Info("hub: client registered", "user_id", c.userID, "total_clients", len(h.clients))
	h.mu.Unlock()

	// A fresh connect (lastSeq == 0) drops the replaced connection's voice state
	// without transferring it, so that channel just lost a participant and the
	// E2EE key holder may need to move. handleVoiceLeave never runs on this path
	// — readPump skips it when replaced, and it early-returns on already-cleared
	// state — so re-elect here. Must be outside h.mu: updateKeyHolder takes
	// keyHolderMu and then h.mu.RLock. The recompute reads live client voice
	// state, so it is idempotent and also correct when the state was transferred.
	if replacedVoiceChID != 0 {
		h.updateKeyHolder(replacedVoiceChID)
	}

	// Subscribe the new client to default pub/sub topics.
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
