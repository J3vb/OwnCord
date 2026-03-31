package ws

import (
	"context"
	"sync"
	"time"

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
	hub            *Hub
	conn           wsConn          // interface — nil in unit tests
	ctx            context.Context // derived from WS upgrade request; cancelled on disconnect
	userID         int64
	user           *db.User
	channelID      int64     // currently viewed channel for channel-scoped broadcasts
	voiceChID      int64     // voice channel the user is in (0 = not in voice); guarded by voiceMu
	voiceJoinToken string    // opaque join-instance token for the current voice session; guarded by voiceMu
	roleName       string    // cached role name for chat_message broadcasts
	tokenHash      string    // SHA-256 hex of the session token; used for periodic revalidation
	lastSeq        uint64    // last_seq sent by the client during auth; 0 = fresh connection (e.g. F5 reload)
	connectedAt    time.Time // when the WS connection was established
	remoteAddr     string    // client IP:port from the HTTP upgrade request
	msgCount       int       // count of messages processed; resets after session check
	msgsReceived   int64     // total messages received over the lifetime of this connection
	msgsSent       int64     // total messages sent over the lifetime of this connection
	msgsDropped    int64     // messages dropped due to full send buffer
	invalidCount   int       // consecutive invalid messages; reset on valid parse
	lastActivity   time.Time // last message received from this client; guarded by mu
	sendClosed     bool      // true after the send channel has been closed
	send           chan []byte
	mu             sync.Mutex // guards sendClosed, msgCount, channelID, lastActivity, msgsReceived, msgsSent, msgsDropped
	voiceMu        sync.Mutex // guards voiceChID and voiceJoinToken
}

// wsConn is the subset of nhooyr.io/websocket.Conn used by writePump/readPump.
// Defining it as an interface lets us avoid importing nhooyr.io/websocket here,
// keeping the core hub logic free from that dependency during unit tests.
type wsConn interface {
	// intentionally empty — methods used only in serve.go/client_pump.go
}

// newClient creates a real client wrapping a WebSocket connection (set by serve.go).
func newClient(hub *Hub, conn wsConn, user *db.User, tokenHash string, lastSeq uint64, ctx context.Context) *Client {
	now := time.Now()
	return &Client{
		hub:          hub,
		conn:         conn,
		ctx:          ctx,
		userID:       user.ID,
		user:         user,
		tokenHash:    tokenHash,
		lastSeq:      lastSeq,
		connectedAt:  now,
		lastActivity: now,
		send:         make(chan []byte, sendBufSize),
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
		ctx:    context.Background(),
		userID: userID,
		send:   send,
	}
}

// NewTestClientWithChannel creates a test client subscribed to a specific channel.
func NewTestClientWithChannel(hub *Hub, userID, channelID int64, send chan []byte) *Client {
	return &Client{
		hub:       hub,
		ctx:       context.Background(),
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
		ctx:       context.Background(),
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
	if channelID == 0 {
		c.voiceJoinToken = ""
	}
}

// SetClientVoiceStateForTest sets both the voice channel and join token.
// For test use only.
func SetClientVoiceStateForTest(c *Client, channelID int64, joinToken string) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	c.voiceChID = channelID
	c.voiceJoinToken = joinToken
}

// NewTestClientWithTokenHash creates a test client that carries a session token
// hash. Use this when tests need to exercise the periodic session-expiry check.
func NewTestClientWithTokenHash(hub *Hub, user *db.User, tokenHash string, channelID int64, send chan []byte) *Client {
	return &Client{
		hub:       hub,
		ctx:       context.Background(),
		userID:    user.ID,
		user:      user,
		tokenHash: tokenHash,
		channelID: channelID,
		send:      send,
	}
}

// touch updates the last activity timestamp and increments the received counter.
func (c *Client) touch() {
	c.mu.Lock()
	c.lastActivity = time.Now()
	c.msgsReceived++
	c.mu.Unlock()
}

// getLastActivity returns the last activity timestamp under mu.
func (c *Client) getLastActivity() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastActivity
}

// getChannelID returns the currently focused channel ID under mu.
func (c *Client) getChannelID() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.channelID
}

// getVoiceChID returns the voice channel ID under voiceMu.
func (c *Client) getVoiceChID() int64 {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.voiceChID
}

func (c *Client) getVoiceJoinToken() string {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.voiceJoinToken
}

func (c *Client) getVoiceState() (int64, string) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.voiceChID, c.voiceJoinToken
}

// setVoiceChID sets the voice channel ID atomically.
func (c *Client) setVoiceChID(chID int64) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	c.voiceChID = chID
	if chID == 0 {
		c.voiceJoinToken = ""
	}
}

func (c *Client) setVoiceState(chID int64, joinToken string) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	c.voiceChID = chID
	c.voiceJoinToken = joinToken
}

// clearVoiceChID clears the voice channel ID and returns the old value.
func (c *Client) clearVoiceChID() int64 {
	oldChID, _ := c.clearVoiceState()
	return oldChID
}

func (c *Client) clearVoiceState() (int64, string) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	oldChID := c.voiceChID
	oldJoinToken := c.voiceJoinToken
	c.voiceChID = 0
	c.voiceJoinToken = ""
	return oldChID, oldJoinToken
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
		c.msgsSent++
	default:
		c.msgsDropped++
	}
}

// trySendMsg queues a message and returns true if it was accepted, false if
// the buffer is full or the channel is closed.
func (c *Client) trySendMsg(msg []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sendClosed {
		return false
	}
	select {
	case c.send <- msg:
		c.msgsSent++
		return true
	default:
		c.msgsDropped++
		return false
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
