// Package ws provides the WebSocket hub and client management for OwnCord.
package ws

import (
	"sync"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// broadcastMsg is an internal message queued for delivery.
type broadcastMsg struct {
	channelID int64  // 0 = send to all connected clients
	senderID  int64  // reserved for future exclude-sender logic
	msg       []byte
}

// Hub manages all active WebSocket clients and routes messages between them.
// All exported methods are safe to call from multiple goroutines.
type Hub struct {
	clients    map[int64]*Client
	mu         sync.RWMutex
	db         *db.DB
	limiter    *auth.RateLimiter
	broadcast  chan broadcastMsg
	register   chan *Client
	unregister chan *Client
	stop       chan struct{}
}

// NewHub creates a Hub ready to be started with Run.
func NewHub(database *db.DB, limiter *auth.RateLimiter) *Hub {
	return &Hub{
		clients:    make(map[int64]*Client),
		db:         database,
		limiter:    limiter,
		broadcast:  make(chan broadcastMsg, 256),
		register:   make(chan *Client, 32),
		unregister: make(chan *Client, 32),
		stop:       make(chan struct{}),
	}
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
			// If an existing client has the same userID, close its send channel
			// so writePump exits cleanly before the new client takes over.
			if old, ok := h.clients[c.userID]; ok && old != c {
				old.closeSend()
			}
			h.clients[c.userID] = c
			h.mu.Unlock()

		case c := <-h.unregister:
			h.mu.Lock()
			if current, ok := h.clients[c.userID]; ok && current == c {
				delete(h.clients, c.userID)
			}
			h.mu.Unlock()

		case bm := <-h.broadcast:
			h.deliverBroadcast(bm)
		}
	}
}

// Stop signals Run to exit.
func (h *Hub) Stop() {
	close(h.stop)
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

	for _, c := range h.clients {
		// channelID == 0 → broadcast to everyone.
		if bm.channelID != 0 && c.channelID != bm.channelID {
			continue
		}
		select {
		case c.send <- bm.msg:
		default:
			// Client's buffer is full; skip to avoid blocking the hub.
		}
	}
}
