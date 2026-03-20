// Package ws provides the WebSocket hub and client management for OwnCord.
package ws

import (
	"log/slog"
	"sync"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
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

	// Settings cache — avoids per-connection DB queries for server_name/motd.
	settingsMu         sync.RWMutex
	settingsName       string
	settingsMotd       string
	settingsLastUpdate time.Time
}

// NewHub creates a Hub ready to be started with Run.
// It also initializes the settings cache from the database.
func NewHub(database *db.DB, limiter *auth.RateLimiter) *Hub {
	h := &Hub{
		clients:      make(map[int64]*Client),
		db:           database,
		limiter:      limiter,
		broadcast:    make(chan broadcastMsg, 256),
		register:     make(chan *Client, 32),
		unregister:   make(chan *Client, 32),
		stop:         make(chan struct{}),
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

// SetLiveKitProcess sets the LiveKit process manager on the hub.
func (h *Hub) SetLiveKitProcess(p *LiveKitProcess) {
	h.lkProcess = p
}

// Run starts the hub's dispatch loop. It blocks until Stop is called.
// Must be called in its own goroutine.
func (h *Hub) Run() {
	for {
		select {
		case <-h.stop:
			return

		case c := <-h.register:
			h.mu.Lock()
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
		}
	}
}

// Stop signals Run to exit. Safe to call multiple times.
func (h *Hub) Stop() {
	h.stopOnce.Do(func() { close(h.stop) })
}

// GracefulStop stops the LiveKit process (if managed) and then stops the hub.
func (h *Hub) GracefulStop() {
	if h.lkProcess != nil {
		h.lkProcess.Stop()
	}
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
func (h *Hub) BroadcastToChannel(channelID int64, msg []byte) {
	h.broadcast <- broadcastMsg{channelID: channelID, msg: msg}
}

// BroadcastToAll enqueues msg for delivery to every connected client.
func (h *Hub) BroadcastToAll(msg []byte) {
	h.broadcast <- broadcastMsg{channelID: 0, msg: msg}
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
	select {
	case c.send <- msg:
		return true
	default:
		// send buffer full — drop rather than block.
		return false
	}
}

// ClientCount returns the number of currently registered clients (test helper).
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
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

// deliverBroadcast sends bm.msg to the appropriate clients.
func (h *Hub) deliverBroadcast(bm broadcastMsg) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	delivered := 0
	skipped := 0
	for _, c := range h.clients {
		// channelID == 0 → broadcast to everyone.
		if bm.channelID != 0 && c.channelID != bm.channelID && c.getVoiceChID() != bm.channelID {
			skipped++
			continue
		}
		select {
		case c.send <- bm.msg:
			delivered++
		default:
			slog.Warn("broadcast dropped: client send buffer full",
				"user_id", c.userID, "channel_id", bm.channelID)
		}
	}
	if bm.channelID != 0 {
		slog.Debug("hub: channel broadcast",
			"channel_id", bm.channelID, "delivered", delivered, "skipped", skipped)
	}
}
