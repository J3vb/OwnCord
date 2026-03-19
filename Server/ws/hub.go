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
	sfu          *SFU
	voiceRooms   map[int64]*VoiceRoom
	voiceRoomsMu sync.RWMutex

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
		voiceRooms:   make(map[int64]*VoiceRoom),
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

// SetSFU sets the SFU engine on the hub. Must be called before Run.
func (h *Hub) SetSFU(sfu *SFU) {
	h.sfu = sfu
}

// GetOrCreateVoiceRoom returns the existing room for channelID or creates one.
// cfg provides the room config (from channel settings and server defaults).
func (h *Hub) GetOrCreateVoiceRoom(channelID int64, cfg VoiceRoomConfig) *VoiceRoom {
	h.voiceRoomsMu.Lock()
	defer h.voiceRoomsMu.Unlock()

	if room, ok := h.voiceRooms[channelID]; ok {
		return room
	}
	room := NewVoiceRoom(cfg)
	h.voiceRooms[channelID] = room
	return room
}

// GetVoiceRoom returns the room for channelID, or nil if none exists.
func (h *Hub) GetVoiceRoom(channelID int64) *VoiceRoom {
	h.voiceRoomsMu.RLock()
	defer h.voiceRoomsMu.RUnlock()
	return h.voiceRooms[channelID]
}

// RemoveVoiceRoom removes and closes the room for channelID. No-op if absent.
func (h *Hub) RemoveVoiceRoom(channelID int64) {
	h.voiceRoomsMu.Lock()
	room, ok := h.voiceRooms[channelID]
	if ok {
		delete(h.voiceRooms, channelID)
	}
	h.voiceRoomsMu.Unlock()

	if ok {
		room.Close()
	}
}

// CloseAllVoiceRooms closes all voice rooms. Called during shutdown.
func (h *Hub) CloseAllVoiceRooms() {
	h.voiceRoomsMu.Lock()
	rooms := make([]*VoiceRoom, 0, len(h.voiceRooms))
	for _, room := range h.voiceRooms {
		rooms = append(rooms, room)
	}
	h.voiceRooms = make(map[int64]*VoiceRoom)
	h.voiceRoomsMu.Unlock()

	for _, room := range rooms {
		room.Close()
	}
}

// Run starts the hub's dispatch loop. It blocks until Stop is called.
// Must be called in its own goroutine.
func (h *Hub) Run() {
	go h.runSpeakerBroadcast(h.stop)

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

// GracefulStop closes all PeerConnections, voice rooms, and then stops the hub.
func (h *Hub) GracefulStop() {
	// Close all client PeerConnections first (CRIT-2 fix).
	h.mu.RLock()
	for _, c := range h.clients {
		if _, oldPC := c.clearVoice(); oldPC != nil {
			_ = oldPC.Close()
		}
	}
	h.mu.RUnlock()

	h.CloseAllVoiceRooms()
	h.stopOnce.Do(func() { close(h.stop) })
}

// CleanupVoiceForChannel removes the voice room for the given channel and
// closes PeerConnections for all participants. Called when a channel is deleted.
func (h *Hub) CleanupVoiceForChannel(channelID int64) {
	room := h.GetVoiceRoom(channelID)
	if room == nil {
		return
	}

	// Get participant IDs before removing the room.
	participantIDs := room.ParticipantIDs()

	// Remove the room (this also calls room.Close() which clears participants).
	h.RemoveVoiceRoom(channelID)

	// Close PeerConnections and clean up DB state for all participants.
	// Use RLock for client map read; voice fields are guarded by voiceMu (HIGH-3 fix).
	h.mu.RLock()
	for _, userID := range participantIDs {
		if client, ok := h.clients[userID]; ok {
			if _, oldPC := client.clearVoice(); oldPC != nil {
				_ = oldPC.Close()
			}
		}
		// Clean up DB voice state (best-effort; ignore error).
		_ = h.db.LeaveVoiceChannel(userID)
	}
	h.mu.RUnlock()

	// Broadcast voice_leave for each participant.
	for _, userID := range participantIDs {
		h.BroadcastToAll(buildVoiceLeave(channelID, userID))
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
