package ws

import (
	"sync"

	"github.com/pion/webrtc/v4"

	"github.com/owncord/server/db"
)

const sendBufSize = 256

// SessionCheckInterval is the number of messages processed between periodic
// session-expiry checks in readPump. Exported so tests can trigger the check
// without waiting for a real ticker.
const SessionCheckInterval = 10

// Client represents a single authenticated WebSocket connection.
// The underlying transport (conn) is set by ServeWS; in tests it remains nil.
type Client struct {
	hub        *Hub
	conn       wsConn   // interface — nil in unit tests
	userID     int64
	user       *db.User
	channelID  int64  // currently viewed channel for channel-scoped broadcasts
	voiceChID  int64  // voice channel the user is in (0 = not in voice); guarded by voiceMu
	pc         *webrtc.PeerConnection // SFU peer connection; nil when not in voice; guarded by voiceMu
	roleName   string // cached role name for chat_message broadcasts
	tokenHash  string // SHA-256 hex of the session token; used for periodic revalidation
	msgCount   int    // count of messages processed; resets after session check
	sendClosed bool   // true after the send channel has been closed
	send       chan []byte
	mu         sync.Mutex // guards sendClosed, msgCount, channelID
	voiceMu    sync.Mutex // guards voiceChID and pc
}

// wsConn is the subset of nhooyr.io/websocket.Conn used by writePump/readPump.
// Defining it as an interface lets us avoid importing nhooyr.io/websocket here,
// keeping the core hub logic free from that dependency during unit tests.
type wsConn interface {
	// intentionally empty — methods used only in serve.go/client_pump.go
}

// newClient creates a real client wrapping a WebSocket connection (set by serve.go).
func newClient(hub *Hub, conn wsConn, user *db.User, tokenHash string) *Client {
	return &Client{
		hub:       hub,
		conn:      conn,
		userID:    user.ID,
		user:      user,
		tokenHash: tokenHash,
		send:      make(chan []byte, sendBufSize),
	}
}

// GetTokenHash returns the session token hash stored on this client.
// Exported for tests.
func (c *Client) GetTokenHash() string {
	return c.tokenHash
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

// SetClientVoiceChID sets the voiceChID field on a client. For test use only.
func SetClientVoiceChID(c *Client, channelID int64) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	c.voiceChID = channelID
}

// NewTestClientWithTokenHash creates a test client that carries a session token
// hash. Use this when tests need to exercise the periodic session-expiry check.
func NewTestClientWithTokenHash(hub *Hub, user *db.User, tokenHash string, channelID int64, send chan []byte) *Client {
	return &Client{
		hub:       hub,
		userID:    user.ID,
		user:      user,
		tokenHash: tokenHash,
		channelID: channelID,
		send:      send,
	}
}

// getVoiceChID returns the voice channel ID under voiceMu.
func (c *Client) getVoiceChID() int64 {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.voiceChID
}

// getPC returns the PeerConnection under voiceMu.
func (c *Client) getPC() *webrtc.PeerConnection {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.pc
}

// setVoice sets the voice channel and PeerConnection atomically.
func (c *Client) setVoice(chID int64, pc *webrtc.PeerConnection) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	c.voiceChID = chID
	c.pc = pc
}

// clearVoice clears voice state and returns the old values for cleanup.
// The caller is responsible for closing the returned PeerConnection.
func (c *Client) clearVoice() (oldChID int64, oldPC *webrtc.PeerConnection) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	oldChID = c.voiceChID
	oldPC = c.pc
	c.voiceChID = 0
	c.pc = nil
	return
}

// sendMsg queues a message to this client's send buffer without blocking.
// It is a no-op if the send channel has already been closed.
func (c *Client) sendMsg(msg []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sendClosed {
		return
	}
	select {
	case c.send <- msg:
	default:
		// Buffer full — drop rather than block the hub.
	}
}

// closeSend marks the send channel closed and closes it exactly once.
// Safe to call from any goroutine.
func (c *Client) closeSend() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.sendClosed {
		c.sendClosed = true
		close(c.send)
	}
}
