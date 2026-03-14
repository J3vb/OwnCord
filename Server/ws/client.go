package ws

import (
	"sync"

	"github.com/owncord/server/db"
)

const sendBufSize = 256

// Client represents a single authenticated WebSocket connection.
// The underlying transport (conn) is set by ServeWS; in tests it remains nil.
type Client struct {
	hub       *Hub
	conn      wsConn   // interface — nil in unit tests
	userID    int64
	user      *db.User
	channelID int64 // currently viewed channel for channel-scoped broadcasts
	send      chan []byte
	mu        sync.Mutex
}

// wsConn is the subset of nhooyr.io/websocket.Conn used by writePump/readPump.
// Defining it as an interface lets us avoid importing nhooyr.io/websocket here,
// keeping the core hub logic free from that dependency during unit tests.
type wsConn interface {
	// intentionally empty — methods used only in serve.go/client_pump.go
}

// newClient creates a real client wrapping a WebSocket connection (set by serve.go).
func newClient(hub *Hub, conn wsConn, user *db.User) *Client {
	return &Client{
		hub:    hub,
		conn:   conn,
		userID: user.ID,
		user:   user,
		send:   make(chan []byte, sendBufSize),
	}
}

// NewTestClient creates a client with a caller-supplied send channel.
// Intended for unit tests only — conn is nil.
func NewTestClient(hub *Hub, userID int64, send chan []byte) *Client {
	return &Client{
		hub:    hub,
		userID: userID,
		send:   send,
	}
}

// NewTestClientWithChannel creates a test client subscribed to a specific channel.
func NewTestClientWithChannel(hub *Hub, userID, channelID int64, send chan []byte) *Client {
	return &Client{
		hub:       hub,
		userID:    userID,
		channelID: channelID,
		send:      send,
	}
}

// NewTestClientWithUser creates a test client with an authenticated user record set.
// Use this when tests need the client to pass permission checks.
func NewTestClientWithUser(hub *Hub, user *db.User, channelID int64, send chan []byte) *Client {
	return &Client{
		hub:       hub,
		userID:    user.ID,
		user:      user,
		channelID: channelID,
		send:      send,
	}
}

// sendMsg queues a message to this client's send buffer without blocking.
func (c *Client) sendMsg(msg []byte) {
	select {
	case c.send <- msg:
	default:
		// Buffer full — drop rather than block the hub.
	}
}
