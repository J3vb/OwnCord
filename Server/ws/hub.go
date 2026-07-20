// Package ws provides the WebSocket hub and client management for OwnCord.
package ws

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/plugin"
	"github.com/owncord/server/service"
	"github.com/owncord/server/syncutil"
)

// broadcastMsg is an internal message queued for delivery.
type broadcastMsg struct {
	channelID int64 // 0 = send to all connected clients
	msg       []byte
}

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
	registerVoiceHandlersV1(reg)

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
	if svc != nil {
		chatDeps.MessageSvc = svc.Messages
		presenceDeps.ChannelSvc = svc.Channels
		reactionDeps.MessageSvc = svc.Messages
		h.messageSvc = svc.Messages
	}

	registerChatHandlers(reg, chatDeps)
	registerPresenceHandlers(reg, presenceDeps)
	registerReactionHandlers(reg, reactionDeps)
	registerPluginCommandHandler(reg) // Phase C Step 9 — plugin slash commands
	registerVoiceControlsV2(reg, VoiceDeps{
		DB:          h.db,
		Limiter:     h.limiter,
		Permissions: h.permChecker,
		LiveKit:     h.livekit,
		TokenGen:    h, // Hub delegates to h.livekit at call time (set via SetLiveKit)
		KeyHolder:   h,
	})

	h.refreshSettingsLocked()
	return h
}

// getCachedSettings returns server_name and motd, refreshing the cache if stale.
func (h *Hub) getCachedSettings() (string, string) {
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
	h.refreshSettingsLocked()
	return h.settingsName, h.settingsMotd
}

// refreshSettingsLocked reloads server_name and motd from the DB.
// Caller must hold settingsMu (write lock) or call during init.
func (h *Hub) refreshSettingsLocked() {
	if h.db == nil {
		return
	}
	if name, err := h.db.GetSetting("server_name"); err == nil {
		h.settingsName = name
	}
	if motd, err := h.db.GetSetting("motd"); err == nil {
		h.settingsMotd = motd
	}
	h.settingsLastUpdate = time.Now()
}

// SetLiveKit sets the LiveKit client on the hub. Must be called before Run;
// late calls are ignored with an error log.
func (h *Hub) SetLiveKit(lk *LiveKitClient) {
	if h.rejectIfRunning("SetLiveKit") {
		return
	}
	h.livekit = lk
}

// GenerateToken delegates to the LiveKit client. Returns an error if LiveKit
// is not configured. Satisfies VoiceTokenGenerator so the Hub can be passed
// as a dep at registration time (before SetLiveKit is called).
func (h *Hub) GenerateToken(userID int64, username string, channelID int64, voiceJoinToken string, canPublish, canSubscribe, canVideo, canScreenShare bool) (string, error) {
	if h.livekit == nil {
		return "", fmt.Errorf("voice not configured")
	}
	return h.livekit.GenerateToken(userID, username, channelID, voiceJoinToken, canPublish, canSubscribe, canVideo, canScreenShare)
}

// URL delegates to the LiveKit client. Returns empty string if not configured.
func (h *Hub) URL() string {
	if h.livekit == nil {
		return ""
	}
	return h.livekit.URL()
}

// LiveKitHealthCheck probes the LiveKit server for connectivity.
// It tries the SDK client first (ListRooms), and falls back to an HTTP probe
// if a managed process is configured. Returns false with a reason if LiveKit
// is not configured or unreachable.
func (h *Hub) LiveKitHealthCheck(ctx context.Context) (bool, error) {
	if h.livekit == nil {
		return false, fmt.Errorf("not configured")
	}
	return h.livekit.HealthCheck(ctx)
}

// SetLiveKitProcess sets the LiveKit process manager on the hub. Must be
// called before Run; late calls are ignored with an error log.
func (h *Hub) SetLiveKitProcess(p *LiveKitProcess) {
	if h.rejectIfRunning("SetLiveKitProcess") {
		return
	}
	h.lkProcess = p
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

					buf := make([]byte, 4096)
					n := runtime.Stack(buf, false)
					slog.Error("hub: panic recovered",
						"panic", r,
						"panic_count", panicCount,
						"stack", string(buf[:n]))

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
						h.registerNow(ev.c)
					} else {
						h.unregisterNow(ev.c)
					}
				case bm := <-h.broadcast:
					h.deliverBroadcast(bm)
				case <-staleTicker.C:
					h.sweepStaleClients()
				case <-sessionSweepTicker.C:
					h.sweepRevokedSessions()
				case <-voiceSweepTicker.C:
					h.sweepStaleVoiceStates()
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

// CleanupVoiceForChannel removes all voice participants from the given channel.
// Called when a channel is deleted.
func (h *Hub) CleanupVoiceForChannel(channelID int64) {
	// Get all users in the channel's voice state from DB.
	states, err := h.db.GetChannelVoiceStates(channelID)
	if err != nil {
		slog.Error("CleanupVoiceForChannel GetChannelVoiceStates", "err", err, "channel_id", channelID)
		return
	}
	if len(states) == 0 {
		return
	}

	// Clean up DB state and LiveKit for each participant.
	for _, vs := range states {
		if err := h.db.LeaveVoiceChannel(vs.UserID); err != nil {
			slog.Error("CleanupVoiceForChannel LeaveVoiceChannel", "err", err, "user_id", vs.UserID, "channel_id", channelID)
		}

		// Clear client voice state.
		h.mu.RLock()
		if client, ok := h.clients[vs.UserID]; ok {
			client.clearVoiceChID()
		}
		h.mu.RUnlock()

		// Remove from LiveKit (best-effort).
		if h.livekit != nil {
			_ = h.livekit.RemoveParticipant(channelID, vs.UserID, vs.JoinedAt)
		}
	}

	// Broadcast voice_leave for each participant.
	for _, vs := range states {
		h.BroadcastToAll(buildVoiceLeave(channelID, vs.UserID))
	}
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

func (h *Hub) registerNow(c *Client) {
	h.mu.Lock()
	if old, exists := h.clients[c.userID]; exists {
		oldVoiceChID, oldVoiceJoinToken := old.clearVoiceState()
		if c.lastSeq > 0 {
			// Network reconnect — preserve voice state so the user stays
			// in voice during brief WS drops.
			if c.getVoiceChID() == 0 {
				c.setVoiceState(oldVoiceChID, oldVoiceJoinToken)
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

	// Subscribe the new client to default pub/sub topics.
	h.pubsub.Subscribe(c, TopicGlobal)
	h.pubsub.Subscribe(c, UserTopic(c.userID))
	// If the client already has a focused channel (e.g. test clients created with
	// NewTestClientWithChannel, or reconnecting clients), subscribe immediately so
	// deliverBroadcast can reach them without waiting for a channel_focus message.
	if chID := c.getChannelID(); chID != 0 {
		h.pubsub.Subscribe(c, ChannelTopic(chID))
	}
	// If the client is already in a voice channel (e.g. reconnect or test setup),
	// subscribe to that channel's topic so voice-scoped and channel-scoped
	// broadcasts reach them.
	if voiceChID := c.getVoiceChID(); voiceChID != 0 {
		h.pubsub.Subscribe(c, ChannelTopic(voiceChID))
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
	return true // different client registered = was replaced
}

// BroadcastToChannel enqueues msg for delivery to all clients subscribed to
// channelID. When channelID is 0 the message is sent to every connected client.
// Non-blocking: if the broadcast channel is full the message is dropped with a warning.
func (h *Hub) BroadcastToChannel(channelID int64, msg []byte) {
	select {
	case h.broadcast <- broadcastMsg{channelID: channelID, msg: msg}:
	default:
		h.broadcastDrops.Add(1)
		slog.Warn("hub: broadcast channel full, dropping message",
			"channel_id", channelID, "msg_len", len(msg))
	}
}

// BroadcastToAll enqueues msg for delivery to every connected client.
// Non-blocking: if the broadcast channel is full the message is dropped with a warning.
func (h *Hub) BroadcastToAll(msg []byte) {
	select {
	case h.broadcast <- broadcastMsg{channelID: 0, msg: msg}:
	default:
		h.broadcastDrops.Add(1)
		slog.Warn("hub: broadcast channel full, dropping global message",
			"msg_len", len(msg))
	}
}

// BroadcastServerRestart sends a server_restart message to all connected clients.
// reason describes why the server is restarting (e.g., "update").
// delaySeconds tells clients how long until the server actually shuts down.
func (h *Hub) BroadcastServerRestart(reason string, delaySeconds int) {
	h.BroadcastToAll(buildServerRestartMsg(reason, delaySeconds))
}

// BroadcastChannelCreate sends a channel_create message to all connected clients.
func (h *Hub) BroadcastChannelCreate(ch *db.Channel) {
	h.BroadcastToAll(buildChannelCreate(ch))
}

// BroadcastChannelUpdate sends a channel_update message to all connected clients.
func (h *Hub) BroadcastChannelUpdate(ch *db.Channel) {
	h.BroadcastToAll(buildChannelUpdate(ch))
}

// BroadcastChannelDelete sends a channel_delete message to all connected clients.
func (h *Hub) BroadcastChannelDelete(channelID int64) {
	h.BroadcastToAll(buildChannelDelete(channelID))
}

// RefreshChannelVisibility re-evaluates which connected clients may see ch
// after a channel_overrides change and sends targeted channel_create /
// channel_delete messages so sidebars converge without a reconnect. Clients
// that lose visibility are also unsubscribed from the channel topic and have
// their focused channel cleared so live messages stop flowing.
//
// The sends deliberately bypass the sequenced broadcast/replay path: a
// replayed channel_delete would be filtered by the allowed-channel set
// computed at replay time, which after an override change is exactly the
// inverse of the intended audience. Clients tolerate seq-less messages.
func (h *Hub) RefreshChannelVisibility(ch *db.Channel) {
	if ch == nil {
		return
	}

	h.mu.RLock()
	clients := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	// Visibility is a function of the role, so resolve each role once.
	visibleByRole := make(map[int64]bool)
	roleVisible := func(roleID int64) bool {
		if v, ok := visibleByRole[roleID]; ok {
			return v
		}
		visible := false
		role, err := h.db.GetRoleByID(roleID)
		if err == nil && role != nil {
			// Single visibility predicate shared with buildReady / REST
			// ListVisibleChannels; the checker fails closed on a lookup error
			// and bypasses for admins, matching the other sites exactly.
			visible = h.permChecker.HasChannelPerm(role.Permissions, roleID, ch.ID, permissions.ReadMessages)
		}
		visibleByRole[roleID] = visible
		return visible
	}

	for _, c := range clients {
		if c.user == nil {
			continue
		}
		// c.user is a connect-time snapshot; an admin may have changed the
		// user's role mid-session, so resolve the current role from the DB.
		// Fail closed: on error send nothing rather than mis-target.
		fresh, err := h.db.GetUserByID(c.user.ID)
		if err != nil || fresh == nil {
			slog.Warn("hub: RefreshChannelVisibility could not resolve user role",
				"user_id", c.user.ID, "err", err)
			continue
		}
		if roleVisible(fresh.RoleID) {
			// Idempotent add on the client; also refreshes channel metadata.
			c.sendMsg(buildChannelCreate(ch))
			continue
		}
		c.sendMsg(buildChannelDelete(ch.ID))
		h.pubsub.Unsubscribe(c, ChannelTopic(ch.ID))
		c.mu.Lock()
		if c.channelID == ch.ID {
			c.channelID = 0
		}
		c.mu.Unlock()
	}

	// Clients not connected right now missed the targeted sends above. Move
	// the watermark so any resume from a seq at or before this point is
	// forced onto the full-ready path instead of replay (stored after the
	// sends so a concurrent seq advance errs toward re-syncing more clients).
	h.visibilityChangeSeq.Store(atomic.LoadUint64(&h.seq))
}

// mustFullResync reports whether a client resuming from lastSeq predates the
// most recent channel-visibility change and therefore cannot converge via
// replay.
func (h *Hub) mustFullResync(lastSeq uint64) bool {
	w := h.visibilityChangeSeq.Load()
	return w > 0 && lastSeq <= w
}

// BroadcastMemberBan sends a member_ban message to all connected clients
// and immediately disconnects the banned user's WebSocket connection (BUG-113).
func (h *Hub) BroadcastMemberBan(userID int64) {
	h.BroadcastToAll(buildMemberBan(userID))
	h.DisconnectUser(userID)
}

// DisconnectUser forcibly disconnects the client identified by userID.
// No-op if the user is not currently connected.
func (h *Hub) DisconnectUser(userID int64) {
	h.mu.RLock()
	c, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	slog.Info("hub: disconnecting user", "user_id", userID)
	c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
	h.kickClient(c)
}

// BroadcastUserUpdate sends a user_update message to all connected clients
// when a user changes their profile (username, avatar).
func (h *Hub) BroadcastUserUpdate(userID int64, username string, avatar *string) {
	h.BroadcastToAll(buildUserUpdate(userID, username, avatar))
}

// BroadcastMemberUpdate sends a member_update message to all connected clients.
func (h *Hub) BroadcastMemberUpdate(userID int64, roleName string) {
	h.BroadcastToAll(buildMemberUpdate(userID, roleName))
}

// SendToUser delivers msg directly to the client identified by userID.
// Returns true if the client was found and the message was queued.
func (h *Hub) SendToUser(userID int64, msg []byte) bool {
	h.mu.RLock()
	c, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok {
		return false
	}
	return c.trySendMsg(msg)
}

// SendToUserHigh sends a high-priority message to a specific user.
func (h *Hub) SendToUserHigh(userID int64, msg []byte) bool {
	h.mu.RLock()
	c, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok {
		return false
	}
	c.sendHighMsg(msg)
	return true
}

// BroadcastToAllLow enqueues a low-priority global broadcast.
// Low-priority messages are silently dropped if a client's buffer is full.
func (h *Hub) BroadcastToAllLow(msg []byte) {
	// Low-priority global broadcasts bypass the sequenced broadcast channel
	// and go directly through pub/sub — they don't need replay or seq numbering.
	h.pubsub.PublishGlobalLow(msg)
}

// sendSequencedToUsersHigh stamps msg with a monotonic seq, stores it in the
// replay buffer under channelID, and fans the wrapped payload out to the
// provided users with high-priority delivery.
func (h *Hub) sendSequencedToUsersHigh(channelID int64, userIDs []int64, msg []byte) {
	h.seqMu.Lock()
	defer h.seqMu.Unlock()

	seq := h.nextSeq()
	wrapped := wrapWithSeq(msg, seq)
	h.replayBuf.Push(seq, channelID, wrapped)
	h.persistEvent(seq, channelID, wrapped)

	for _, userID := range userIDs {
		h.SendToUserHigh(userID, wrapped)
	}
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

// kickClient forcibly removes a client from the hub and closes its send channel,
// which causes writePump to exit and the WebSocket connection to close.
// It is safe to call from any goroutine.
func (h *Hub) kickClient(c *Client) {
	h.mu.Lock()
	if current, ok := h.clients[c.userID]; ok && current == c {
		delete(h.clients, c.userID)
	}
	h.mu.Unlock()
	h.pubsub.UnsubscribeAll(c)
	c.closeSend()
}

// nextSeq returns the next monotonic sequence number for broadcast messages.
func (h *Hub) nextSeq() uint64 {
	return atomic.AddUint64(&h.seq, 1)
}

// ReplayBuffer returns the hub's event ring buffer for reconnection replay.
func (h *Hub) ReplayBuffer() *EventRingBuffer {
	return h.replayBuf
}

// SeedSeq sets the hub's monotonic sequence counter to seed (atomic). Used
// at startup to align in-memory seqs with the persisted MAX(events.seq) so
// wrapped-payload seqs stay monotonic across restarts. Calling SeedSeq with
// a value less than the current seq is a no-op (we never go backwards).
func (h *Hub) SeedSeq(seed uint64) {
	for {
		cur := atomic.LoadUint64(&h.seq)
		if seed <= cur {
			return
		}
		if atomic.CompareAndSwapUint64(&h.seq, cur, seed) {
			return
		}
	}
}

// SetEventPersister attaches a persister so subsequent broadcasts are also
// written to the persistent EventStore. Pass nil to disable. Safe to call
// at any time, including after Run has started.
func (h *Hub) SetEventPersister(p *EventPersister) {
	h.eventPersister.Store(p)
}

// SetEventStore attaches a read-side EventStore used by the cold-tier
// reconnect replay path. Typically the same store backing SetEventPersister.
// Pass nil to disable. Safe to call at any time, including after Run has
// started.
func (h *Hub) SetEventStore(s EventStore) {
	if s == nil {
		h.eventStore.Store(nil)
		return
	}
	h.eventStore.Store(&s)
}

// SetPluginRegistry wires the plugin.Registry so the hub can dispatch
// slash commands (chat_command messages) to plugin-owned handlers.
// Pass nil to disable plugin command dispatch. Must be called before Run;
// late calls are ignored with an error log.
func (h *Hub) SetPluginRegistry(r *plugin.Registry) {
	if h.rejectIfRunning("SetPluginRegistry") {
		return
	}
	h.pluginRegistry = r
}

// SetPluginEventSink wires the plugin.EventSink so the hub fans out each
// sequenced broadcast to subscribed plugins. Pass nil to disable. Safe to
// call at any time, including after Run has started.
func (h *Hub) SetPluginEventSink(s *plugin.EventSink) {
	h.pluginSink.Store(s)
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

// ReconnectTierStats returns the per-tier resume hit counters in the order
// (buffer, db, full). Phase B Step 7 metrics surface; OpenTelemetry meters
// (Step 8) read from the same atomics.
func (h *Hub) ReconnectTierStats() (buffer, db, full uint64) {
	return h.reconnectTierBuf.Load(), h.reconnectTierDB.Load(), h.reconnectTierFull.Load()
}

// persistEvent enqueues a broadcast event for cold-storage persistence. Safe
// to call with a nil persister; never blocks the broadcast hot path. seq is
// the same hub-assigned monotonic counter embedded in payload, so the row
// written to the EventStore has a row-seq that matches the wrapped-payload
// seq the client tracks.
func (h *Hub) persistEvent(seq uint64, channelID int64, payload []byte) {
	p := h.eventPersister.Load()
	if p == nil {
		return
	}
	eventType := extractEventType(payload)
	if eventType == "" {
		eventType = "broadcast"
		if channelID != 0 {
			eventType = "channel_broadcast"
		}
	}
	p.Enqueue(int64(seq), eventType, channelID, payload) //nolint:gosec // seq is a monotonically increasing counter, never reaches MaxInt64
}

// extractEventType scans a wrapped JSON envelope for the value of the "type"
// field and returns it. Returns "" on any parse failure so the caller can
// substitute a generic label. The scan is intentionally not a full JSON
// decode — it only looks for the literal `"type":"<value>"` token, which
// matches every wire-format envelope produced by this server. This avoids the
// allocation cost of `encoding/json` on the broadcast hot path.
func extractEventType(payload []byte) string {
	const needle = `"type":"`
	idx := bytes.Index(payload, []byte(needle))
	if idx < 0 {
		return ""
	}
	start := idx + len(needle)
	end := bytes.IndexByte(payload[start:], '"')
	if end < 0 {
		return ""
	}
	t := payload[start : start+end]
	// Reject any value with control chars or escapes — we want a clean
	// label, not arbitrary user-controlled metadata. Length-cap defensively.
	if len(t) == 0 || len(t) > 64 {
		return ""
	}
	for _, b := range t {
		if b < 0x20 || b == '\\' {
			return ""
		}
	}
	return string(t)
}

// wrapWithSeq injects a "seq" field into a JSON message without re-serializing.
func wrapWithSeq(msg []byte, seq uint64) []byte {
	// Fast path: inject seq after the opening brace.
	// e.g., {"type":"chat_message",...} → {"seq":123,"type":"chat_message",...}
	// Guard: msg must be a non-empty JSON object (starts with '{' and has content).
	if len(msg) < 2 || msg[0] != '{' {
		return msg
	}
	prefix := fmt.Sprintf(`{"seq":%d,`, seq)
	result := make([]byte, 0, len(prefix)+len(msg)-1)
	result = append(result, prefix...)
	result = append(result, msg[1:]...) // skip opening brace
	return result
}

// staleClientTimeout is the maximum duration a client can go without sending
// any message before being considered stale and disconnected. The client sends
// a ping every 30s, so 90s (3x) gives plenty of margin.
const staleClientTimeout = 90 * time.Second

// topicRateLimitPerSecond is the default maximum messages per second for any
// single channel topic. Prevents a busy channel from saturating the broadcast
// loop and starving other channels.
const topicRateLimitPerSecond = 100

// sweepStaleClients iterates over all connected clients and kicks any that
// have not sent a message within staleClientTimeout.
func (h *Hub) sweepStaleClients() {
	now := time.Now()
	h.mu.RLock()
	var stale []*Client
	for _, c := range h.clients {
		if now.Sub(c.getLastActivity()) > staleClientTimeout {
			stale = append(stale, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range stale {
		slog.Warn("hub: closing stale connection (no activity)",
			"user_id", c.userID, "last_activity", c.getLastActivity())
		h.kickClient(c)
	}
}

// sweepRevokedSessions iterates all connected clients and kicks any whose
// session has been deleted, expired, or whose user has been banned. This
// provides time-based session enforcement for idle WebSocket connections
// that never trigger the message-count-based check (BUG-109).
func (h *Hub) sweepRevokedSessions() {
	if h.db == nil {
		return
	}

	h.mu.RLock()
	snapshot := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		if c.tokenHash != "" {
			snapshot = append(snapshot, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range snapshot {
		result, err := h.db.GetSessionWithBanStatus(c.tokenHash)
		if err != nil || result == nil || auth.IsSessionExpired(result.ExpiresAt) {
			slog.Info("session sweep: revoked/expired session, disconnecting",
				"user_id", c.userID)
			h.kickClient(c)
			continue
		}
		tempUser := &db.User{Banned: result.Banned, BanExpires: result.BanExpires}
		if auth.IsEffectivelyBanned(tempUser) {
			slog.Info("session sweep: banned user, disconnecting",
				"user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
			h.kickClient(c)
		}
	}
}

// sweepStaleVoiceStates queries all voice_states rows and removes any that
// don't match a connected client's voiceChID. This catches ghost users that
// slip through the primary cleanup paths (registerNow, readPump defer,
// LiveKit webhook).
func (h *Hub) sweepStaleVoiceStates() {
	if h.db == nil {
		return
	}
	allStates, err := h.db.GetAllVoiceStates()
	if err != nil {
		slog.Warn("sweepStaleVoiceStates: GetAllVoiceStates failed", "err", err)
		return
	}
	if len(allStates) == 0 {
		return
	}

	h.mu.RLock()
	var stale []struct {
		userID    int64
		channelID int64
		joinedAt  string
	}
	for _, vs := range allStates {
		c, ok := h.clients[vs.UserID]
		if !ok || c.getVoiceChID() != vs.ChannelID {
			stale = append(stale, struct {
				userID    int64
				channelID int64
				joinedAt  string
			}{vs.UserID, vs.ChannelID, vs.JoinedAt})
		}
	}
	h.mu.RUnlock()

	for _, s := range stale {
		// Channel-conditional delete: only removes the row if it still points
		// at the channel we snapshotted. If the user rejoined or moved between
		// the snapshot and now, the delete is a no-op and we skip the broadcast.
		deleted, err := h.db.LeaveVoiceChannelIfMatch(s.userID, s.channelID, s.joinedAt)
		if err != nil {
			slog.Error("sweepStaleVoiceStates: LeaveVoiceChannelIfMatch failed",
				"err", err, "user_id", s.userID, "channel_id", s.channelID)
			continue
		}
		if !deleted {
			continue
		}
		slog.Warn("sweepStaleVoiceStates: removed ghost voice state",
			"user_id", s.userID, "channel_id", s.channelID)
		h.BroadcastToAll(buildVoiceLeave(s.channelID, s.userID))
		if h.livekit != nil {
			_ = h.livekit.RemoveParticipant(s.channelID, s.userID, s.joinedAt)
		}
	}
}

// deliverBroadcast stamps bm.msg with a monotonic sequence number, stores it
// in the replay buffer, and sends it to the appropriate clients via pub/sub.
func (h *Hub) deliverBroadcast(bm broadcastMsg) {
	h.seqMu.Lock()
	defer h.seqMu.Unlock()

	seq := h.nextSeq()
	msg := wrapWithSeq(bm.msg, seq)

	// Store in replay buffer for reconnection recovery.
	h.replayBuf.Push(seq, bm.channelID, msg)
	h.persistEvent(seq, bm.channelID, msg)

	// Fan out to plugins subscribed to this event type (Phase C Step 9).
	// Dispatch is a no-op in the default build; the wazero build calls into
	// the WASM module. Dispatch is called outside seqMu after we release it
	// conceptually — but since seqMu is still held here, the call MUST NOT
	// re-enter the hub. The default build is safe; the wazero build should
	// dispatch asynchronously once the runtime is real.
	if sink := h.pluginSink.Load(); sink != nil {
		eventType := extractEventType(msg)
		if eventType == "" {
			eventType = "broadcast"
		}
		sink.Dispatch(context.Background(), eventType, msg)
	}

	if bm.channelID == 0 {
		// Global broadcast — deliver to every connected client.
		h.pubsub.PublishGlobal(msg)
	} else {
		// Channel-scoped broadcast — deliver to subscribers of the channel topic.
		topic := ChannelTopic(bm.channelID)
		if !h.topicLimiter.Allow(topic) {
			slog.Warn("hub: topic rate limit exceeded, dropping message",
				"channel_id", bm.channelID, "seq", seq)
			return
		}
		delivered := h.pubsub.Publish(topic, msg, 0)
		slog.Debug("hub: channel broadcast",
			"channel_id", bm.channelID, "delivered", delivered, "seq", seq)
	}
}
