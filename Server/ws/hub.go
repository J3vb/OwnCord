// Package ws provides the WebSocket hub and client management for OwnCord.
package ws

import (
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// broadcastMsg is an internal message queued for delivery.
type broadcastMsg struct {
	channelID int64 // 0 = send to all connected clients
	msg       []byte
}

// Hub manages all active WebSocket clients and routes messages between them.
// All exported methods are safe to call from multiple goroutines.
type Hub struct {
	clients      map[int64]*Client
	mu           sync.RWMutex
	db           *db.DB
	limiter      *auth.RateLimiter
	broadcast    chan broadcastMsg
	register     chan *Client
	unregister   chan *Client
	stop         chan struct{}
	stopOnce     sync.Once
	livekit      *LiveKitClient
	lkProcess    *LiveKitProcess
	registry     *HandlerRegistry
	permChecker  *permissions.Checker

	seq       uint64           // atomic monotonic sequence counter
	replayBuf *EventRingBuffer // recent broadcast events for reconnection replay

	// Settings cache — avoids per-connection DB queries for server_name/motd.
	settingsMu         sync.RWMutex
	settingsName       string
	settingsMotd       string
	settingsLastUpdate time.Time
}

// NewHub creates a Hub ready to be started with Run.
// It also initializes the settings cache from the database.
func NewHub(database *db.DB, limiter *auth.RateLimiter) *Hub {
	reg := NewHandlerRegistry()
	registerChatHandlers(reg)
	registerPresenceHandlers(reg)
	registerReactionHandlers(reg)
	registerVoiceHandlers(reg)
	registerPingHandler(reg)

	h := &Hub{
		clients:      make(map[int64]*Client),
		db:           database,
		limiter:      limiter,
		broadcast:    make(chan broadcastMsg, 256),
		register:     make(chan *Client, 32),
		unregister:   make(chan *Client, 32),
		stop:         make(chan struct{}),
		replayBuf:    NewEventRingBuffer(1000),
		registry:     reg,
		permChecker:  permissions.NewChecker(database),
		settingsName: "OwnCord Server",
		settingsMotd: "Welcome!",
	}
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
	var name, motd string
	if err := h.db.QueryRow("SELECT value FROM settings WHERE key='server_name'").Scan(&name); err == nil {
		h.settingsName = name
	}
	if err := h.db.QueryRow("SELECT value FROM settings WHERE key='motd'").Scan(&motd); err == nil {
		h.settingsMotd = motd
	}
	h.settingsLastUpdate = time.Now()
}

// SetLiveKit sets the LiveKit client on the hub. Must be called before Run.
func (h *Hub) SetLiveKit(lk *LiveKitClient) {
	h.livekit = lk
}

// LiveKitHealthCheck probes the LiveKit server for connectivity.
// It tries the SDK client first (ListRooms), and falls back to an HTTP probe
// if a managed process is configured. Returns false with a reason if LiveKit
// is not configured or unreachable.
func (h *Hub) LiveKitHealthCheck() (bool, error) {
	if h.livekit == nil {
		return false, fmt.Errorf("not configured")
	}
	return h.livekit.HealthCheck()
}

// SetLiveKitProcess sets the LiveKit process manager on the hub.
func (h *Hub) SetLiveKitProcess(p *LiveKitProcess) {
	h.lkProcess = p
}

// Run starts the hub's dispatch loop. It blocks until Stop is called.
// Must be called in its own goroutine.
//
// A panic recovery wrapper restarts the select loop automatically. If the hub
// panics more than 3 times within a 60-second window it stops permanently to
// avoid a tight crash loop.
func (h *Hub) Run() {
	var panicCount int
	var lastPanicReset time.Time

	for {
		func() {
			staleTicker := time.NewTicker(30 * time.Second)
			defer staleTicker.Stop()

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
						return
					}
				}
			}()

			for {
				select {
				case <-h.stop:
					return
				case c := <-h.register:
					h.mu.Lock()
					if old, exists := h.clients[c.userID]; exists {
						// Kick the stale connection atomically before registering
						// the new one — prevents TOCTOU races on duplicate login.
						slog.Warn("hub: kicking stale connection for re-registering user",
							"user_id", c.userID)
						old.closeSend()
					}
					h.clients[c.userID] = c
					slog.Info("hub: client registered", "user_id", c.userID, "total_clients", len(h.clients))
					h.mu.Unlock()
				case c := <-h.unregister:
					h.mu.Lock()
					if current, ok := h.clients[c.userID]; ok && current == c {
						delete(h.clients, c.userID)
						slog.Info("hub: client unregistered", "user_id", c.userID, "total_clients", len(h.clients))
					}
					h.mu.Unlock()
				case bm := <-h.broadcast:
					h.deliverBroadcast(bm)
				case <-staleTicker.C:
					h.sweepStaleClients()
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
func (h *Hub) GracefulStop() {
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
		_ = h.db.LeaveVoiceChannel(vs.UserID)

		// Clear client voice state.
		h.mu.RLock()
		if client, ok := h.clients[vs.UserID]; ok {
			client.clearVoiceChID()
		}
		h.mu.RUnlock()

		// Remove from LiveKit (best-effort).
		if h.livekit != nil {
			_ = h.livekit.RemoveParticipant(channelID, vs.UserID)
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
	h.register <- c
}

// Unregister queues a client for removal from the hub.
func (h *Hub) Unregister(c *Client) {
	h.unregister <- c
}

// BroadcastToChannel enqueues msg for delivery to all clients subscribed to
// channelID. When channelID is 0 the message is sent to every connected client.
// Non-blocking: if the broadcast channel is full the message is dropped with a warning.
func (h *Hub) BroadcastToChannel(channelID int64, msg []byte) {
	select {
	case h.broadcast <- broadcastMsg{channelID: channelID, msg: msg}:
	default:
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

// BroadcastMemberBan sends a member_ban message to all connected clients.
func (h *Hub) BroadcastMemberBan(userID int64) {
	h.BroadcastToAll(buildMemberBan(userID))
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

// ClientCount returns the number of currently registered clients (test helper).
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
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

// deliverBroadcast stamps bm.msg with a monotonic sequence number, stores it
// in the replay buffer, and sends it to the appropriate clients.
func (h *Hub) deliverBroadcast(bm broadcastMsg) {
	seq := h.nextSeq()
	msg := wrapWithSeq(bm.msg, seq)

	// Store in replay buffer for reconnection recovery.
	h.replayBuf.Push(seq, msg)

	h.mu.RLock()
	defer h.mu.RUnlock()

	delivered := 0
	skipped := 0
	for _, c := range h.clients {
		// channelID == 0 → broadcast to everyone.
		if bm.channelID != 0 && c.getChannelID() != bm.channelID && c.getVoiceChID() != bm.channelID {
			skipped++
			continue
		}
		c.sendMsg(msg)
		delivered++
	}
	if bm.channelID != 0 {
		slog.Debug("hub: channel broadcast",
			"channel_id", bm.channelID, "delivered", delivered, "skipped", skipped, "seq", seq)
	}
}
