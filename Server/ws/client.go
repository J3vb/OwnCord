package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

const (
	sendBufSize     = 256 // per-client outbound send-channel capacity (normal priority)
	sendHighBufSize = 64  // high-priority buffer (DMs, mentions)
	sendLowBufSize  = 64  // low-priority buffer (typing, moderation and mention-badge notices)
)

// SessionCheckInterval is the number of messages between periodic session-expiry
// checks in readPump; exported for tests.
const SessionCheckInterval = 10

// Client is a single authenticated WebSocket connection. conn is set by ServeWS and nil in tests.
type Client struct {
	hub       *Hub
	conn      wsConn          // interface — nil in unit tests
	ctx       context.Context // derived from WS upgrade request; cancelled on disconnect
	userID    int64
	user      *db.User
	channelID int64 // currently viewed channel for channel-scoped broadcasts
	// threadID is the second subscription slot (thread_focus), 0 for none.
	// Guarded by mu.
	threadID int64
	// voice is this connection's voice membership (voice_registry.go), guarded by voice.voiceMu.
	voice     voiceSlot
	roleName  string          // cached role name for chat_message broadcasts
	held      *db.MemberRoles // the one held-role read of this handshake (refreshUserSnapshot)
	roleIDs   []int64         // held role ids, top first; set by refreshUserSnapshot before registration
	tokenHash string          // SHA-256 hex of the session token; used for periodic revalidation
	// identityKey is this device's E2EE identity public key from its auth frame.
	// Immutable: set before registerNow publishes the client, so no lock.
	identityKey string
	lastSeq     uint64 // last_seq sent by the client during auth; 0 = fresh connection (e.g. F5 reload)
	// regGen is the hub connection generation this registration produced; guarded by hub.mu.
	regGen uint64
	// resumeReadable is the channel set this connection's replay was filtered by, nil
	// unless it registered through a replaying resume. Set under hub.seqMu before
	// registration and never changed, so sendToLateResumes can hand it a frame whose
	// audience was resolved earlier by the rule its replay used. Read under seqMu.
	resumeReadable map[int64]bool
	// authChannelID is the channel the client says it had open at disconnect (0 =
	// none). It covers a resume where the old socket was already gone, so there is no
	// subscription to copy until channel_focus completes and broadcasts in that window
	// are unrecoverable (the client reports only max(seq)). UNTRUSTED:
	// handleReconnect and handleFreshConnect promote it to channelID only after
	// checking it against the freshly computed allowed-channel set.
	authChannelID int64
	// features is what the auth frame declared; set once during the handshake
	// before the client is visible, so no lock.
	features      clientFeatures
	connectedAt   time.Time                     // when the WS connection was established
	remoteAddr    string                        // client IP resolved through trusted_proxies (clientip.Resolve), no port
	msgCount      int                           // count of messages processed; resets after session check
	msgsReceived  int64                         // total messages received over the lifetime of this connection
	msgsSent      int64                         // total messages sent over the lifetime of this connection
	msgsDropped   int64                         // messages dropped due to full send buffer
	invalidCount  int                           // consecutive invalid messages; reset on valid parse
	lastActivity  time.Time                     // last message received from this client; guarded by mu
	lastTouch     time.Time                     // last touchSession write for this socket's session; guarded by mu
	sendClosed    bool                          // true after all send channels have been closed
	terminalKick  bool                          // set by markTerminalKick: the server ended this session for good; guarded by mu
	send          chan []byte                   // normal-priority outbound messages (chat messages, reactions)
	sendHigh      chan []byte                   // high-priority outbound messages (DMs, mentions)
	sendLow       chan []byte                   // low-priority outbound messages (typing, moderation and mention-badge notices) — dropped on overflow
	timeouts      heldTimeouts                  // which member_timeouts list this client holds (member_timeouts_delivery.go)
	presenceStale atomic.Bool                   // a presence frame was dropped; the next presence flush sends a full snapshot
	cseq          cseqState                     // per-socket sequenced-frame count, stamped by the writer (client_cseq.go)
	mu            syncutil.Ranked[lockRankLeaf] // guards sendClosed, msgCount, channelID, lastActivity, msgsReceived, msgsSent, msgsDropped

	// focusMu serialises every channel_focus apply (readPump and the deferred-focus
	// drain) so an older intent never lands after a newer one. Lock order: focusMu
	// before mu. focusSeq, pendingFocus* and focusDrainActive are guarded by mu.
	focusMu           syncutil.Ranked[lockRankSerialiser]
	focusSeq          uint64
	pendingFocusChID  int64
	pendingFocusRead  bool
	pendingFocusReqID string
	pendingFocusSeq   uint64
	focusDrainActive  bool

	// presence is the status this connection last stamped or chose; nil until the
	// connect stamp. Atomic because other goroutines read it.
	presence atomic.Pointer[livePresence]
	// voiceExitAt is when a moderator action last took a call off this connection
	// (unix nanos, 0 = never); SendToVoiceDevice uses it to find the device a
	// voice_moved / voice_disconnected belongs to.
	voiceExitAt atomic.Int64
	// displaced is set when registerNow replaced this connection with a newer one
	// of the same session, which then owns its voice session and presence. Any
	// other removal is not displaced, so its teardown ends its own call instead
	// of waiting for the sweep.
	displaced atomic.Bool
}

// wsConn is the subset of coder/websocket.Conn used by the pumps, an interface so
// unit tests avoid that import.
type wsConn any

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
		sendHigh:     make(chan []byte, sendHighBufSize),
		sendLow:      make(chan []byte, sendLowBufSize),
	}
}

func (c *Client) touch() {
	c.mu.Lock()
	c.lastActivity = time.Now()
	c.msgsReceived++
	c.mu.Unlock()
}

func (c *Client) getLastActivity() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastActivity
}

func (c *Client) getThreadID() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.threadID
}

func (c *Client) getChannelID() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.channelID
}

type livePresence struct {
	status       string
	customStatus *string
	// customStatusExpiresAt is the stored expiry of customStatus ("" when none);
	// CustomStatusExpired clears only a connection still showing the expired status.
	customStatusExpiresAt string
	// idleSince is when status last became "idle" here. Kept across custom-status
	// changes so the AFK sweep measures one unbroken idle stretch; a reconnect
	// re-stamps it.
	idleSince time.Time
	// setAt is when this connection last chose or stamped its status; a user's
	// status is the most recent setter's (mergeLivePresence).
	setAt time.Time
	// activity is the game this connection reports. Memory only and immutable: a
	// change swaps in a new livePresence, so every writer must carry it over.
	activity *gameActivity
	// listening is the song this connection reports; same rules as activity.
	listening *listeningActivity
	// mobile is set only on a merged presence (mergeLivePresence): the shown
	// status comes from a phone-app connection with no equally active desktop. A
	// connection's own value is always false.
	mobile bool
	// selfIdle is whether this connection's own device is idle; carried over when
	// another device's chosen status is stamped, since status alone cannot say.
	selfIdle bool
}

func (p livePresence) noActivity() bool { return p.activity == nil && p.listening == nil }

// afkNow is the clock the idle stamp and AFK sweep read; a var so tests can move
// time.
var afkNow = time.Now

// nextLivePresence is the presence following prev: it keeps activity and
// listening, keeps idleSince while idle, stamps now on entry to idle, and is zero
// for other statuses.
func nextLivePresence(prev *livePresence, status string, customStatus *string, expiresAt string, now time.Time) *livePresence {
	next := &livePresence{status: status, customStatus: customStatus, customStatusExpiresAt: expiresAt, setAt: now, selfIdle: isIdleStatus(status)}
	if prev != nil {
		next.activity = prev.activity
		next.listening = prev.listening
	}
	if !isIdleStatus(status) {
		return next
	}
	next.idleSince = now
	if prev != nil && isIdleStatus(prev.status) && !prev.idleSince.IsZero() {
		next.idleSince = prev.idleSince
	}
	return next
}

func (c *Client) livePresence() livePresence {
	if p := c.presence.Load(); p != nil {
		return *p
	}
	return livePresence{}
}

// setLivePresence records the stamped or chosen presence. A compare-and-swap
// loop, so presence_update and the connect stamp cannot both read the same prev
// and drop each other's idleSince.
func (c *Client) setLivePresence(status string, customStatus *string, expiresAt string) {
	now := afkNow()
	for {
		prev := c.presence.Load()
		if c.presence.CompareAndSwap(prev, nextLivePresence(prev, status, customStatus, expiresAt, now)) {
			return
		}
	}
}

func (c *Client) stampChosenStatus(status string, customStatus *string, expiresAt string) {
	now := afkNow()
	for {
		prev := c.presence.Load()
		next := nextLivePresence(prev, status, customStatus, expiresAt, now)
		if prev != nil {
			next.selfIdle = prev.selfIdle
		}
		if c.presence.CompareAndSwap(prev, next) {
			return
		}
	}
}

// sendMsg queues a normal-priority message; a full buffer disconnects the client
// so it reconnects with replay recovery instead of silently losing messages.
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
		if c.hub != nil { // hub-less clients exist only in unit tests
			c.hub.stats.BPQueueDisconnects.Add(1)
		}
		slog.Warn("ws: client send buffer full, closing connection to force reconnect",
			"user_id", c.userID)
		c.closeAllSendLocked()
	}
}

// sendPresenceMsg queues a presence frame on the normal queue. A full queue does
// not close the client (kicking slow clients in a connect herd only made them
// rejoin): the frame is dropped and the client marked stale, so the next presence
// flush sends a full snapshot and its resume takes the full ready
// (presenceDropped).
func (c *Client) sendPresenceMsg(msg []byte) {
	c.mu.Lock()
	if c.sendClosed {
		c.mu.Unlock()
		return
	}
	select {
	case c.send <- msg:
		c.msgsSent++
		c.mu.Unlock()
		return
	default:
		c.msgsDropped++
	}
	c.mu.Unlock()
	c.presenceStale.Store(true)
	if c.hub != nil {
		c.hub.presenceDropped(c.userID, c.tokenHash)
	}
}

// sendHighMsg queues a high-priority message (DMs, direct mentions), drained
// first by writePump; a full high buffer falls back to normal, and if both are
// full the client is disconnected.
func (c *Client) sendHighMsg(msg []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sendClosed {
		return
	}
	select {
	case c.sendHigh <- msg:
		c.msgsSent++
	default:
		if c.hub != nil {
			c.hub.stats.BPHighFallbacks.Add(1)
		}
		select {
		case c.send <- msg:
			c.msgsSent++
		default:
			c.msgsDropped++
			if c.hub != nil {
				c.hub.stats.BPQueueDisconnects.Add(1)
			}
			slog.Warn("ws: client high+normal buffers full, closing connection",
				"user_id", c.userID)
			c.closeAllSendLocked()
		}
	}
}

// sendLowMsg queues a low-priority ephemeral message (typing, moderation and
// mention-badge notices); a full buffer drops it without disconnecting.
func (c *Client) sendLowMsg(msg []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sendClosed {
		return
	}
	select {
	case c.sendLow <- msg:
		c.msgsSent++
	default:
		c.msgsDropped++
		// No per-drop log (typing/presence bursts would flood it); the aggregate
		// counter is the only trace.
		if c.hub != nil {
			c.hub.stats.BPLowDrops.Add(1)
		}
	}
}

// trySendMsg queues a normal-priority message, returning false if the buffer is
// full or closed; overflow disconnects the client.
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
		if c.hub != nil {
			c.hub.stats.BPQueueDisconnects.Add(1)
		}
		slog.Warn("ws: client send buffer full (trySend), closing connection to force reconnect",
			"user_id", c.userID)
		c.closeAllSendLocked()
		return false
	}
}

func (c *Client) closeSend() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeAllSendLocked()
}

// markTerminalKick records that the server ended c's session for good, so
// teardown ends a voice call instead of parking it.
func (c *Client) markTerminalKick() {
	c.mu.Lock()
	c.terminalKick = true
	c.mu.Unlock()
}

func (c *Client) isTerminallyKicked() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.terminalKick
}

func (c *Client) isSendClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sendClosed
}

// closeAllSendLocked closes all three send channels. Caller must hold c.mu.
func (c *Client) closeAllSendLocked() {
	if !c.sendClosed {
		c.sendClosed = true
		close(c.send)
		if c.sendHigh != c.send {
			close(c.sendHigh)
		}
		if c.sendLow != c.send && c.sendLow != c.sendHigh {
			close(c.sendLow)
		}
	}
}
